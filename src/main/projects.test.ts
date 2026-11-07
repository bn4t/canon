import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './db.ts'
import { createApi, dbPath, type ApiOptions, type Host } from './api.ts'
import { currentProject } from './projects.ts'

const req = (method: string, path: string, body?: unknown) => new Request('canon://app' + path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'canon-projects-'))
  const saved: Uint8Array[] = [], trashed: string[] = []
  let pick: string[] = []
  const host: Host = {
    pickFolder: async () => undefined, save: async (name, data) => { saved.push(data); return '/x/' + name }, pdf: async () => new Uint8Array(),
    print: async () => {}, pickFiles: async () => pick, trash: async p => { trashed.push(p) }, reload: () => {}, reveal: () => {}, openExternal: () => {}, notify: () => {},
  }
  const cur = currentProject(dataDir)
  const o: ApiOptions = { store: new Store(cur.db), dataDir, host, projectDir: cur.dir, dbPath: cur.db }
  o.store.save({ group: 'g', baseline: true, changes: [{ id: 'project', kind: 'project', data: { title: 'First', author: 'Ana' } }, { id: 's1', kind: 'scene', data: { prose: 'One two three.' } }] })
  const api = createApi(o)
  const call = async (method: string, path: string, body?: unknown) => { const r = await api(req(method, path, body)); return { status: r.status, data: r.status === 200 ? await r.json() : await r.text() } }
  return { o, dataDir, call, saved, trashed, setPick: (p: string[]) => { pick = p } }
}
const title = (o: ApiOptions) => JSON.parse((o.store.db.prepare("SELECT data FROM records WHERE id = 'project'").get() as { data: string }).data).title

test('new projects live in the library, switch on creation, and are remembered across starts', async () => {
  const { o, dataDir, call } = setup()
  const made = await call('POST', '/api/projects/new', { title: 'Sea / Novel', records: [{ id: 'project', kind: 'project', data: { title: 'Sea / Novel' } }] })
  assert.equal(made.data.dir, join(dataDir, 'Projects', 'Sea Novel'), 'slashes never make folders')
  assert.equal(dbPath(o), made.data.db)
  assert.ok(existsSync(join(made.data.dir, 'backups')), 'backed up on open')
  assert.deepEqual(currentProject(dataDir), { db: made.data.db, dir: made.data.dir })
  const list = (await call('GET', '/api/projects')).data
  assert.deepEqual(list.map((p: { title: string; current: boolean }) => [p.title, p.current]), [['Sea / Novel', true], ['First', false]])
  assert.equal(list[1].words, 3)
  assert.equal(list[1].original, true)
  await call('POST', '/api/projects/open', { db: list[1].db })
  assert.equal(title(o), 'First')
  assert.equal((await call('POST', '/api/projects/open', { db: '/nowhere/canon.db' })).status, 400)
})

test('duplicate copies the database and files under a new title', async () => {
  const { o, call } = setup()
  mkdirSync(join(o.dataDir, 'files')); writeFileSync(join(o.dataDir, 'files', 'map.pdf'), '%PDF')
  const d = (await call('POST', '/api/projects/duplicate', { title: 'First, second draft' })).data
  assert.equal(title(o), 'First, second draft')
  assert.ok(existsSync(join(d.dir, 'files', 'map.pdf')))
  assert.equal((o.store.db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind = 'scene'").get() as { n: number }).n, 1)
})

test('a project file round-trips, and removing never touches the open or the first project', async () => {
  const { o, dataDir, call, saved, trashed, setPick } = setup()
  mkdirSync(join(dataDir, 'files')); writeFileSync(join(dataDir, 'files', 'pic.png'), 'png')
  await call('POST', '/api/projects/export')
  const file = join(mkdtempSync(join(tmpdir(), 'canon-file-')), 'First.canon')
  writeFileSync(file, saved[0])
  setPick([file])
  const opened = (await call('POST', '/api/projects/import-file')).data
  assert.equal(dbPath(o), opened.db)
  assert.equal(title(o), 'First')
  assert.ok(existsSync(join(opened.db, '..', 'files', 'pic.png')))
  assert.equal((await call('POST', '/api/projects/remove', { db: opened.db })).status, 400, 'open')
  assert.equal((await call('POST', '/api/projects/remove', { db: join(dataDir, 'canon.db') })).status, 400, 'original')
  await call('POST', '/api/projects/open', { db: join(dataDir, 'canon.db') })
  assert.equal((await call('POST', '/api/projects/remove', { db: opened.db })).status, 204)
  assert.deepEqual(trashed, [join(opened.db, '..')])
  setPick([join(dataDir, 'nope.txt')]); writeFileSync(join(dataDir, 'nope.txt'), 'hi')
  assert.equal((await call('POST', '/api/projects/import-file')).status, 400)
})

test('restoring a backup keeps a safety copy, or opens it as a separate project', async () => {
  const { o, call } = setup()
  const { name } = (await call('POST', '/api/backups/now')).data
  o.store.save({ group: 'g2', baseline: true, changes: [{ id: 'project', kind: 'project', data: { title: 'Changed' } }] })
  await new Promise(r => setTimeout(r, 1100)) // backup names have one-second resolution
  const r = (await call('POST', '/api/backups/restore', { name, mode: 'replace' })).data
  assert.equal(title(o), 'First')
  const names = (await call('GET', '/api/backups')).data.map((b: { name: string }) => b.name)
  assert.ok(names.includes(r.safety) && names.includes(name))
  const c = (await call('POST', '/api/backups/restore', { name: r.safety, mode: 'copy' })).data
  assert.equal(dbPath(o), c.db)
  assert.match(title(o), /^Changed \(restored \d{4}-\d\d-\d\d\)$/)
  assert.equal((await call('POST', '/api/backups/restore', { name: '../canon.db', mode: 'copy' })).status, 400)
})
