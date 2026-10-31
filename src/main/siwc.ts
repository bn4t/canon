// Official "Sign in with ChatGPT" for open-source/local apps (developers.openai.com/siwc).
// Canon registers itself as a user-defined agent and requests plan usage only:
// the token can make eligible Responses API requests on the user's plan and does not
// grant access to ChatGPT conversations or other account context.
import { createPublicKey, verify, randomUUID, type JsonWebKeyInput } from 'node:crypto'
import type { Server } from 'node:http'
import { AuthStore, pkce, oneShotCallback, page, htmlEscape, type Cred } from './auth.ts'
import { randToken } from './files.ts'

export const SIWC = {
  issuer: 'https://auth.openai.com',
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  resource: 'https://api.openai.com/v1',
  redirect: 'http://127.0.0.1:1455/auth/callback', // docs: loopback IP, not "localhost"
  scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  planScope: 'chatgpt.tokens.use.direct',
  regKey: 'chatgpt-registration',
}

export const hasScope = (scopes: string | undefined, want: string) => (scopes || '').split(/\s+/).includes(want)

interface Tokens { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string }
const credOf = (t: Tokens, prevRefresh = ''): Cred => ({
  access: t.access_token, refresh: t.refresh_token || prevRefresh, scope: t.scope,
  expires: Math.floor(Date.now() / 1000) + (t.expires_in || 3600),
})

async function tokenRequest(form: Record<string, string>): Promise<Tokens> {
  const r = await fetch(SIWC.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })
  if (!r.ok) {
    const e = await r.json().catch(() => ({})) as { error?: string; error_description?: string }
    throw new Error(`token endpoint ${r.status}: ${e.error || ''} ${e.error_description || ''}`.trim())
  }
  return r.json() as Promise<Tokens>
}

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: ${r.status}`)
  return r.json() as Promise<T>
}

export class ChatGPT {
  private server?: Server
  private pending = new Map<string, { verifier: string; nonce: string; clientId: string }>()
  private refreshing?: Promise<Cred> // refresh tokens rotate; never refresh concurrently
  private auth: AuthStore
  private onDone: () => void
  constructor(auth: AuthStore, onDone: () => void = () => {}) { this.auth = auth; this.onDone = onDone }

  /** Open the one-shot callback listener on 127.0.0.1:1455 and return the authorize URL. */
  async start(): Promise<string> {
    const reg = this.auth.get(SIWC.regKey) || {}
    if (!reg.hostId) { reg.hostId = 'urn:uuid:' + randomUUID(); this.auth.set(SIWC.regKey, reg) } // stable per install
    const clientId = reg.clientId || 'dynamic_agent_client' // first-time registration entrypoint
    const { verifier, challenge } = pkce()
    const state = randToken(), nonce = randToken()
    this.pending.set(state, { verifier, nonce, clientId })
    if (!this.server?.listening) {
      try {
        this.server = (await oneShotCallback(1455, '/auth/callback', q => this.callback(q))).server
      } catch (e) {
        throw new Error('Port 1455 is busy (is another ChatGPT sign-in running, e.g. Codex?): ' + String(e))
      }
    }
    const q = new URLSearchParams({
      client_id: clientId, ext_agent_host_id: reg.hostId, response_type: 'code', redirect_uri: SIWC.redirect, scope: SIWC.scope,
      resource: SIWC.resource, state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
    })
    if (!reg.clientId) q.set('agent_name_hint', 'Canon')
    return SIWC.authorize + '?' + q
  }

  private async callback(q: URLSearchParams) {
    const p = this.pending.get(q.get('state') || '')
    this.pending.delete(q.get('state') || '')
    const fail = (status: number, msg: string) => ({ status, html: page(msg), done: false })
    if (!p) return fail(400, 'Sign-in failed: this request is unknown or expired. Start again from Canon.')
    if (q.get('error')) return fail(200, `Sign-in was cancelled (${htmlEscape(q.get('error')!)}). You can close this tab.`)
    const code = q.get('code')
    if (!code) return fail(400, 'Sign-in failed: no authorization code. Start again from Canon.')
    let clientId = p.clientId
    if (clientId === 'dynamic_agent_client') {
      clientId = q.get('client_id') || ''
      if (!clientId) return fail(502, 'Sign-in failed: OpenAI did not return a client ID for Canon.')
      this.auth.set(SIWC.regKey, { ...this.auth.get(SIWC.regKey), clientId }) // keep the registration even if the exchange fails
    }
    try {
      const tok = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: p.verifier, redirect_uri: SIWC.redirect, resource: SIWC.resource })
      const jwks = await getJSON<{ keys: Jwk[] }>(SIWC.issuer + '/.well-known/jwks.json')
      verifyIDToken(jwks.keys, tok.id_token || '', clientId, p.nonce)
      if (!hasScope(tok.scope, SIWC.planScope)) throw new Error('ChatGPT plan usage was not granted. Plan usage needs ChatGPT Plus or Pro and approval on the consent screen')
      this.auth.set('chatgpt', credOf(tok))
    } catch (e) {
      return { status: 502, html: page('Sign-in failed: ' + htmlEscape(String(e instanceof Error ? e.message : e))), done: false }
    }
    this.onDone()
    return {
      status: 200, done: true,
      html: page(`<b>You're using your ChatGPT plan in Canon.</b><p>Canon can make model requests on your plan. It can't see your ChatGPT conversations or account. Usage counts toward your plan's limits; set a cap for Canon at <a href="https://chatgpt.com/settings/usage">ChatGPT Settings → Usage</a>.</p><p>You can close this tab and return to Canon.</p>`),
    }
  }

  /** A fresh credential, refreshing when near expiry or when forced. */
  cred(force = false): Promise<Cred> {
    if (this.refreshing) return this.refreshing
    const c = this.auth.get('chatgpt')
    if (!c) return Promise.reject(new Error('Not signed in to ChatGPT (Settings → AI → Sign in with ChatGPT)'))
    if (!hasScope(c.scope, SIWC.planScope)) return Promise.reject(new Error('ChatGPT plan usage was not granted; sign in again and approve it'))
    if (!force && (c.expires || 0) > Date.now() / 1000 + 60) return Promise.resolve(c)
    this.refreshing = (async () => {
      try {
        const t = await tokenRequest({ grant_type: 'refresh_token', client_id: this.auth.get(SIWC.regKey)?.clientId || '', refresh_token: c.refresh || '', resource: SIWC.resource })
        const n = credOf(t, c.refresh)
        n.scope ||= c.scope
        this.auth.set('chatgpt', n)
        return n
      } catch (e) {
        this.auth.set('chatgpt', null) // docs: on refresh failure, clear tokens and sign in again
        throw new Error('ChatGPT session ended, sign in again: ' + String(e instanceof Error ? e.message : e))
      } finally {
        this.refreshing = undefined
      }
    })()
    return this.refreshing
  }

  /** Revoke the refresh token (best effort). The app registration itself stays. */
  async revoke() {
    const c = this.auth.get('chatgpt')
    if (!c?.refresh) return
    try {
      const disc = await getJSON<{ revocation_endpoint?: string }>(SIWC.issuer + '/.well-known/openid-configuration')
      if (disc.revocation_endpoint) await fetch(disc.revocation_endpoint, { method: 'POST', body: new URLSearchParams({ token: c.refresh, token_type_hint: 'refresh_token', client_id: this.auth.get(SIWC.regKey)?.clientId || '' }) })
    } catch { /* best effort */ }
  }
}

export interface Jwk { kid: string; kty: string; n?: string; e?: string; crv?: string; x?: string; y?: string }

/** Check signature (against the given JWKS), issuer, audience, expiry and nonce. Throws on failure. */
export function verifyIDToken(keys: Jwk[], tok: string, clientId: string, nonce: string) {
  const parts = tok.split('.')
  if (parts.length !== 3) throw new Error('malformed ID token')
  const seg = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
  const hdr = seg(parts[0]) as { alg?: string; kid?: string }
  const k = keys.find(x => x.kid === hdr.kid)
  if (!k) throw new Error('ID token signed with an unknown key')
  const data = Buffer.from(parts[0] + '.' + parts[1]), sig = Buffer.from(parts[2], 'base64url')
  let ok: boolean
  try {
    const key = createPublicKey({ key: k, format: 'jwk' } as unknown as JsonWebKeyInput)
    if (hdr.alg === 'RS256' && k.kty === 'RSA') ok = verify('sha256', data, key, sig)
    else if (hdr.alg === 'ES256' && k.kty === 'EC' && k.crv === 'P-256') ok = sig.length === 64 && verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)
    else throw new Error(`unsupported ID token algorithm "${hdr.alg}"`)
  } catch (e) {
    if (String(e).includes('unsupported')) throw e
    throw new Error('bad key or signature in ID token')
  }
  if (!ok) throw new Error('ID token signature is invalid')
  const c = seg(parts[1]) as { iss?: string; aud?: string | string[]; exp?: number; nonce?: string }
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud]
  if (c.iss !== SIWC.issuer) throw new Error('ID token issuer mismatch')
  if (!auds.includes(clientId)) throw new Error('ID token audience mismatch')
  if (Date.now() / 1000 - 5 > (c.exp || 0)) throw new Error('ID token expired')
  if (c.nonce !== nonce) throw new Error('ID token nonce mismatch')
}

/** SIWC plan-usage error codes, explained. */
export function explainPlanError(code = '', msg = '') {
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded': return "Canon's ChatGPT plan usage limit is reached. Raise or reset it at https://chatgpt.com/settings/usage"
    case 'subscription_sharing_user_not_eligible': return "this ChatGPT account isn't eligible for plan usage in apps (needs Plus or Pro)"
    case 'subscription_sharing_usage_unavailable': case 'subscription_sharing_user_unavailable': return 'ChatGPT plan usage is temporarily unavailable; try again shortly'
    case 'subscription_sharing_unsupported_capability': case 'subscription_sharing_route_not_supported': return 'not supported with ChatGPT plan usage: ' + msg
  }
  return code ? `${code}: ${msg}` : msg
}
