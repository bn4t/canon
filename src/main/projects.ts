// Projects: the library of projects on this Mac, switching between them, new projects (from templates the renderer
// builds), duplicates, project files (.canon: the database and its files, zipped), and backups.
// Layout: the original project lives in the data folder itself (canon.db, files/, backups/), as it always has;
// new ones live in <data>/Projects/<title>/ with the same three things. projects.json remembers which is open and when
// each was last opened. Switching swaps the Store on the live ApiOptions; the renderer reloads itself afterwards.
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Store } from './db.ts'
import { projectDir, dbPath, type ApiOptions } from './api.ts'
import { json, body, none, BadRequest, type Routes } from './http.ts'
import { writeAtomic } from './files.ts'
import { zip } from './epub.ts'
import { unzip } from './convert.ts'

interface Entry { db: string; dir: string; opened?: number }
interface Registry { current?: string; items: Entry[] }
export interface ProjectInfo { db: string; dir: string; title: string; author: string; words: number; scenes: number; opened?: number; current: boolean; original: boolean }
export interface BackupInfo { name: string; at: number; size: number }

const regPath = (dataDir: string) => join(dataDir, 'projects.json')
function readRegistry(dataDir: string): Registry {
  try { const r = JSON.parse(readFileSync(regPath(dataDir), 'utf8')); return { current: r.current, items: Array.isArray(r.items) ? r.items : [] } } catch { return { items: [] } }
}
const writeRegistry = (dataDir: string, r: Registry) => writeAtomic(regPath(dataDir), JSON.stringify(r, null, 1))
const original = (dataDir: string): Entry => ({ db: join(dataDir, 'canon.db'), dir: dataDir })

/** The database the app opens at start: the last project used, or the original one in the data folder. */
export function currentProject(dataDir: string): { db: string; dir: string } {
  const r = readRegistry(dataDir), e = r.items.find(x => x.db === r.current)
  return e && existsSync(e.db) ? { db: e.db, dir: e.dir } : original(dataDir)
}

let changed = () => {}
/** Called after the list or the open project changes (main rebuilds Open Recent). */
export const onProjectsChanged = (f: () => void) => { changed = f }

/** Every project: the original, the remembered ones, and any folder in Projects/ (say, copied in by hand). */
function entries(dataDir: string): Entry[] {
  const r = readRegistry(dataDir), map = new Map<string, Entry>()
  const add = (e: Entry) => { if (existsSync(e.db) && !map.has(e.db)) map.set(e.db, { ...e, opened: r.items.find(x => x.db === e.db)?.opened ?? e.opened }) }
  add(original(dataDir))
  r.items.forEach(add)
  const lib = join(dataDir, 'Projects')
  if (existsSync(lib)) for (const d of readdirSync(lib)) add({ db: join(lib, d, 'canon.db'), dir: join(lib, d) })
  return [...map.values()]
}

const countWords = (t: string) => { let n = 0; for (const w of t.match(/\S+/g) || []) if (/[\p{L}\p{N}]/u.test(w)) n++; return n }
/** Title, author and size, read straight from the database (the open one through its own connection). Undefined: not a project yet. */
function readInfo(db: DatabaseSync): { title: string; author: string; words: number; scenes: number } | undefined {
  const p = db.prepare("SELECT data FROM records WHERE id = 'project'").get() as { data: string } | undefined
  if (!p) return
  const proj = JSON.parse(p.data) as { title?: string; author?: string }
  const rows = db.prepare("SELECT json_extract(data, '$.prose') AS prose FROM records WHERE kind = 'scene'").all() as { prose: string | null }[]
  return { title: proj.title || 'Untitled project', author: proj.author || '', words: rows.reduce((n, r) => n + countWords(r.prose || ''), 0), scenes: rows.length }
}
function infoOf(o: ApiOptions, e: Entry): ProjectInfo | undefined {
  const current = e.db === dbPath(o)
  let conn: DatabaseSync | undefined
  try {
    const i = readInfo(current ? o.store.db : (conn = new DatabaseSync(e.db, { readOnly: true })))
    if (!i && !current) return
    return { ...(i || { title: 'Untitled project', author: '', words: 0, scenes: 0 }), db: e.db, dir: e.dir, opened: e.opened, current, original: e.dir === o.dataDir }
  } catch { return } finally { conn?.close() }
}
export function listProjects(o: ApiOptions): ProjectInfo[] {
  return entries(o.dataDir).map(e => infoOf(o, e)).filter((x): x is ProjectInfo => !!x)
    .sort((a, b) => Number(b.current) - Number(a.current) || (b.opened || 0) - (a.opened || 0) || a.title.localeCompare(b.title))
}

/** A fresh folder in the library for a title ("Novel", "Novel 2", …). */
function newDir(dataDir: string, title: string) {
  const lib = join(dataDir, 'Projects'), base = title.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, ' ').replace(/^\.+/, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled project'
  let dir = join(lib, base)
  for (let n = 2; existsSync(dir); n++) dir = join(lib, `${base} ${n}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
/** Set the title on a project database that isn't open (a duplicate, a restored copy). */
function retitle(db: string, title: string) {
  const s = new Store(db)
  try {
    const p = s.db.prepare("SELECT data FROM records WHERE id = 'project'").get() as { data: string } | undefined
    if (p) s.save({ group: 'retitle', baseline: true, changes: [{ id: 'project', kind: 'project', data: { ...JSON.parse(p.data), title } }] })
  } finally { s.close() }
}

/** Remember that a project was opened: it becomes the one to open at start, and moves to the top of Open Recent. */
export function noteOpened(dataDir: string, e: { db: string; dir: string }) {
  const r = readRegistry(dataDir)
  r.current = e.db
  r.items = [{ db: e.db, dir: e.dir, opened: Date.now() }, ...r.items.filter(x => x.db !== e.db)]
  try { writeRegistry(dataDir, r) } catch (er) { console.error('projects.json:', er) }
}

/** Open another project: open its database first (so a broken one leaves the current project as it was), back it up, then swap. */
export function switchTo(o: ApiOptions, e: { db: string; dir: string }) {
  if (e.db === dbPath(o)) return
  const next = new Store(e.db)
  try { next.backup(join(e.dir, 'backups')) } catch { /* a backup failing never blocks opening */ }
  o.store.close()
  o.store = next; o.projectDir = e.dir; o.dbPath = e.db
  noteOpened(o.dataDir, e)
  changed()
}

/** Recently opened projects for the Open Recent menu (titles read from each database). */
export function recentProjects(o: ApiOptions, n = 8) {
  return listProjects(o).filter(p => p.opened).slice(0, n)
}

const BACKUP = /^canon-[\w-]+\.db$/
const stamp = () => new Date().toLocaleDateString('sv')

export function projectRoutes(o: ApiOptions): Routes {
  const known = (db: string) => { const e = entries(o.dataDir).find(x => x.db === db); if (!e) throw new BadRequest('That project isn’t on this Mac any more.'); return e }
  const backupsDir = () => join(projectDir(o), 'backups')
  const backupPath = (name: string) => { if (!BACKUP.test(name || '') || !existsSync(join(backupsDir(), name))) throw new BadRequest('That backup isn’t there any more.'); return join(backupsDir(), name) }
  return {
    'GET /api/projects': () => json(listProjects(o)),
    /** A new project from records the renderer built (a template, the sample, or just a project record). */
    'POST /api/projects/new': async r => {
      const b = await body<{ title?: string; records?: { kind: string; id: string; data: unknown }[] }>(r)
      const title = (b.title || '').trim() || 'Untitled project'
      const dir = newDir(o.dataDir, title), db = join(dir, 'canon.db')
      const s = new Store(db)
      try { s.save({ group: 'new-project', baseline: true, changes: b.records?.length ? b.records : [{ id: 'project', kind: 'project', data: { title, logline: '', thesis: '', background: '' } }] }) } finally { s.close() }
      switchTo(o, { db, dir })
      return json({ db, dir })
    },
    'POST /api/projects/open': async r => { const { db } = await body<{ db: string }>(r); switchTo(o, known(db)); return none() },
    /** A full copy (database, files) under a new title, which opens. */
    'POST /api/projects/duplicate': async r => {
      const { title = '' } = await body<{ title?: string }>(r)
      const dir = newDir(o.dataDir, title.trim() || 'Copy'), db = join(dir, 'canon.db')
      o.store.db.prepare('VACUUM INTO ?').run(db)
      const files = join(projectDir(o), 'files')
      if (existsSync(files)) cpSync(files, join(dir, 'files'), { recursive: true })
      if (title.trim()) retitle(db, title.trim())
      switchTo(o, { db, dir })
      return json({ db, dir })
    },
    /** A .canon file: the database and its files, zipped, saved where the author chooses. */
    'POST /api/projects/export': async () => {
      const tmp = join(tmpdir(), `canon-export-${randomBytes(6).toString('hex')}.db`)
      try {
        o.store.db.prepare('VACUUM INTO ?').run(tmp)
        const title = readInfo(o.store.db)?.title || 'Canon project'
        const files = join(projectDir(o), 'files')
        const entries = [{ name: 'canon.db', data: readFileSync(tmp) }, ...(existsSync(files) ? readdirSync(files).filter(f => !f.startsWith('.') && statSync(join(files, f)).isFile()).map(f => ({ name: 'files/' + f, data: readFileSync(join(files, f)) })) : [])]
        const path = await o.host.save(`${title.replace(/[/\\:*?"<>|]+/g, ' ').trim() || 'Canon project'}.canon`, zip(entries))
        return json({ path: path || '' })
      } finally { rmSync(tmp, { force: true }) }
    },
    /** Open a .canon file (or a bare database): it is copied into the library and opens. */
    'POST /api/projects/import-file': async () => {
      const [p] = await o.host.pickFiles('Open a Canon project file', [{ name: 'Canon project', extensions: ['canon', 'db'] }], false)
      if (!p) return json({ db: '' })
      const tmp = join(tmpdir(), `canon-open-${randomBytes(6).toString('hex')}`)
      mkdirSync(tmp, { recursive: true })
      try {
        let files = new Map<string, Uint8Array>()
        if (p.endsWith('.db')) copyFileSync(p, join(tmp, 'canon.db'))
        else {
          files = unzip(readFileSync(p))
          const data = files.get('canon.db')
          if (!data) throw new BadRequest('That file isn’t a Canon project.')
          writeFileSync(join(tmp, 'canon.db'), data)
        }
        let title = 'Untitled project'
        const conn = new DatabaseSync(join(tmp, 'canon.db'), { readOnly: true })
        try { title = readInfo(conn)?.title || title } catch { throw new BadRequest('That file isn’t a Canon project.') } finally { conn.close() }
        const dir = newDir(o.dataDir, title), db = join(dir, 'canon.db')
        copyFileSync(join(tmp, 'canon.db'), db)
        for (const [name, data] of files) if (name.startsWith('files/') && !name.includes('..') && name.length > 6) { mkdirSync(join(dir, 'files'), { recursive: true }); writeFileSync(join(dir, 'files', basename(name)), data) }
        switchTo(o, { db, dir })
        return json({ db })
      } finally { rmSync(tmp, { recursive: true, force: true }) }
    },
    /** Move a project's folder to the Trash. Never the open project, and never the original (its folder holds Canon's settings). */
    'POST /api/projects/remove': async r => {
      const { db } = await body<{ db: string }>(r)
      const e = known(db)
      if (e.db === dbPath(o)) throw new BadRequest('This project is open. Open another one first.')
      if (e.dir === o.dataDir) throw new BadRequest('The first project can’t be removed from here.')
      await o.host.trash(e.dir)
      const reg = readRegistry(o.dataDir)
      reg.items = reg.items.filter(x => x.db !== db)
      writeRegistry(o.dataDir, reg)
      changed()
      return none()
    },

    'GET /api/backups': () => {
      const dir = backupsDir()
      const out: BackupInfo[] = existsSync(dir) ? readdirSync(dir).filter(f => BACKUP.test(f)).map(f => { const st = statSync(join(dir, f)); return { name: f, at: st.mtimeMs, size: st.size } }) : []
      return json(out.sort((a, b) => b.at - a.at))
    },
    'POST /api/backups/now': () => json({ name: basename(o.store.backup(backupsDir())) }),
    /** Restore a backup. "replace": back up the project as it is now, then put the backup in its place.
     *  "copy": open the backup as a separate project, leaving this one untouched. */
    'POST /api/backups/restore': async r => {
      const { name, mode } = await body<{ name: string; mode: 'replace' | 'copy' }>(r)
      const src = backupPath(name)
      if (mode === 'copy') {
        let title = 'Untitled project'
        const conn = new DatabaseSync(src, { readOnly: true })
        try { title = readInfo(conn)?.title || title } finally { conn.close() }
        const at = new Date(statSync(src).mtimeMs).toLocaleDateString('sv')
        const full = `${title} (restored ${at})`, dir = newDir(o.dataDir, full), db = join(dir, 'canon.db')
        copyFileSync(src, db)
        const files = join(projectDir(o), 'files')
        if (existsSync(files)) cpSync(files, join(dir, 'files'), { recursive: true })
        retitle(db, full)
        switchTo(o, { db, dir })
        return json({ db })
      }
      if (mode !== 'replace') throw new BadRequest('mode must be replace or copy')
      // Copy the chosen backup aside first: making the safety copy can prune the oldest backups.
      const tmp = join(backupsDir(), `.restore-${randomBytes(6).toString('hex')}.db`)
      copyFileSync(src, tmp)
      try {
        const safety = basename(o.store.backup(backupsDir()))
        const db = dbPath(o)
        o.store.close()
        for (const x of ['-wal', '-shm', '-journal']) rmSync(db + x, { force: true })
        copyFileSync(tmp, db)
        o.store = new Store(db)
        changed()
        return json({ safety, at: stamp() })
      } finally { rmSync(tmp, { force: true }) }
    },
  }
}
