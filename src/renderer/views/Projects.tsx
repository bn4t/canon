// Projects: switching between the projects on this Mac, new projects from templates, duplicates, project files (.canon),
// and backups with restore. The main process does the file work (src/main/projects.ts); after it opens another project
// the window starts fresh on that project's Home.
import { useEffect, useState } from 'react'
import { flush, getState, project, showToast, type State } from '../store.ts'
import { SettingsGroup as Group, Icon, Popover, ago, isMac, savedToast } from '../ui.tsx'
import { TEMPLATES, SAMPLE, type Template } from '../templates.ts'
import './projects.css'

interface ProjectInfo { db: string; dir: string; title: string; author: string; words: number; scenes: number; opened?: number; current: boolean; original: boolean }
interface BackupInfo { name: string; at: number; size: number }

const n = (x: number) => x.toLocaleString()
const plural = (k: number, one: string) => `${n(k)} ${k === 1 ? one : one + 's'}`
const finder = isMac ? 'Show in Finder' : 'Show in folder'
const size = (b: number) => (b < 1 << 20 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / (1 << 20)).toFixed(1)} MB`)
const send = (cmd: string) => dispatchEvent(new CustomEvent('canon:command', { detail: cmd, cancelable: true }))
const reveal = (path: string) => fetch('/api/reveal', { method: 'POST', body: JSON.stringify({ path }) })
const msg = (e: unknown) => String(e).replace(/^Error: /, '')
async function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
  if (!r.ok) throw new Error(await r.text())
  return (r.status === 204 ? undefined : await r.json()) as T
}
/** Save every pending edit first: the switch closes this project's database. */
async function saved() {
  await flush()
  if (getState().save === 'error') throw new Error('The last changes haven’t saved yet, so Canon is staying in this project. Try again in a moment.')
}
/** The main process has opened another project: start the window fresh on its Home. */
const reopen = () => { history.replaceState(null, '', '#home'); location.reload() }
/** Run a switch: save, ask the main process, reload. */
async function switchVia<T>(path: string, body?: unknown, done: (r: T) => boolean = () => true) {
  await saved()
  const r = await post<T>(path, body)
  if (done(r)) reopen()
}
export const openProject = (db: string) => switchVia('/api/projects/open', { db })
const openFile = () => switchVia<{ db: string }>('/api/projects/import-file', undefined, r => !!r.db)
const exportFile = async () => { try { await saved(); const { path } = await post<{ path: string }>('/api/projects/export'); if (path) savedToast(path) } catch (e) { showToast(msg(e)) } }
const useProjects = () => {
  const [list, setList] = useState<ProjectInfo[]>()
  const load = () => fetch('/api/projects').then(r => r.json()).then(setList).catch(() => setList([]))
  useEffect(() => { load() }, [])
  return [list, load] as const
}

/** Items at the top of the sidebar's project menu: other recent projects, then the project commands. */
export function ProjectMenuItems({ close }: { close: () => void }) {
  const [list] = useProjects()
  const others = (list || []).filter(p => !p.current).slice(0, 4)
  const run = (f: () => unknown) => () => { close(); Promise.resolve(f()).catch(e => showToast(msg(e))) }
  return <>
    {others.length > 0 && <div className="pj-menu-h">Switch to</div>}
    {others.map(p => <button key={p.db} className="menu-item" role="menuitem" onClick={run(() => openProject(p.db))}>
      <Icon name="stories" size={14} /><span className="grow clip">{p.title}</span>{p.opened && <span className="pj-menu-ago">{ago(p.opened)}</span>}</button>)}
    <button className="menu-item" role="menuitem" onClick={run(() => send('switch-project'))}><Icon name="list" size={14} />All projects…</button>
    <button className="menu-item" role="menuitem" onClick={run(() => send('new-project'))}><Icon name="plus" size={14} />New project…</button>
    <button className="menu-item" role="menuitem" onClick={run(() => send('duplicate-project'))}><Icon name="copy" size={14} />Duplicate this project…</button>
    <button className="menu-item" role="menuitem" onClick={run(exportFile)}><Icon name="upload" size={14} />Export as a project file…</button>
    <div className="menu-sep" />
  </>
}

/** Always mounted: handles new-project, open-project, switch-project, duplicate-project, export-project and open-project:<db>. */
export function ProjectsHost({ s }: { s: State }) {
  const [open, setOpen] = useState<'switch' | 'new' | 'duplicate'>()
  useEffect(() => {
    const on = (e: Event) => {
      const c = (e as CustomEvent<string>).detail
      const to = ({ 'new-project': 'new', 'open-project': 'switch', 'switch-project': 'switch', 'duplicate-project': 'duplicate' } as const)[c]
      if (to) { e.preventDefault(); setOpen(to) }
      else if (c === 'export-project') { e.preventDefault(); exportFile() }
      else if (c.startsWith('open-project:')) { e.preventDefault(); openProject(c.slice('open-project:'.length)).catch(er => showToast(msg(er))) }
    }
    addEventListener('canon:command', on)
    return () => removeEventListener('canon:command', on)
  }, [])
  const close = () => setOpen(undefined)
  if (open === 'switch') return <Switcher onClose={close} onNew={() => setOpen('new')} />
  if (open === 'new') return <NewProject onClose={close} />
  if (open === 'duplicate') return <Duplicate s={s} onClose={close} />
  return null
}

function Dialog({ title, sub, onClose, wide, children, foot }: { title: string; sub?: string; onClose: () => void; wide?: boolean; children: React.ReactNode; foot?: React.ReactNode }) {
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; addEventListener('keydown', esc); return () => removeEventListener('keydown', esc) }, [onClose])
  return (
    <div className="overlay pj-overlay" onMouseDown={onClose}>
      <div className={'palette pj' + (wide ? ' wide' : '')} role="dialog" aria-label={title} onMouseDown={e => e.stopPropagation()}>
        <div className="pj-h"><div className="grow"><h2>{title}</h2>{sub && <p className="small muted">{sub}</p>}</div><button className="x" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="pj-b">{children}</div>
        {foot && <div className="pj-f">{foot}</div>}
      </div>
    </div>
  )
}

function Switcher({ onClose, onNew }: { onClose: () => void; onNew: () => void }) {
  const [list, load] = useProjects()
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [confirm, setConfirm] = useState('')
  const run = (what: string, f: () => Promise<unknown>) => async () => { setBusy(what); setErr(''); try { await f() } catch (e) { setErr(msg(e)) } setBusy('') }
  const remove = (p: ProjectInfo) => run('remove', async () => { await post('/api/projects/remove', { db: p.db }); setConfirm(''); await load(); showToast(`Moved “${p.title}” to the Trash`) })()
  return (
    <Dialog title="Projects" sub="Every project on this Mac. Each is its own file, with its own research and backups." onClose={onClose} wide
      foot={<><button className="btn ghost" disabled={!!busy} onClick={run('file', openFile)}><Icon name="import" size={14} />{busy === 'file' ? 'Opening…' : 'Open a project file…'}</button><span className="grow" />
        <button className="btn pri" onClick={onNew}><Icon name="plus" size={14} />New project…</button></>}>
      {err && <div className="err">{err}</div>}
      {!list && <p className="small muted">Looking…</p>}
      <div className="pj-grid">
        {list?.map(p => (
          <div key={p.db} className={'pj-card' + (p.current ? ' cur' : '')}>
            <button className="pj-open" disabled={p.current || !!busy} title={p.current ? 'This is the open project' : `Open “${p.title}”`} onClick={run(p.db, () => openProject(p.db))}>
              <b className="pj-title">{p.title}</b>
              <span className="pj-meta">{[p.author, plural(p.words, 'word'), plural(p.scenes, 'scene')].filter(Boolean).join(' · ')}</span>
              <span className="pj-when">{busy === p.db ? 'Opening…' : p.current ? <><i className="dot" style={{ background: 'var(--ok)' }} />Open now</> : p.opened ? 'Opened ' + ago(p.opened) : 'Not opened yet'}</span>
            </button>
            {confirm === p.db
              ? <div className="pj-confirm"><span className="small grow">Move it to the Trash? You can put it back from there.</span>
                <button className="btn sm ghost" onClick={() => setConfirm('')}>Cancel</button><button className="btn sm danger" disabled={!!busy} onClick={() => remove(p)}>Move to Trash</button></div>
              : <Popover className="right pj-more" trigger={o => <button className="icon-btn sm" aria-label={`More for ${p.title}`} onClick={o}><Icon name="more" size={15} /></button>}>{close => <div role="menu">
                <button className="menu-item" role="menuitem" disabled={p.current} onClick={() => { close(); run(p.db, () => openProject(p.db))() }}>Open</button>
                <button className="menu-item" role="menuitem" onClick={() => { close(); reveal(p.db) }}>{finder}</button>
                <div className="menu-sep" />
                <button className="menu-item danger" role="menuitem" disabled={p.current || p.original} title={p.current ? 'Open another project first' : p.original ? 'The first project holds Canon’s settings, so it stays' : undefined}
                  onClick={() => { close(); setConfirm(p.db) }}>Move to Trash…</button>
              </div>}</Popover>}
          </div>
        ))}
      </div>
    </Dialog>
  )
}

/** Template cards; the sample too, where offered. */
export function TemplatePicker({ value, onChange, sample }: { value: string; onChange: (id: string) => void; sample?: boolean }) {
  return (
    <div className="pj-tpls" role="radiogroup" aria-label="Start from">
      {[...TEMPLATES, ...(sample ? [SAMPLE] : [])].map(t => (
        <button key={t.id} role="radio" aria-checked={value === t.id} className={'pj-tpl' + (value === t.id ? ' on' : '')} onClick={() => onChange(t.id)}>
          <span className="pj-tpl-i"><Icon name={t.icon} size={16} /></span><b>{t.name}</b><span>{t.blurb}</span>
        </button>
      ))}
    </div>
  )
}
export const templateById = (id: string): Template => [...TEMPLATES, SAMPLE].find(t => t.id === id) || TEMPLATES[0]

function NewProject({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [tpl, setTpl] = useState('novel')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const create = async () => {
    setBusy(true); setErr('')
    try {
      const records = templateById(tpl).build({ title: title.trim() || 'Untitled project' })
      const name = String(records.find(r => r.kind === 'project')?.data.title || title)
      await switchVia('/api/projects/new', { title: name, records })
    } catch (e) { setErr(msg(e)); setBusy(false) }
  }
  return (
    <Dialog title="New project" sub="It opens in this window. This project stays as it is, a click away in Projects." onClose={onClose} wide
      foot={<><span className="grow" /><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn pri" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create project'}</button></>}>
      <label className="field"><span className="lbl">Title</span>
        <input className="f pj-name" autoFocus value={tpl === 'sample' ? 'Low Tide at Merrow' : title} disabled={tpl === 'sample'} placeholder="Untitled project" onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') create() }} /></label>
      <div className="field"><span className="lbl">Start from</span><TemplatePicker value={tpl} onChange={setTpl} sample /></div>
      {err && <div className="err">{err}</div>}
    </Dialog>
  )
}

function Duplicate({ s, onClose }: { s: State; onClose: () => void }) {
  const [title, setTitle] = useState(`${project(s).title} copy`)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const go1 = async () => { setBusy(true); setErr(''); try { await switchVia('/api/projects/duplicate', { title: title.trim() || `${project(s).title} copy` }) } catch (e) { setErr(msg(e)); setBusy(false) } }
  return (
    <Dialog title="Duplicate this project" sub="A full copy, research files included, that opens in its place. This one stays as it is." onClose={onClose}
      foot={<><span className="grow" /><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn pri" disabled={busy} onClick={go1}>{busy ? 'Copying…' : 'Duplicate and open'}</button></>}>
      <label className="field"><span className="lbl">Title of the copy</span>
        <input className="f pj-name" autoFocus value={title} onChange={e => setTitle(e.target.value)} onFocus={e => e.target.select()} onKeyDown={e => { if (e.key === 'Enter') go1() }} /></label>
      {err && <div className="err">{err}</div>}
    </Dialog>
  )
}

/** Settings › Backups: the automatic copies, a copy now, restoring one (never without a copy of what it replaces), and the files. */
export function BackupsSection({ s: _s }: { s: State }) {
  const [info, setInfo] = useState<{ db: string; backups: string; projectDir: string }>()
  const [list, setList] = useState<BackupInfo[]>()
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const load = () => fetch('/api/backups').then(r => r.json()).then(setList).catch(e => setErr(msg(e)))
  useEffect(() => { fetch('/api/info').then(r => r.json()).then(setInfo); load() }, [])
  const run = (what: string, f: () => Promise<unknown>) => async () => { setBusy(what); setErr(''); try { await f() } catch (e) { setErr(msg(e)) } setBusy('') }
  const now = run('now', async () => { await saved(); await post('/api/backups/now'); await load(); showToast('Backed up') })
  const restore = (name: string, mode: 'replace' | 'copy') => run(name + mode, () => switchVia('/api/backups/restore', { name, mode }))
  const json = run('json', async () => { savedToast((await post<{ path: string }>('/api/backup')).path) })
  return <>
    <Group label="Backups" aside={<button className="btn sm" disabled={!!busy} onClick={now}>{busy === 'now' ? 'Backing up…' : 'Back up now'}</button>}>
      <p className="small muted">Canon copies the project every time it opens and keeps the last 10. Every change is in History too, so Undo reaches back across restarts; a backup is for going back further, or for when something went wrong.</p>
      {err && <div className="err">{err}</div>}
      <div className="set-box">
        {list && !list.length && <div className="set-row small muted">No backups yet. One is made the next time Canon opens this project, or now.</div>}
        {list?.map((b, i) => (
          <div key={b.name} className={'set-row wrap pj-bk' + (pick === b.name ? ' on' : '')}>
            <div className="grow"><b className="small">{new Date(b.at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</b>
              <div className="small muted">{ago(b.at)} · {size(b.size)}{i === 0 ? ' · the newest' : ''}</div></div>
            {pick === b.name
              ? <div className="pj-bk-choose">
                <button className="btn sm" disabled={!!busy} onClick={restore(b.name, 'copy')} title="This project stays as it is">{busy === b.name + 'copy' ? 'Opening…' : 'Open as a separate project'}</button>
                <button className="btn sm danger" disabled={!!busy} onClick={restore(b.name, 'replace')} title="Canon backs up the project as it is now first">{busy === b.name + 'replace' ? 'Restoring…' : 'Replace this project'}</button>
                <button className="btn sm ghost" onClick={() => setPick('')}>Cancel</button>
              </div>
              : <button className="btn sm ghost" disabled={!!busy} onClick={() => setPick(b.name)}>Restore…</button>}
            {pick === b.name && <p className="small muted pj-bk-note">“Replace” backs up the project as it is now before putting this one in its place, so you can come back. “Separate” opens the backup as its own project and leaves this one untouched.</p>}
          </div>
        ))}
      </div>
    </Group>
    <Group label="Files">
      <p className="small muted">The project is one database file, with its research files and backups in the folder beside it.</p>
      <div className="row">
        <button className="btn" disabled={!!busy} onClick={json}>Save a JSON copy…</button>
        <button className="btn ghost" onClick={exportFile}>Export as a project file…</button>
        {info && <button className="btn ghost" onClick={() => reveal(info.db)}>{finder}</button>}
      </div>
      {info && <p className="small faint mono pj-path">{info.projectDir}</p>}
    </Group>
  </>
}
