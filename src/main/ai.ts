// AI calls: the renderer posts a request, we stream text deltas back as NDJSON lines {"t": "..."} or {"e": "error"}.
import { AuthStore } from './auth.ts'
import { ChatGPT, SIWC, explainPlanError } from './siwc.ts'

const BASE = { 'opencode-go': 'https://opencode.ai/zen/go/v1', openrouter: 'https://openrouter.ai/api/v1' } as const

export interface Turn { role: 'user' | 'assistant'; content: string }
export interface AIRequest {
  provider: string; model: string; system?: string; prompt?: string
  /** ChatGPT reasoning effort */
  effort?: string
  /** A multi-turn conversation used instead of prompt. */
  messages?: Turn[]
}
const turns = (r: AIRequest): Turn[] => (r.messages?.length ? r.messages : [{ role: 'user', content: r.prompt || '' }])

export class AI {
  private auth: AuthStore
  private chatgpt: ChatGPT
  private fetchImpl: typeof fetch
  constructor(auth: AuthStore, chatgpt: ChatGPT, fetchImpl: typeof fetch = fetch) { this.auth = auth; this.chatgpt = chatgpt; this.fetchImpl = fetchImpl }

  private async upstream(req: AIRequest, signal: AbortSignal, force = false): Promise<Response> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
    let url: string, body: unknown
    if (req.provider === 'chatgpt') {
      const c = await this.chatgpt.cred(force)
      url = SIWC.resource + '/responses'
      h.Authorization = 'Bearer ' + c.access
      // SIWC requires store:false + stream:true; system-role input items are rejected, so use instructions.
      body = {
        model: req.model, instructions: req.system || '', stream: true, store: false,
        input: turns(req).map(t => ({ type: 'message', role: t.role, content: [{ type: t.role === 'assistant' ? 'output_text' : 'input_text', text: t.content }] })),
        ...(req.effort ? { reasoning: { effort: req.effort } } : {}),
      }
    } else if (req.provider === 'opencode-go' || req.provider === 'openrouter') {
      const c = this.auth.get(req.provider)
      if (!c?.key) throw new Error(`No key for ${req.provider} (Settings → AI)`)
      url = BASE[req.provider] + '/chat/completions'
      if (req.provider === 'openrouter') h['X-Title'] = 'Canon'
      h.Authorization = 'Bearer ' + c.key
      body = { model: req.model, stream: true, messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...turns(req)] }
    } else throw new Error(`unknown provider "${req.provider}"`)
    return this.fetchImpl(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal })
  }

  /** Start a completion; the returned stream ends with the reply. Cancelling the stream aborts the upstream request. */
  stream(req: AIRequest): ReadableStream<Uint8Array> {
    const ctl = new AbortController()
    const enc = new TextEncoder()
    return new ReadableStream({
      start: async out => {
        const line = (o: object) => { try { out.enqueue(enc.encode(JSON.stringify(o) + '\n')) } catch { /* cancelled */ } }
        try {
          let r = await this.upstream(req, ctl.signal)
          if (r.status === 401 && req.provider === 'chatgpt') { await r.body?.cancel(); r = await this.upstream(req, ctl.signal, true) } // refresh once and retry
          if (!r.ok) {
            const t = (await r.text()).slice(0, 4096).trim()
            let msg = t
            try { const e = JSON.parse(t).error; if (e) msg = explainPlanError(e.code, e.message) } catch { /* not JSON */ }
            throw new Error(`${r.status} ${r.statusText}: ${msg}`)
          }
          await readSSE(r.body!, req.provider === 'chatgpt', t => line({ t }))
        } catch (e) {
          if (!ctl.signal.aborted) line({ e: e instanceof Error ? e.message : String(e) })
        }
        try { out.close() } catch { /* cancelled */ }
      },
      cancel: () => ctl.abort(),
    })
  }

  /** Model ids for a provider, for the picker. */
  async models(provider: string): Promise<string[]> {
    let url: string
    const h: Record<string, string> = {}
    if (provider === 'chatgpt') {
      h.Authorization = 'Bearer ' + (await this.chatgpt.cred()).access
      url = SIWC.resource + '/models'
    } else if (provider === 'opencode-go' || provider === 'openrouter') {
      url = BASE[provider] + '/models'
      const k = this.auth.get(provider)?.key
      if (k) h.Authorization = 'Bearer ' + k
    } else throw new Error('unknown provider')
    const r = await this.fetchImpl(url, { headers: h })
    if (!r.ok) throw new Error('model list: ' + r.status)
    // ChatGPT plan: {models:[{slug, visibility}]}, keep visibility=="list"; OpenAI-compatible: {data:[{id}]}
    const out = await r.json() as { models?: { slug: string; visibility: string }[]; data?: { id: string }[] }
    return [...(out.models || []).filter(m => m.visibility === 'list').map(m => m.slug), ...(out.data || []).map(m => m.id)]
  }
}

/** Parse Responses-API events or Chat Completions chunks and emit text deltas. */
export async function readSSE(body: ReadableStream<Uint8Array>, responses: boolean, emit: (t: string) => void) {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    const lines = buf.split('\n')
    buf = lines.pop()!
    for (const raw of lines) {
      if (!raw.startsWith('data:')) continue
      const data = raw.slice(5).trim()
      if (data === '[DONE]') return
      let ev: any // eslint-disable-line @typescript-eslint/no-explicit-any
      try { ev = JSON.parse(data) } catch { continue }
      if (responses) {
        switch (ev.type) {
          case 'response.output_text.delta': emit(ev.delta); break
          case 'response.completed': await reader.cancel(); return
          case 'response.failed': case 'error': throw new Error('model error: ' + (ev.response?.error ? explainPlanError(ev.response.error.code, ev.response.error.message) : ev.message))
          case 'response.incomplete': throw new Error(`the model stopped early (${ev.response?.incomplete_details?.reason || 'unknown reason'})`)
        }
        continue
      }
      if (ev.error) throw new Error('model error: ' + ev.error.message)
      const t = ev.choices?.[0]?.delta?.content
      if (t) emit(t)
    }
  }
}
