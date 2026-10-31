import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './db.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'canon-'))

test('records, undo and redo', () => {
  const s = new Store(join(tmp(), 't.db'))
  const save = (cs: object) => s.save(cs as never)
  const get = () => Object.fromEntries(s.list().map(r => [r.id, JSON.stringify(r.data)]))

  save({ group: 'g1', changes: [{ id: 'a', kind: 'scene', data: { t: 1 } }] })
  save({ group: 'g2', changes: [{ id: 'a', data: { t: 2 } }] })
  save({ group: 'g2', changes: [{ id: 'a', data: { t: 3 } }] }) // coalesces into g2
  save({ group: 'g3', changes: [{ id: 'a', data: null }, { id: 'b', kind: 'scene', data: { t: 9 } }] })
  assert.deepEqual(get(), { b: '{"t":9}' })
  s.step(true) // undo g3: a back, b gone
  assert.deepEqual(get(), { a: '{"t":3}' })
  s.step(true) // undo g2 (both coalesced edits at once)
  assert.deepEqual(get(), { a: '{"t":1}' })
  s.step(false) // redo g2
  assert.deepEqual(get(), { a: '{"t":3}' })
  save({ group: 'g4', changes: [{ id: 'a', data: { t: 4 } }] }) // new edit clears redo (g3)
  s.step(false)
  assert.deepEqual(get(), { a: '{"t":4}' })

  // Chat transcripts are outside undo: undo skips them and they don't clear redo.
  save({ group: 'g4', changes: [{ id: 'q', kind: 'question', data: { answer: 'x' } }] })
  save({ group: 'g5', changes: [{ id: 'c', kind: 'chat', data: { n: 1 } }] })
  s.step(true)
  assert.equal(get().q, undefined)
  assert.equal(get().c, '{"n":1}')
  save({ group: 'g6', changes: [{ id: 'c', kind: 'chat', data: { n: 2 } }] })
  s.step(false)
  assert.equal(get().q, '{"answer":"x"}')
  assert.equal(get().c, '{"n":2}')

  // Baseline writes (import) are invisible to undo.
  save({ group: 'g7', baseline: true, changes: [{ id: 'base', kind: 'series', data: { t: 0 } }] })
  s.step(true)
  assert.equal(get().base, '{"t":0}')
  assert.equal(get().q, undefined)

  assert.deepEqual(s.step(true).ids.length >= 0, true)
  assert.throws(() => save({ group: '', changes: [] }), /group/)
  assert.throws(() => save({ group: 'g8', changes: [{ id: 'new', data: {} }] }), /kind required/)
})

test('history lists versions newest first', () => {
  const s = new Store(join(tmp(), 'h.db'))
  s.save({ group: 'g1', label: 'Create', changes: [{ id: 'a', kind: 'entity', data: { n: 'A' } }] })
  s.save({ group: 'g2', label: 'Rename', changes: [{ id: 'a', data: { n: 'B' } }] })
  const h = s.history('a')
  assert.deepEqual(h.map(v => [v.label, v.prev]), [['Rename', { n: 'A' }], ['Create', null]])
})

test('backup keeps the newest ten', () => {
  const s = new Store(join(tmp(), 'c.db'))
  const dir = tmp()
  for (let i = 0; i < 12; i++) writeFileSync(join(dir, `canon-2000-01-01-0000${String(i).padStart(2, '0')}.db`), '')
  s.backup(dir)
  assert.equal(readdirSync(dir).filter(f => f.startsWith('canon-')).length, 10)
})
