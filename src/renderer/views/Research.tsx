// Research: what the book is built on, kept beside it (#research, #research/<id>): PDFs, images, recordings, web pages and notes.
// Files are copied into the project (main/research.ts) so the project stays whole; each item can be linked to the
// characters, places, chapters and scenes it is about, and opened beside the text in the reference pane.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { create, update, remove, tx, get, getState, list, nameOf, researchOf, newResearch, showToast, type State, type Research, type ResearchType } from '../store.ts'
import { Bar, Icon, Popover, go, openReference, ago, isMac, stored, store } from '../ui.tsx'
import { RecordPicker, hrefOf } from './shared.tsx'
import { PinButton, kindIcon } from './Pinned.tsx'
import './research.css'

export const fileUrl = (file: string) => '/api/files?name=' + encodeURIComponent(file)
const TYPE: Record<ResearchType, { label: string; icon: string }> = {
  pdf: { label: 'PDF', icon: 'pdf' }, image: { label: 'Image', icon: 'image' }, web: { label: 'Web page', icon: 'web' }, note: { label: 'Note', icon: 'note' },
  audio: { label: 'Recording', icon: 'audio' }, video: { label: 'Video', icon: 'video' }, file: { label: 'File', icon: 'research' },
}
const FILTERS: { id: string; label: string; has: (t: ResearchType) => boolean }[] = [
  { id: 'all', label: 'All', has: () => true }, { id: 'pdf', label: 'PDFs', has: t => t === 'pdf' }, { id: 'image', label: 'Images', has: t => t === 'image' },
  { id: 'web', label: 'Web', has: t => t === 'web' }, { id: 'note', label: 'Notes', has: t => t === 'note' }, { id: 'media', label: 'Media', has: t => t === 'audio' || t === 'video' || t === 'file' },
]
export const typeOfFile = (mime: string, name: string): ResearchType =>
  mime === 'application/pdf' ? 'pdf' : mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : /\.(txt|md|markdown)$/i.test(name) ? 'note' : 'file'
const sizeLabel = (n?: number) => (n === undefined ? '' : n < 1024 ? `${n} B` : n < 1 << 20 ? `${Math.round(n / 1024)} KB` : `${(n / (1 << 20)).toFixed(n < 10 << 20 ? 1 : 0)} MB`)
const hostOf = (url?: string) => { try { return url ? new URL(url).hostname.replace(/^www\./, '') : '' } catch { return url || '' } }
const stem = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || name
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
const finder = isMac ? 'Show in Finder' : 'Show in folder'

// ---------------- adding things (shared with the entity sheet's Research card) ----------------

type Stored = { file: string; name: string; size: number; mime: string }
async function post<T>(url: string, body?: BodyInit): Promise<T> {
  const r = await fetch(url, { method: 'POST', body })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}
/** One record per stored file (text files become notes), all in one undo step. Returns the new ids. */
function addStored(files: (Stored & { text?: string })[], about: string[]) {
  const ids: string[] = []
  if (!files.length) return ids
  tx(files.length === 1 ? `Add “${stem(files[0].name)}” to Research` : `Add ${files.length} items to Research`, () => {
    for (const f of files) {
      const type = typeOfFile(f.mime, f.name)
      ids.push(create('research', newResearch(type === 'note' && f.text !== undefined
        ? { type, title: stem(f.name), text: f.text, about: [...about] }
        : { type, title: stem(f.name), file: f.file, mime: f.mime, size: f.size, about: [...about] })))
    }
  })
  return ids
}
/** Files dropped, pasted or chosen in the browser: upload each, then add them together. */
export async function addFiles(files: File[], about: string[] = []): Promise<string[]> {
  const out: (Stored & { text?: string })[] = []
  try {
    for (const f of files) {
      if (/\.(txt|md|markdown)$/i.test(f.name) && f.size < 2 << 20) { out.push({ file: '', name: f.name, size: f.size, mime: 'text/plain', text: await f.text() }); continue }
      out.push(await post<Stored>('/api/research/upload?name=' + encodeURIComponent(f.name || 'pasted.png'), f))
    }
  } catch (e) { showToast('Couldn’t add a file: ' + String(e).replace(/^Error: /, '')) }
  return addStored(out, about)
}
/** The native file dialog; files are copied into the project. */
export async function chooseFiles(about: string[] = []): Promise<string[]> {
  try { return addStored(await post<Stored[]>('/api/research/pick'), about) } catch (e) { showToast(String(e).replace(/^Error: /, '')); return [] }
}
async function clipPage(url: string) { return post<{ title: string; text: string; url: string }>('/api/research/clip', JSON.stringify({ url })) }
/** A web page: its address, title and readable text (kept for reading and searching offline). If the page can't be read, the link is kept. */
export async function addWebPage(raw: string, about: string[] = []): Promise<string> {
  const url = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : 'https://' + raw.trim()
  let page: { title: string; text: string; url: string } | undefined, err = ''
  try { page = await clipPage(url) } catch (e) { err = String(e).replace(/^Error: /, '') }
  let id = ''
  tx(`Add web page “${page?.title || hostOf(url)}”`, () => { id = create('research', newResearch({ type: 'web', title: page?.title || hostOf(url), url: page?.url || url, clip: page?.text || undefined, about: [...about] })) }, false)
  showToast(err ? `Saved the link. Couldn’t read the page: ${err}` : 'Added to Research', true)
  return id
}
export function addNote(about: string[] = []) {
  let id = ''
  tx('New research note', () => { id = create('research', newResearch({ type: 'note', title: 'Untitled note', about: [...about] })) }, false)
  return id
}
const reveal = (file: string) => fetch('/api/research/reveal', { method: 'POST', body: JSON.stringify({ file }) })
const openUrl = (url: string) => fetch('/api/open', { method: 'POST', body: JSON.stringify({ url }) })

/** Drag files (or a link from a browser) onto an element to add them; `on` while something is over it. */
function useDrop(onFiles: (fs: File[]) => void, onUrl?: (url: string) => void) {
  const [on, setOn] = useState(false)
  const depth = useRef(0)
  const accepts = (e: React.DragEvent) => [...e.dataTransfer.types].some(t => t === 'Files' || (onUrl && t === 'text/uri-list'))
  return {
    on,
    props: {
      onDragEnter: (e: React.DragEvent) => { if (accepts(e)) { depth.current++; setOn(true) } },
      onDragOver: (e: React.DragEvent) => { if (accepts(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } },
      onDragLeave: () => { if (--depth.current <= 0) { depth.current = 0; setOn(false) } },
      onDrop: (e: React.DragEvent) => {
        depth.current = 0; setOn(false)
        const fs = [...e.dataTransfer.files], url = e.dataTransfer.getData('text/uri-list').split('\n').find(l => /^https?:/.test(l))
        if (fs.length) { e.preventDefault(); onFiles(fs) } else if (url && onUrl) { e.preventDefault(); onUrl(url.trim()) }
      },
    },
  }
}

// ---------------- the view ----------------

/** List settings survive moving between items (the view remounts per item). */
const mem = { q: '', filter: 'all', group: stored('canon.research.group', 'recent') }

export function ResearchView({ s, id }: { s: State; id?: string }) {
  const [q, setQ] = useState(mem.q), [filter, setFilter] = useState(mem.filter), [group, setGroup] = useState(mem.group)
  useEffect(() => { mem.q = q; mem.filter = filter; mem.group = group; store('canon.research.group', group) }, [q, filter, group])
  const all = researchOf(s)
  const r = id ? get(s, id, 'research') : undefined
  const add = async (p: Promise<string[] | string>) => { const ids = [await p].flat(); if (ids.length === 1 && ids[0]) go('research/' + ids[0]) }
  const drop = useDrop(fs => add(addFiles(fs)), url => add(addWebPage(url)))
  const onPaste = (e: React.ClipboardEvent) => {
    if ((e.target as Element).closest('input, textarea, [contenteditable]')) return
    const fs = [...e.clipboardData.files], t = e.clipboardData.getData('text').trim()
    if (fs.length) { e.preventDefault(); add(addFiles(fs)) } else if (/^https?:\/\/\S+$/.test(t)) { e.preventDefault(); add(addWebPage(t)) }
  }
  const needle = q.trim().toLowerCase()
  const shown = all.filter(x => FILTERS.find(f => f.id === filter)!.has(x.type) && (!needle || [x.title, x.text, x.clip, x.url, ...x.about.map(a => nameOf(s, a))].some(t => t?.toLowerCase().includes(needle))))
  const counts = Object.fromEntries(FILTERS.map(f => [f.id, all.filter(x => f.has(x.type)).length]))
  const groups: [string, Research[]][] = group === 'subject' ? bySubject(s, shown) : [['', shown]]
  return (
    <>
      <Bar>
        <div className="crumbs grow">{r ? <><a href="#research">Research</a><Icon name="chevron" size={12} /><b className="clip">{r.title || 'Untitled'}</b></> : <b>Research</b>}</div>
        <AddMenu onAdded={ids => ids[0] && go('research/' + ids[0])} />
        <span className="bar-sep" />
      </Bar>
      <div className={'rs' + (drop.on ? ' dropping' : '')} {...drop.props} onPaste={onPaste} tabIndex={-1}>
        <aside className="rs-list" aria-label="Research items">
          <div className="rs-tools">
            <label className="rs-search"><Icon name="find" size={14} /><input value={q} placeholder="Search research" aria-label="Search research" onChange={e => setQ(e.target.value)} /></label>
            <div className="rs-filters">
              {FILTERS.filter(f => f.id === 'all' || counts[f.id] || filter === f.id).map(f => <button key={f.id} className={'chip' + (filter === f.id ? ' on' : '')} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}<span className="faint">{counts[f.id]}</span></button>)}
            </div>
            {all.length > 0 && <div className="seg rs-group"><button className={group === 'recent' ? 'on' : ''} onClick={() => setGroup('recent')}>Newest</button><button className={group === 'subject' ? 'on' : ''} onClick={() => setGroup('subject')}>By subject</button></div>}
          </div>
          <div className="rs-items">
            {groups.map(([g, xs]) => <div key={g || 'all'}>
              {g && <div className="rs-grp">{g}</div>}
              {xs.map(x => <ListRow key={x.id} s={s} r={x} on={x.id === id} />)}
            </div>)}
            {!all.length && <p className="side-hint rs-pad">Nothing here yet.</p>}
            {all.length > 0 && !shown.length && <p className="side-hint rs-pad">Nothing matches. <button className="link" onClick={() => { setQ(''); setFilter('all') }}>Show everything</button></p>}
          </div>
        </aside>
        <section className="rs-detail">{r ? <Item key={r.id} s={s} r={r} /> : <Intro s={s} count={all.length} />}</section>
        {drop.on && <div className="rs-drop"><div><Icon name="import" size={22} /><b>Drop to add to Research</b><span>Files are copied into the project; links become web pages.</span></div></div>}
      </div>
    </>
  )
}

/** Grouped by the first record each item is about; unlinked items last. */
function bySubject(s: State, xs: Research[]): [string, Research[]][] {
  const m = new Map<string, Research[]>()
  for (const x of xs) { const k = x.about.map(a => nameOf(s, a)).find(Boolean) || ''; m.set(k, [...(m.get(k) || []), x]) }
  return [...m].sort(([a], [b]) => (!a ? 1 : !b ? -1 : a.localeCompare(b))).map(([k, v]) => [k || 'Not linked yet', v])
}

function ListRow({ s, r, on }: { s: State; r: Research; on: boolean }) {
  const linked = r.about.map(a => nameOf(s, a)).filter(Boolean)
  const meta = [TYPE[r.type].label, r.type === 'web' ? hostOf(r.url) : sizeLabel(r.size), linked.slice(0, 2).join(', ') + (linked.length > 2 ? ` +${linked.length - 2}` : '')].filter(Boolean).join(' · ')
  return (
    <a className={'rs-row' + (on ? ' on' : '')} href={'#research/' + r.id} aria-current={on ? 'page' : undefined} draggable onDragStart={e => e.dataTransfer.setData('text/uri-list', location.href.split('#')[0] + '#research/' + r.id)}>
      <Thumb r={r} />
      <span className="grow" style={{ minWidth: 0 }}><b className="clip">{r.title || 'Untitled'}</b><span className="small muted clip">{meta}</span></span>
    </a>
  )
}

export function Thumb({ r, size = 36 }: { r: Research; size?: number }) {
  return r.type === 'image' && r.file
    ? <img className="rs-thumb" src={fileUrl(r.file)} alt="" width={size} height={size} loading="lazy" />
    : <span className={'rs-thumb ' + r.type} style={{ width: size, height: size }}><Icon name={TYPE[r.type].icon} size={Math.round(size * .45)} /></span>
}

function AddMenu({ onAdded, about = [], label = 'Add', className = 'btn sm' }: { onAdded?: (ids: string[]) => void; about?: string[]; label?: string; className?: string }) {
  const [url, setUrl] = useState<string>()
  const [busy, setBusy] = useState(false)
  const web = async (close: () => void) => { if (!url?.trim()) return; setBusy(true); const id = await addWebPage(url, about); setBusy(false); setUrl(undefined); close(); onAdded?.([id]) }
  return (
    <Popover className="right" trigger={o => <button className={className} onClick={() => { setUrl(undefined); o() }}><Icon name="plus" size={13} />{label}</button>}>{close => url === undefined ? <>
      <button className="menu-item" onClick={async () => { close(); onAdded?.(await chooseFiles(about)) }}><Icon name="import" size={14} />Files…<span className="grow" /><span className="small faint">PDF, images, audio, video</span></button>
      <button className="menu-item" onClick={() => setUrl('')}><Icon name="web" size={14} />Web page…</button>
      <button className="menu-item" onClick={() => { close(); onAdded?.([addNote(about)]) }}><Icon name="note" size={14} />Note</button>
      <div className="menu-sep" />
      <p className="small faint" style={{ padding: '4px 10px 6px' }}>Or drop files here, or paste an image or a link.</p>
    </> : <div className="stack" style={{ gap: 8, width: 320, padding: 6 }}>
      <b>Add a web page</b>
      <input className="f" autoFocus value={url} placeholder="https://…" aria-label="Web address" onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') web(close) }} />
      <p className="small muted">Canon keeps the page’s title and readable text, so you can read and search it offline.</p>
      <div className="row"><span className="grow" /><button className="btn sm ghost" onClick={() => setUrl(undefined)}>Back</button><button className="btn sm pri" disabled={!url.trim() || busy} onClick={() => web(close)}>{busy ? 'Reading the page…' : 'Add'}</button></div>
    </div>}</Popover>
  )
}

function Intro({ s, count }: { s: State; count: number }) {
  const linked = list(s, 'entity').filter(e => researchOf(s, e.id).length).length
  return (
    <div className="empty rs-intro">
      <Icon name="research" size={28} />
      <h2>{count ? 'Pick something to read' : 'Keep what the book is built on beside it'}</h2>
      <p>{count ? `${plural(count, 'item')} in Research${linked ? `, linked to ${plural(linked, 'sheet')} in World` : ''}. Open one here, or beside your text with the reference pane.`
        : 'PDFs, photographs, maps, recordings, web pages and notes. Link each to the characters, places and scenes it’s about, then open it beside the text while you write.'}</p>
      {!count && <div className="row" style={{ justifyContent: 'center' }}>
        <button className="btn" onClick={async () => { const ids = await chooseFiles(); if (ids[0]) go('research/' + ids[0]) }}><Icon name="import" size={14} />Add files…</button>
        <button className="btn" onClick={() => go('research/' + addNote())}><Icon name="note" size={14} />New note</button>
      </div>}
      <p className="small faint">Drop files anywhere on this page, or paste an image or a link.</p>
    </div>
  )
}

// ---------------- one item ----------------

function Item({ s, r }: { s: State; r: Research }) {
  const edit = (fn: (x: Research) => void) => update<'research'>(r.id, fn)
  const [busy, setBusy] = useState(false)
  const reclip = async () => {
    if (!r.url) return
    setBusy(true)
    try { const p = await clipPage(r.url); tx('Clip the page again', () => edit(x => { x.clip = p.text || undefined; if (!x.title || x.title === hostOf(x.url)) x.title = p.title })) }
    catch (e) { showToast('Couldn’t read the page: ' + String(e).replace(/^Error: /, '')) }
    setBusy(false)
  }
  const del = () => { tx(`Delete “${r.title || 'Untitled'}” from Research`, () => remove(r.id)); go('research') }
  const meta = [TYPE[r.type].label, sizeLabel(r.size), `added ${ago(r.at)}`].filter(Boolean)
  return (
    <div className="rs-item">
      <div className="rs-head">
        <Thumb r={r} size={44} />
        <div className="grow stack" style={{ gap: 2 }}>
          <input className="rs-title" value={r.title} placeholder="Untitled" aria-label="Title" autoFocus={r.title === 'Untitled note'} onFocus={e => { if (r.title === 'Untitled note') e.target.select() }} onChange={e => edit(x => { x.title = e.target.value })} />
          <div className="row small muted" style={{ gap: 6 }}>{meta.join(' · ')}{r.url && <> · <button className="link" onClick={() => openUrl(r.url!)}>{hostOf(r.url)}</button></>}</div>
        </div>
      </div>
      <div className="row rs-actions">
        <button className="btn sm" title="Open in the reference pane, beside whatever you’re writing" onClick={() => openReference(r.id)}><Icon name="split" size={14} />Open beside the text</button>
        <PinButton s={s} id={r.id} />
        {r.file && <button className="btn sm ghost" onClick={() => reveal(r.file!)}>{finder}</button>}
        {r.url && <button className="btn sm ghost" onClick={() => openUrl(r.url!)}><Icon name="external" size={13} />Open in browser</button>}
        {r.type === 'web' && <button className="btn sm ghost" disabled={busy} onClick={reclip}>{busy ? 'Reading…' : r.clip ? 'Clip again' : 'Clip the text'}</button>}
        <span className="grow" />
        <button className="btn sm ghost danger" onClick={del}><Icon name="trash" size={13} />Delete</button>
      </div>
      <About s={s} r={r} />
      {r.type === 'note'
        ? <textarea className="rs-note serif" value={r.text} placeholder="Write the note: an interview, a fact to check, a scrap of research…" aria-label="Note" onChange={e => edit(x => { x.text = e.target.value })} />
        : <>
          <Viewer r={r} onClip={reclip} busy={busy} />
          <label className="field rs-notes"><span className="lbl">Your notes</span>
            <textarea className="f" value={r.text} placeholder="What this is, why it matters, what to use from it" onChange={e => edit(x => { x.text = e.target.value })} /></label>
        </>}
    </div>
  )
}

function About({ s, r, readOnly }: { s: State; r: Research; readOnly?: boolean }) {
  const ids = r.about.filter(a => s.recs[a])
  const link = (a: string) => tx(`Link to ${nameOf(s, a)}`, () => update<'research'>(r.id, x => { x.about = [...x.about, a] }), false)
  const unlink = (a: string) => tx(`Unlink from ${nameOf(s, a)}`, () => update<'research'>(r.id, x => { x.about = x.about.filter(y => y !== a) }), false)
  if (readOnly && !ids.length) return null
  return (
    <div className="row rs-about">
      <span className="lbl">About</span>
      {ids.map(a => <span key={a} className="chip"><a href={'#' + hrefOf(s, a)} className="row nowrap" style={{ gap: 4, textDecoration: 'none' }}><Icon name={kindIcon(s, a)} size={12} />{nameOf(s, a)}</a>{!readOnly && <button className="x" aria-label={`Unlink ${nameOf(s, a)}`} onClick={() => unlink(a)}>×</button>}</span>)}
      {!readOnly && <RecordPicker s={s} kinds={['entity', 'scene', 'section', 'story', 'fact']} exclude={ids} label={ids.length ? '+ Link' : '+ Link to a character, place or scene'} onPick={link} />}
    </div>
  )
}

/** The thing itself: a PDF in Chromium's viewer, an image, a player, a page's text, a note. */
function Viewer({ r, compact, onClip, busy }: { r: Research; compact?: boolean; onClip?: () => void; busy?: boolean }) {
  const [zoom, setZoom] = useState(false)
  if (r.type === 'note') return <div className="rs-clip serif selectable">{paras(r.text, 'An empty note.')}</div>
  if (r.type === 'web') return r.clip ? <div className={'rs-clip serif selectable' + (compact ? ' compact' : '')}>{paras(r.clip)}</div>
    : <div className="rs-none"><Icon name="web" size={20} /><p>Only the link is saved{r.url ? <>: <span className="mono">{r.url}</span></> : ''}.</p>{onClip && <button className="btn sm" disabled={busy} onClick={onClip}>{busy ? 'Reading the page…' : 'Clip the page’s text'}</button>}</div>
  if (!r.file) return <div className="rs-none"><p>The file is missing.</p></div>
  const src = fileUrl(r.file)
  if (r.type === 'pdf') return <iframe className={'rs-pdf' + (compact ? ' compact' : '')} src={src} title={r.title} />
  if (r.type === 'image') return <div className={'rs-img' + (zoom ? ' zoom' : '') + (compact ? ' compact' : '')} onClick={() => setZoom(z => !z)} title={zoom ? 'Click to fit' : 'Click to see it full size'}><img src={src} alt={r.title} /></div>
  if (r.type === 'audio') return <audio className="rs-audio" controls preload="metadata" src={src} />
  if (r.type === 'video') return <video className="rs-video" controls preload="metadata" src={src} />
  return <div className="rs-none"><Icon name="research" size={20} /><p>Canon can’t show this kind of file. Open it from {isMac ? 'Finder' : 'its folder'}.</p><button className="btn sm" onClick={() => reveal(r.file!)}>{finder}</button></div>
}
const paras = (t: string, empty = ''): ReactNode => t.trim() ? t.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>) : <p className="muted">{empty}</p>

/** One research item, compact and read-only (but notes stay editable): for the reference pane. */
export function ResearchViewer({ s, id }: { s: State; id: string }) {
  const r = get(s, id, 'research')
  if (!r) return <p className="small muted">This item was deleted.</p>
  return (
    <div className="rs-viewer">
      <div className="row nowrap" style={{ gap: 10 }}>
        <Thumb r={r} size={32} />
        <div className="grow" style={{ minWidth: 0 }}><a className="rs-vtitle clip" href={'#research/' + r.id}>{r.title || 'Untitled'}</a>
          <span className="small muted clip" style={{ display: 'block' }}>{[TYPE[r.type].label, r.type === 'web' ? hostOf(r.url) : sizeLabel(r.size)].filter(Boolean).join(' · ')}</span></div>
      </div>
      <About s={s} r={r} readOnly />
      <Viewer r={r} compact />
      {r.type !== 'note' && r.text.trim() && <div className="rs-vnotes"><span className="lbl">Your notes</span><p className="pre selectable">{r.text}</p></div>}
    </div>
  )
}

// ---------------- the Research card on a World sheet ----------------

/** Research items not yet linked to a record, filterable (inline: a popover inside a popover would close its parent). */
function LinkExisting({ s, about, onPick }: { s: State; about: string; onPick: (id: string) => void }) {
  const [q, setQ] = useState('')
  const free = researchOf(s).filter(x => !x.about.includes(about))
  if (!free.length) return null
  const hits = free.filter(x => x.title.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8)
  return <>
    <div className="menu-sep" />
    <div className="stack" style={{ gap: 2, padding: '4px 4px 2px' }}>
      <span className="lbl" style={{ padding: '0 6px' }}>Link something already in Research</span>
      {free.length > 6 && <input className="f" value={q} placeholder="Filter" aria-label="Filter research" onChange={e => setQ(e.target.value)} />}
      {hits.map(x => <button key={x.id} className="menu-item" onClick={() => onPick(x.id)}><Icon name={TYPE[x.type].icon} size={14} /><span className="clip">{x.title || 'Untitled'}</span></button>)}
    </div>
  </>
}

/** The first image linked to a record: a character's photograph, a place's map. */
export const pictureOf = (s: State, about: string) => researchOf(s, about).filter(r => r.type === 'image' && r.file).at(-1)
/** A sheet's picture: its first linked image, or `fallback` (the initial). */
export function Picture({ s, about, fallback }: { s: State; about: string; fallback: ReactNode }) {
  const p = pictureOf(s, about)
  return p ? <a href={'#research/' + p.id} title={p.title}><img className="w-pic" src={fileUrl(p.file!)} alt={nameOf(s, about)} /></a> : <>{fallback}</>
}

export function ResearchCard({ s, about }: { s: State; about: string }) {
  const items = researchOf(s, about), imgs = items.filter(r => r.type === 'image' && r.file), rest = items.filter(r => !imgs.includes(r))
  const name = nameOf(s, about), first = name.split(' ')[0]
  const drop = useDrop(fs => { addFiles(fs, [about]) }, url => { addWebPage(url, [about]) })
  const link = (id: string) => tx(`Link to ${name}`, () => update<'research'>(id, x => { x.about = [...x.about, about] }), false)
  return (
    <section className={'w-card rs-card' + (drop.on ? ' dropping' : '')} {...drop.props}>
      <div className="w-ch"><b>Research</b>{items.length > 0 && <span className="lbl">{items.length}</span>}
        <Popover className="right" trigger={o => <button className="btn sm ghost" onClick={o}><Icon name="plus" size={12} />Add</button>}>{close => <>
          <button className="menu-item" onClick={() => { close(); chooseFiles([about]) }}><Icon name="import" size={14} />Files…</button>
          <button className="menu-item" onClick={() => { close(); go('research/' + addNote([about])) }}><Icon name="note" size={14} />A note about {first}</button>
          <LinkExisting s={s} about={about} onPick={id => { close(); link(id) }} />
        </>}</Popover>
      </div>
      {imgs.length > 0 && <div className="rs-thumbs">{imgs.map(r => <a key={r.id} href={'#research/' + r.id} title={r.title}><img src={fileUrl(r.file!)} alt={r.title} loading="lazy" /></a>)}</div>}
      {rest.map(r => <a key={r.id} className="w-rr w-link" href={'#research/' + r.id}><Icon name={TYPE[r.type].icon} size={13} /><span className="clip">{r.title || 'Untitled'}</span></a>)}
      {!items.length && <span className="small muted">Photographs, maps, articles and notes about {first}. Drop files here, or add them.</span>}
    </section>
  )
}
