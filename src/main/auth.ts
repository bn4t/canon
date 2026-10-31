// Credentials for AI providers, kept in auth.json next to the database (mode 600).
// API-key providers store a key; ChatGPT stores OAuth tokens plus its app registration.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { writeAtomic, randToken } from './files.ts'

export interface Cred {
  access?: string
  refresh?: string
  /** unix seconds */
  expires?: number
  scope?: string
  /** API-key providers */
  key?: string
  /** ChatGPT registration (kept across sign-outs so re-auth reuses the same app identity) */
  clientId?: string
  hostId?: string
}
export const PROVIDERS = ['chatgpt', 'opencode-go', 'openrouter'] as const
export type Provider = typeof PROVIDERS[number]

export class AuthStore {
  private m: Record<string, Cred> = {}
  readonly path: string
  constructor(path: string) {
    this.path = path
    try { this.m = JSON.parse(readFileSync(path, 'utf8')) } catch { /* first run */ }
  }
  get(p: string): Cred | undefined { return this.m[p] }
  set(p: string, c: Cred | null) {
    if (c) this.m[p] = c
    else delete this.m[p]
    writeAtomic(this.path, JSON.stringify(this.m, null, 2), 0o600)
  }
  status() { return Object.fromEntries(PROVIDERS.map(p => [p, !!this.m[p]])) as Record<Provider, boolean> }
}

export function pkce() {
  const verifier = randToken() + randToken() // 64 chars
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export const page = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>Canon</title><body style="font:16px/1.5 system-ui;padding:48px;max-width:560px;margin:auto;color:#222">${msg}`
export const htmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * A loopback listener for one OAuth redirect. It answers `path` once, then closes;
 * it also closes itself after `ttlMs`. Resolves with the port it listens on.
 */
export function oneShotCallback(port: number, path: string, handle: (q: URLSearchParams) => Promise<{ status: number; html: string; done: boolean }>, ttlMs = 10 * 60_000) {
  return new Promise<{ port: number; server: Server }>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method !== 'GET' || url.pathname !== path) { res.writeHead(404).end(); return }
      try {
        const r = await handle(url.searchParams)
        res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8' }).end(r.html)
        if (r.done) server.close()
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Sign-in failed: ' + htmlEscape(String(e))))
      }
    })
    const timer = setTimeout(() => server.close(), ttlMs)
    server.on('close', () => clearTimeout(timer))
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const a = server.address()
      resolve({ port: typeof a === 'object' && a ? a.port : port, server })
    })
  })
}

// ---------------- OpenRouter: official OAuth PKCE that mints a user-controlled API key ----------------

export async function openrouterStart(auth: AuthStore, onDone: () => void) {
  const { verifier, challenge } = pkce()
  const { port } = await oneShotCallback(0, '/callback', async q => {
    const code = q.get('code')
    if (!code) return { status: 400, html: page('OpenRouter sign-in failed: no code. Start again from Canon.'), done: false }
    const r = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    })
    const out = r.ok ? await r.json() as { key?: string } : {}
    if (!out.key) return { status: 502, html: page('OpenRouter key exchange failed: ' + r.status), done: true }
    auth.set('openrouter', { key: out.key })
    onDone()
    return { status: 200, html: page('<b>OpenRouter is connected.</b><p>You can close this tab and return to Canon.</p>'), done: true }
  })
  const q = new URLSearchParams({ callback_url: `http://127.0.0.1:${port}/callback`, code_challenge: challenge, code_challenge_method: 'S256' })
  return 'https://openrouter.ai/auth?' + q
}
