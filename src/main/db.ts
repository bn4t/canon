// Canon's store: typed records (JSON per record) in SQLite, with a change history that
// backs undo/redo and per-record version lists. Same schema as the Go version, so old databases open as-is.
// ponytail: JSON-per-record, the renderer owns the schemas; normalize tables if we ever need SQL queries over fields.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id      TEXT PRIMARY KEY,
  kind    TEXT NOT NULL,
  data    TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  grp    TEXT NOT NULL,
  label  TEXT NOT NULL DEFAULT '',
  record TEXT NOT NULL,
  kind   TEXT NOT NULL,
  prev   TEXT,              -- NULL: record did not exist before
  next   TEXT,              -- NULL: record was deleted
  at     INTEGER NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS history_record ON history(record, seq);
CREATE INDEX IF NOT EXISTS history_grp ON history(grp);
`

/** Kinds outside undo: chat transcripts and the daily word history. */
const UNTRACKED = `('chat', 'day')`

export interface RecordRow { id: string; kind: string; data: unknown; updated: number }
export interface ChangeSet {
  /** Edits with the same group undo together; repeated edits to a record in one group coalesce. */
  group: string
  label?: string
  /** Baseline writes (import, first-run setup) aren't recorded, so undo can never go back past them. */
  baseline?: boolean
  changes: { id: string; kind?: string; data: unknown }[]
}
export interface Version { seq: number; label: string; at: number; prev: unknown }

export class Store {
  readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  close() { this.db.close() }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  list(): RecordRow[] {
    const rows = this.db.prepare('SELECT id, kind, data, updated FROM records').all() as { id: string; kind: string; data: string; updated: number }[]
    return rows.map(r => ({ id: r.id, kind: r.kind, data: JSON.parse(r.data), updated: Number(r.updated) }))
  }

  /** Apply a change set in one transaction and record history. Throws on invalid input. */
  save(cs: ChangeSet) {
    if (!cs || typeof cs.group !== 'string' || !cs.group || !Array.isArray(cs.changes)) throw new BadRequest('group and changes required')
    const q = {
      get: this.db.prepare('SELECT data, kind FROM records WHERE id = ?'),
      del: this.db.prepare('DELETE FROM records WHERE id = ?'),
      put: this.db.prepare(`INSERT INTO records (id, kind, data, updated) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, data = excluded.data, updated = excluded.updated`),
      last: this.db.prepare('SELECT seq, grp FROM history WHERE record = ? ORDER BY seq DESC LIMIT 1'),
      move: this.db.prepare('UPDATE history SET next = ?, at = ? WHERE seq = ?'),
      add: this.db.prepare('INSERT INTO history (grp, label, record, kind, prev, next, at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    }
    this.tx(() => {
      // A new edit invalidates the redo stack. Chats and writing history aren't part of undo, so they don't.
      if (cs.changes.some(c => c.kind !== 'chat' && c.kind !== 'day')) this.db.exec('DELETE FROM history WHERE undone = 1')
      const now = Date.now()
      for (const c of cs.changes) {
        if (!c.id) throw new BadRequest('change without id')
        const deleting = c.data === null || c.data === undefined
        const cur = q.get.get(c.id) as { data: string; kind: string } | undefined
        const kind = c.kind || cur?.kind
        if (!kind) throw new BadRequest('kind required for new record ' + c.id)
        const next = deleting ? null : JSON.stringify(c.data)
        if (deleting) q.del.run(c.id)
        else q.put.run(c.id, kind, next, now)
        if (cs.baseline) continue
        // Coalesce: if this record's latest history row is from the same group, just move its "next".
        const last = q.last.get(c.id) as { seq: number; grp: string } | undefined
        if (last && last.grp === cs.group) q.move.run(next, now, last.seq)
        else q.add.run(cs.group, cs.label || '', c.id, kind, cur?.data ?? null, next, now)
      }
    })
  }

  /** Undo reverts the latest group that isn't undone; redo re-applies the earliest undone group. */
  step(undo: boolean): { label: string; ids: string[] } {
    return this.tx(() => {
      const head = this.db.prepare(undo
        ? `SELECT grp, label FROM history WHERE undone = 0 AND kind NOT IN ${UNTRACKED} ORDER BY seq DESC LIMIT 1`
        : `SELECT grp, label FROM history WHERE undone = 1 AND kind NOT IN ${UNTRACKED} ORDER BY seq ASC LIMIT 1`).get() as { grp: string; label: string } | undefined
      if (!head) return { label: '', ids: [] }
      const rows = this.db.prepare(`SELECT record, kind, prev, next FROM history WHERE grp = ? AND kind NOT IN ${UNTRACKED} ORDER BY seq ${undo ? 'DESC' : 'ASC'}`)
        .all(head.grp) as { record: string; kind: string; prev: string | null; next: string | null }[]
      const put = this.db.prepare(`INSERT INTO records (id, kind, data, updated) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, kind = excluded.kind, updated = excluded.updated`)
      const del = this.db.prepare('DELETE FROM records WHERE id = ?')
      const now = Date.now()
      for (const r of rows) {
        const target = undo ? r.prev : r.next
        if (target !== null) put.run(r.record, r.kind, target, now)
        else del.run(r.record)
      }
      this.db.prepare('UPDATE history SET undone = ? WHERE grp = ?').run(undo ? 1 : 0, head.grp)
      return { label: head.label, ids: rows.map(r => r.record) }
    })
  }

  /** Recent versions of one record (newest first) for the "History" panel. */
  history(record: string, limit = 50): Version[] {
    if (!(limit > 0 && limit <= 200)) limit = 50
    const rows = this.db.prepare('SELECT seq, label, at, prev FROM history WHERE record = ? AND undone = 0 ORDER BY seq DESC LIMIT ?')
      .all(record, limit) as { seq: number; label: string; at: number; prev: string | null }[]
    return rows.map(r => ({ seq: Number(r.seq), label: r.label, at: Number(r.at), prev: r.prev === null ? null : JSON.parse(r.prev) }))
  }

  /** Copy the database into dir (one file per start) and keep the newest `keep`. */
  backup(dir: string, keep = 10, now = new Date()) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const p = (n: number) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
    const name = join(dir, `canon-${stamp}.db`)
    rmSync(name, { force: true })
    this.db.prepare('VACUUM INTO ?').run(name)
    const old = readdirSync(dir).filter(f => /^canon-.*\.db$/.test(f)).sort()
    while (old.length > keep) rmSync(join(dir, old.shift()!), { force: true })
    return name
  }
}

export class BadRequest extends Error {}
