export type Provider = 'chatgpt' | 'opencode-go' | 'openrouter'
export type Job = 'build' | 'check' | 'assist' | 'chat'
export interface JobModel { provider: Provider; model: string; effort?: string }
export interface Settings { jobs: Record<Job, JobModel> }

export const JOBS: { id: Job; label: string; hint: string }[] = [
  { id: 'build', label: 'Build prose', hint: 'Scene builds and passage rewrites' },
  { id: 'check', label: 'Checks', hint: 'Continuity review and critique' },
  { id: 'assist', label: 'Assist', hint: 'Cards, options, pressure tests, filling gaps' },
  { id: 'chat', label: 'Conversations', hint: 'Character interviews and the assistant' },
]

const fallback: JobModel = { provider: 'chatgpt', model: '', effort: 'medium' }
let settings: Settings = { jobs: { build: fallback, check: fallback, assist: fallback, chat: fallback } }

export async function loadSettings(): Promise<Settings> {
  const s = await (await fetch('/api/settings')).json()
  settings = { jobs: { ...settings.jobs, ...(s.jobs || {}) } }
  if (!s.jobs?.chat && s.jobs?.assist) settings.jobs.chat = s.jobs.assist
  return settings
}
export async function saveSettings(s: Settings) {
  settings = s
  await fetch('/api/settings', { method: 'PUT', body: JSON.stringify(s) })
}
export const modelFor = (job: Job) => settings.jobs[job]

export interface Turn { role: 'user' | 'assistant'; content: string }

/** Stream a completion. `input` is a prompt or a conversation. Calls onText with the accumulated text. */
export async function complete(job: Job, system: string, input: string | Turn[], onText?: (full: string) => void, signal?: AbortSignal): Promise<string> {
  const m = settings.jobs[job]
  if (!m?.model) throw new Error(`No model chosen for "${JOBS.find(j => j.id === job)?.label}". Pick one in Settings.`)
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
