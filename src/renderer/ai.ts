import { useSyncExternalStore } from 'react'

export type Provider = 'chatgpt' | 'opencode-go' | 'openrouter'
export type Job = 'build' | 'check' | 'assist' | 'chat'
export interface JobModel { provider: Provider; model: string; effort?: string }
/** One default model for everything; a job with no model of its own uses it. */
export interface Settings { default: JobModel; jobs: Partial<Record<Job, JobModel>> }

export const PROVIDERS: { id: Provider; name: string }[] = [{ id: 'chatgpt', name: 'ChatGPT' }, { id: 'openrouter', name: 'OpenRouter' }, { id: 'opencode-go', name: 'OpenCode Go' }]
export const providerName = (p: Provider) => PROVIDERS.find(x => x.id === p)?.name || p

export const JOBS: { id: Job; label: string; hint: string }[] = [
  { id: 'build', label: 'Drafting prose', hint: 'Draft from card, rewrites. Worth your best model.' },
  { id: 'check', label: 'Feedback and checks', hint: 'Get feedback, check continuity, find problems' },
  { id: 'assist', label: 'Quick help', hint: 'Fill cards and fields, suggest answers and scenes' },
  { id: 'chat', label: 'Conversations and interviews', hint: 'The assistant panel' },
]

// ---------------- settings and connection state (shared, so every Assist button knows) ----------------

interface AIState { settings: Settings; status: Partial<Record<Provider, boolean>>; known: boolean }
let ai: AIState = { settings: { default: { provider: 'chatgpt', model: '', effort: 'medium' }, jobs: {} }, status: {}, known: false }
const subs = new Set<() => void>()
const setAI = (p: Partial<AIState>) => { ai = { ...ai, ...p }; subs.forEach(f => f()) }
export const useAI = () => useSyncExternalStore(f => (subs.add(f), () => subs.delete(f)), () => ai)
export const getAI = () => ai

const same = (a?: JobModel, b?: JobModel) => !!a && !!b && a.provider === b.provider && a.model === b.model && (a.effort || '') === (b.effort || '')

export async function loadSettings(): Promise<Settings> {
  const s = await (await fetch('/api/settings')).json() as Partial<Settings> & { jobs?: Partial<Record<Job, JobModel>> }
  const jobs: Partial<Record<Job, JobModel>> = { ...(s.jobs || {}) }
  // Older settings had one model per job and no default: the first one chosen becomes the default.
  let def = s.default
  if (!def?.model) def = (['build', 'chat', 'assist', 'check'] as Job[]).map(j => jobs[j]).find(m => m?.model) || ai.settings.default
  for (const j of Object.keys(jobs) as Job[]) if (!jobs[j]?.model || same(jobs[j], def)) delete jobs[j]
  setAI({ settings: { default: def, jobs } })
  return ai.settings
}
export async function saveSettings(s: Settings) {
  setAI({ settings: s })
  await fetch('/api/settings', { method: 'PUT', body: JSON.stringify(s) })
}
export async function refreshStatus() {
  try { setAI({ status: await (await fetch('/api/auth/status')).json(), known: true }) } catch { /* offline: keep what we knew */ }
}
if (typeof window !== 'undefined') {
  loadSettings().catch(() => {}); refreshStatus()
  addEventListener('canon:notify', () => { refreshStatus() }) // a browser sign-in finished
}

/** The model a job uses: its own if it has one and the provider is connected, else the default. */
export function modelFor(job: Job, st: AIState = ai): JobModel {
  const own = st.settings.jobs[job]
  if (own?.model && (!st.known || st.status[own.provider])) return own
  return st.settings.default
}
/** Whether a job's own model can't be used right now, so it falls back to the default. */
export const fallsBack = (job: Job, st: AIState = ai) => { const own = st.settings.jobs[job]; return !!own?.model && st.known && !st.status[own.provider] }
/** Whether the assistant can do anything: a model is chosen and its provider is connected. */
export function aiReady(st: AIState = ai, job: Job = 'assist') {
  const m = modelFor(job, st)
  return !!m.model && (!st.known || !!st.status[m.provider])
}
export const anyConnected = (st: AIState = ai) => Object.values(st.status).some(Boolean)

export interface Turn { role: 'user' | 'assistant'; content: string }

/** Stream a completion. `input` is a prompt or a conversation. Calls onText with the accumulated text. */
export async function complete(job: Job, system: string, input: string | Turn[], onText?: (full: string) => void, signal?: AbortSignal): Promise<string> {
  const m = modelFor(job)
  if (!m?.model) throw new Error(anyConnected() ? 'No model chosen. Pick one in Settings › Assistant.' : 'No assistant connected. Connect one in Settings › Assistant.')
  const r = await fetch('/api/ai', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: m.provider, model: m.model, effort: m.provider === 'chatgpt' ? m.effort : undefined, system,
      ...(typeof input === 'string' ? { prompt: input } : { messages: input }),
    }),
  })
  if (!r.ok || !r.body) throw new Error(await r.text())
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = '', full = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    const lines = buf.split('\n')
    buf = lines.pop()!
    for (const line of lines) {
      if (!line) continue
      const msg = JSON.parse(line)
      if (msg.e) throw new Error(msg.e)
      full += msg.t
      onText?.(full)
    }
  }
  return full
}

/** Pull the first JSON array/object out of a model reply (models like to wrap it in prose or fences). */
export function parseJSON<T>(text: string): T {
  const start = text.search(/[[{]/)
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'))
  if (start < 0 || end < start) throw new Error('The model did not return JSON:\n' + text.slice(0, 400))
  return JSON.parse(text.slice(start, end + 1))
}

export async function completeJSON<T>(job: Job, p: { system: string; prompt: string }, signal?: AbortSignal): Promise<T> {
  return parseJSON<T>(await complete(job, p.system, p.prompt, undefined, signal))
}

export async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}
