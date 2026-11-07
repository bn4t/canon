import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './db.ts'
import { createApi, type Host } from './api.ts'
import { safeName, validName, readable } from './research.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'canon-research-'))
const host = (picked: string[] = []): Host => ({
  pickFolder: async () => undefined, save: async () => undefined, pdf: async () => new Uint8Array(), print: async () => {},
  pickFiles: async () => picked, trash: async () => {}, reload: () => {}, reveal: () => {}, openExternal: () => {}, notify: () => {},
})
const api = (dir: string, h = host(), fetchImpl?: typeof fetch) => createApi({ store: new Store(join(dir, 'c.db')), dataDir: dir, host: h, fetchImpl })
const req = (method: string, path: string, body?: BodyInit, headers?: Record<string, string>) => new Request('canon://app' + path, { method, body, headers })

test('stored names are unique, safe and keep the extension', () => {
  assert.equal(safeName('Tide tables, 1952.PDF', () => 'abc123'), 'tide-tables-1952-abc123.pdf')
  assert.equal(safeName('Café map.jpeg', () => 'x1'), 'cafe-map-x1.jpeg')
  assert.equal(safeName('../../etc/passwd', () => 'z'), 'passwd-z')
  assert.equal(safeName('.hidden', () => 'z'), 'hidden-z')
  assert.notEqual(safeName('a.png'), safeName('a.png'))
  for (const n of ['tide-abc.pdf', 'file-1']) assert.ok(validName(n), n)
  for (const n of ['../x.pdf', '.x', 'a/b.png', 'A.png', '', 'x.toolongext']) assert.ok(!validName(n), n)
})

test('upload, serve, and Range requests for media', async () => {
  const dir = tmp(), h = api(dir)
  const data = new TextEncoder().encode('0123456789')
  const up = await (await h(req('POST', '/api/research/upload?name=' + encodeURIComponent('Field recording.mp3'), data))).json()
  assert.match(up.file, /^field-recording-[a-z0-9]+\.mp3$/)
  assert.equal(up.size, 10); assert.equal(up.mime, 'audio/mpeg')

  const full = await h(req('GET', '/api/files?name=' + up.file))
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-type'), 'audio/mpeg')
  assert.equal(await full.text(), '0123456789')

  const part = await h(req('GET', '/api/files?name=' + up.file, undefined, { Range: 'bytes=2-5' }))
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), 'bytes 2-5/10')
  assert.equal(await part.text(), '2345')
  assert.equal(await (await h(req('GET', '/api/files?name=' + up.file, undefined, { Range: 'bytes=7-' }))).text(), '789')
  assert.equal(await (await h(req('GET', '/api/files?name=' + up.file, undefined, { Range: 'bytes=-3' }))).text(), '789')
  assert.equal((await h(req('GET', '/api/files?name=' + up.file, undefined, { Range: 'bytes=20-' }))).status, 416)

  assert.equal((await h(req('GET', '/api/files?name=' + encodeURIComponent('../c.db')))).status, 400)
  assert.equal((await h(req('GET', '/api/files?name=missing-1.pdf'))).status, 404)
})

test('files picked in the dialog are copied in; HTML is never served as a page', async () => {
  const dir = tmp(), src = join(tmp(), 'Notes page.html')
  writeFileSync(src, '<script>alert(1)</script>')
  const h = api(dir, host([src]))
  const [f] = await (await h(req('POST', '/api/research/pick'))).json()
  assert.equal(f.name, 'Notes page.html')
  const r = await h(req('GET', '/api/files?name=' + f.file))
  assert.equal(r.headers.get('content-type'), 'application/octet-stream')
  assert.match(r.headers.get('content-security-policy') || '', /sandbox/)
})

test('clipping a page keeps its title and readable text', async () => {
  const html = `<html><head><title>Lighthouses &amp; tides</title><script>var x = 1</script></head><body>
    <nav>Home · About</nav><article><h1>Keepers</h1><p>The last keeper left in&nbsp;1961.</p><p>The bell still rings at the turn.</p></article><footer>©</footer></body></html>`
  const fetchImpl = (async () => new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch
  const h = api(tmp(), host(), fetchImpl)
  const c = await (await h(req('POST', '/api/research/clip', JSON.stringify({ url: 'https://example.com/keepers' })))).json()
  assert.equal(c.title, 'Lighthouses & tides')
  assert.equal(c.text, 'Keepers\n\nThe last keeper left in 1961.\n\nThe bell still rings at the turn.')
  assert.equal((await h(req('POST', '/api/research/clip', JSON.stringify({ url: 'file:///etc/passwd' })))).status, 400)
  assert.equal(readable('<p>a</p><p>b</p>').text, 'a\n\nb')
})
