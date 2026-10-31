import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './db.ts'
import { createApi, type Host } from './api.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'canon-api-'))
const host = (picked?: string): Host & { saved: { name: string; data: Uint8Array }[] } => {
  const saved: { name: string; data: Uint8Array }[] = []
  return {
    saved, pickFolder: async () => picked, save: async (name, data) => { saved.push({ name, data }); return '/x/' + name },
    pdf: async () => new Uint8Array([37, 80, 68, 70]), reveal: () => {}, openExternal: () => {}, notify: () => {},
  }
}
const req = (method: string, path: string, body?: unknown) =>
  new Request('canon://app' + path, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })

test('records round-trip and undo through the API', async () => {
  const dir = tmp()
  const api = createApi({ store: new Store(join(dir, 'c.db')), dataDir: dir, host: host() })
  assert.equal((await api(req('POST', '/api/records', { group: 'g', label: 'New', changes: [{ id: 'p', kind: 'project', data: { title: 'T' } }] }))).status, 204)
  assert.deepEqual((await (await api(req('GET', '/api/records'))).json()).map((r: { id: string }) => r.id), ['p'])
  assert.deepEqual(await (await api(req('POST', '/api/undo'))).json(), { label: 'New', ids: ['p'] })
  assert.equal((await api(req('POST', '/api/records', '{nope'))).status, 400)
  assert.equal((await api(req('GET', '/api/nothing'))).status, 404)
})

test('the story folder is read-only and confined', async () => {
  const dir = tmp(), root = tmp()
  mkdirSync(join(root, 'characters')); mkdirSync(join(root, '.hidden'))
  writeFileSync(join(root, 'characters', 'kira.txt'), 'Kira')
  writeFileSync(join(root, '.hidden', 'x.md'), 'no')
  writeFileSync(join(dir, 'secret.txt'), 'secret')
  const api = createApi({ store: new Store(join(dir, 'c.db')), dataDir: dir, host: host(root) })
  assert.deepEqual(await (await api(req('GET', '/api/tree'))).json(), [])
  assert.equal((await api(req('GET', '/api/file?path=characters/kira.txt'))).status, 400, 'no folder chosen yet')
  assert.equal((await (await api(req('POST', '/api/root'))).json()).root, root)
  assert.deepEqual(await (await api(req('GET', '/api/tree'))).json(), ['characters/kira.txt'])
  assert.equal(await (await api(req('GET', '/api/file?path=characters/kira.txt'))).text(), 'Kira')
  assert.equal((await api(req('GET', '/api/file?path=../' + dir.split('/').pop() + '/secret.txt'))).status, 400)
  assert.equal((await api(req('GET', '/api/file?path=nope.txt'))).status, 404)
  assert.equal((await api(req('PUT', '/api/file?path=characters/kira.txt', 'x'))).status, 404, 'no write route')
})

test('exports go through the save dialog', async () => {
  const dir = tmp(), h = host()
  const api = createApi({ store: new Store(join(dir, 'c.db')), dataDir: dir, host: h })
  const r = await (await api(req('POST', '/api/export/epub?name=Book.epub', { title: 'B', author: '', chapters: [{ title: 'One', html: '<p>x</p>' }] }))).json()
  assert.equal(r.path, '/x/Book.epub')
  assert.equal(Buffer.from(h.saved[0].data.subarray(30, 38)).toString(), 'mimetype')
  await api(req('POST', '/api/save?name=a.md', '# A'))
  assert.equal(new TextDecoder().decode(h.saved[1].data), '# A')
})

test('AI streams NDJSON deltas and reports upstream errors', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ openrouter: { key: 'k' } }))
  let sent: { url: string; body: { messages: unknown[] } } | undefined
  const sse = (lines: string[]) => new Response(lines.map(l => `data: ${l}\n\n`).join(''), { status: 200 })
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent = { url, body: JSON.parse(String(init.body)) }
    if (sent.body.messages.length > 2) return new Response('{"error":{"message":"too long"}}', { status: 400, statusText: 'Bad Request' })
    return sse([JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }), JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }), '[DONE]'])
  }) as typeof fetch
  const api = createApi({ store: new Store(join(dir, 'c.db')), dataDir: dir, host: host(), fetchImpl })
  const lines = async (r: Response) => (await r.text()).trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(await lines(await api(req('POST', '/api/ai', { provider: 'openrouter', model: 'm', system: 'S', prompt: 'Hi' }))), [{ t: 'Hel' }, { t: 'lo' }])
  assert.equal(sent!.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.deepEqual(sent!.body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'Hi' }])
  const err = await lines(await api(req('POST', '/api/ai', { provider: 'openrouter', model: 'm', system: 'S', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] })))
  assert.match(err[0].e, /400.*too long/)
  const nokey = await lines(await api(req('POST', '/api/ai', { provider: 'opencode-go', model: 'm', prompt: 'x' })))
  assert.match(nokey[0].e, /No key/)
})
