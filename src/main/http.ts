// Small helpers shared by the API modules (api.ts and the feature modules it merges routes from).
import { BadRequest } from './db.ts'

export { BadRequest }
export type Handler = (r: Request, u: URL) => Promise<Response> | Response
/** "METHOD /api/path" → handler. Query strings are not part of the key. */
export type Routes = Record<string, Handler>

export const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
export const text = (t: string, status: number) => new Response(t, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
export const none = () => new Response(null, { status: 204 })
export const body = async <T>(r: Request, limit = 64 << 20): Promise<T> => {
  const t = await r.text()
  if (t.length > limit) throw new BadRequest('request too large')
  try { return JSON.parse(t) } catch { throw new BadRequest('invalid json') }
}
/** The raw request body, with a size limit. */
export const bytes = async (r: Request, limit = 512 << 20): Promise<Uint8Array> => {
  const b = new Uint8Array(await r.arrayBuffer())
  if (b.length > limit) throw new BadRequest('file too large')
  return b
}
