// Export (Settings › Export): pick what goes in, pick what you're making, adjust only if you want to. Book details
// (Settings › Book details): the front and back matter, cover and metadata an export uses. And printing (File › Print).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { project, stories, treeOf, update, get, researchOf, allScenes, sectionNumber, words, showToast, type State, type TreeNode, type Section, type BookInfo } from '../store.ts'
import {
  PRESETS, FILE_LABEL, TRIMS, PAGES, FONTS, optsFor, lastPreset, rememberOpts, defaultsFor, scenesFor, chosen, exportBook, printBook, suggestedCopyright,
  type Preset, type ExportOpts, type Numbering,
} from '../compile.ts'
import { SettingsGroup as Group, Area, Icon, savedToast, openSettings, closeSettings, useSettingsSection, go } from '../ui.tsx'
import './export.css'

const n = (x: number) => x.toLocaleString()
const plural = (k: number, one: string) => `${n(k)} ${k === 1 ? one : one + 's'}`
const msg = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, '')
const fileUrl = (file: string) => '/api/files?name=' + encodeURIComponent(file)

// ---------------- an export asked for elsewhere (a ⋯ menu, the text view) ----------------

let pending: string[] | null = null
const subs = new Set<() => void>()
const setPending = (ids: string[] | null) => { pending = ids; subs.forEach(f => f()) }
const usePending = () => useSyncExternalStore(f => (subs.add(f), () => subs.delete(f)), () => pending)

/** Open Export with these stories, sections or scenes chosen (from a ⋯ menu anywhere). */
export function exportSelection(ids: string[]) { dispatchEvent(new CustomEvent('canon:command', { detail: 'export:' + ids.join(','), cancelable: true })) }

/** What the current screen shows, for Print: a scene, a story, a part or chapter, or (elsewhere) everything. */
function routeIds(s: State): string[] {
  const [view, id] = location.hash.slice(1).split('/')
  return (view === 'scene' || view === 'text' || view === 'story') && id && s.recs[id] ? [id] : []
}

/** Always mounted: handles Print, and export requests from other screens. */
export function ExportHost({ s }: { s: State }) {
  const cur = useRef(s)
  cur.current = s
  const section = useSettingsSection()
  useEffect(() => { if (section !== 'export' && pending) setPending(null) }, [section]) // a chosen selection lasts until Export closes
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<string>).detail
      if (d === 'print') { e.preventDefault(); printBook(cur.current, routeIds(cur.current)).catch(err => showToast(msg(err))) }
      else if (typeof d === 'string' && d.startsWith('export:')) { e.preventDefault(); setPending(d.slice(7).split(',').filter(Boolean)); openSettings('export') }
    }
    addEventListener('canon:command', on)
    return () => removeEventListener('canon:command', on)
  }, [])
  return null
}

// ---------------- what goes in: the manuscript as a tree of checkboxes ----------------

interface Pick { id: string; label: string; scene?: boolean; out: boolean; words: number; kids: Pick[] }
/** "Chapter 3: The Ledger", or just "Chapter 3" when the title only repeats the number. */
const secName = (s: State, x: Section) => {
  const num = `${x.type === 'part' ? 'Part' : 'Chapter'} ${sectionNumber(s, x.id)}`, t = x.title.trim()
  return t && !/^(part|chapter)\s+\d+$/i.test(t) ? `${num}: ${t}` : num
}
function picksOf(s: State): Pick[] {
  const node = (t: TreeNode, id: string, label: string, out: boolean): Pick => {
    const kids: Pick[] = [
      ...t.scenes.map(sc => ({ id: sc.id, label: sc.title.trim() || 'Untitled scene', scene: true, out: out || !!sc.exclude, words: out || sc.exclude ? 0 : words(sc.prose), kids: [] })),
      ...t.kids.map(k => node(k, k.sec!.id, secName(s, k.sec!), out || !!k.sec!.exclude)),
    ]
    return { id, label, out, words: kids.reduce((w, k) => w + k.words, 0), kids }
  }
  const all = stories(s).map(st => node(treeOf(s, st.id), st.id, st.title || 'Untitled story', false))
  return all.length === 1 ? all[0].kids : all // one story: its parts and chapters are the top level
}
const below = (p: Pick): string[] => p.kids.flatMap(k => [k.id, ...below(k)])
function pathTo(items: Pick[], id: string): Pick[] | undefined {
  for (const p of items) { if (p.id === id) return [p]; const sub = pathTo(p.kids, id); if (sub) return [p, ...sub] }
}
/** Tick or untick one item. Unticking something inside a ticked chapter (or part, or story) keeps the rest of it. */
function toggle(roots: Pick[], ids: string[], p: Pick): string[] {
  const set = new Set(ids), path = pathTo(roots, p.id) || [p]
  below(p).forEach(id => set.delete(id))
  const at = path.findIndex(x => set.has(x.id))
  if (at < 0) set.add(p.id)
  else for (let i = at; i < path.length - 1; i++) { set.delete(path[i].id); path[i].kids.forEach(k => { if (k.id !== path[i + 1].id) set.add(k.id) }) }
  if (at === path.length - 1) set.delete(p.id)
  return [...set]
}

function PickTree({ s, ids, onChange }: { s: State; ids: string[]; onChange: (ids: string[]) => void }) {
  const roots = useMemo(() => picksOf(s), [s])
  const set = new Set(ids)
  const [open, setOpen] = useState(() => new Set([...ids.flatMap(id => (pathTo(roots, id) || []).slice(0, -1).map(x => x.id)), ...(roots.length < 6 ? roots.filter(r => !r.scene && r.kids.some(k => !k.scene)).map(r => r.id) : [])]))
  const flip = (id: string) => setOpen(o => { const x = new Set(o); if (x.has(id)) x.delete(id); else x.add(id); return x })
  const rows: ReactNode[] = []
  const walk = (items: Pick[], depth: number, on: boolean) => {
    for (const p of items) {
      const checked = on || set.has(p.id), some = !checked && below(p).some(id => set.has(id)), isOpen = open.has(p.id)
      rows.push(
        <div key={p.id} className={'ex-row' + (p.scene ? ' scene' : '') + (p.out ? ' out' : '')} style={{ paddingLeft: 10 + depth * 20 }}>
          {p.kids.length ? <button className="ex-tw" aria-label={(isOpen ? 'Hide' : 'Show') + ' what’s in ' + p.label} aria-expanded={isOpen} onClick={() => flip(p.id)}><Icon name={isOpen ? 'down' : 'chevron'} size={12} /></button> : <span className="ex-tw" />}
          <label className="ex-lbl"><input type="checkbox" checked={checked} ref={el => { if (el) el.indeterminate = some }} onChange={() => onChange(toggle(roots, ids, p))} />
            <span className="clip">{p.label}</span></label>
          {p.out && <span className="ex-tag" title="Marked “Leave out of export”">left out</span>}
          <span className="ex-w">{p.words ? n(p.words) : ''}</span>
        </div>,
      )
      if (isOpen) walk(p.kids, depth + 1, checked)
    }
  }
  walk(roots, 0, false)
  return <div className="set-box ex-tree" role="group" aria-label="What to export">{rows.length ? rows : <p className="set-row small muted">Nothing written yet.</p>}</div>
}

// ---------------- what you're making ----------------

/** A small picture of each kind of output. */
function Thumb({ id }: { id: Preset }) {
  const lines = (x: number, y: number, w: number, k: number, gap: number) => Array.from({ length: k }, (_, i) => <path key={i} d={`M${x} ${y + i * gap}h${i === k - 1 ? w * 0.6 : w}`} />)
  return (
    <svg width="36" height="40" viewBox="0 0 36 40" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
      {id === 'manuscript' && <><rect x="5" y="2" width="26" height="36" rx="2" /><path d="M20 6h7" strokeWidth="1" />{lines(9, 12, 18, 6, 4.4)}</>}
      {id === 'paperback' && <><path d="M18 7v29M18 7c-3-2-8-3-14-2v29c6-1 11 0 14 2 3-2 8-3 14-2V5c-6-1-11 0-14 2Z" />{lines(7, 12, 8, 5, 4)}{lines(21, 12, 8, 5, 4)}</>}
      {id === 'ebook' && <><rect x="7" y="2" width="22" height="36" rx="4" /><path d="M16 34h4" />{lines(11, 9, 14, 5, 4.4)}</>}
      {id === 'reading' && <><rect x="5" y="2" width="26" height="36" rx="2" /><path d="M14 8h8" strokeWidth="1.6" />{lines(9, 15, 18, 5, 3.6)}</>}
      {id === 'markdown' && <><rect x="3" y="9" width="30" height="22" rx="3" /><path d="M8 25v-10l4 5 4-5v10M24 15v10m-3-3 3 3 3-3" /></>}
      {id === 'text' && <><rect x="5" y="2" width="26" height="36" rx="2" />{lines(9, 9, 18, 7, 3.8)}</>}
    </svg>
  )
}

const NUMBERING: [Numbering, (k: string) => string][] = [['word', k => `${k} One`], ['number', k => `${k} 1`], ['bare-word', () => 'One'], ['bare-number', () => '1'], ['none', () => 'No number']]
const LANGUAGES: [string, string][] = [['en', 'English'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['nl', 'Dutch'], ['pt', 'Portuguese'], ['sv', 'Swedish'], ['da', 'Danish'], ['nb', 'Norwegian'], ['fi', 'Finnish'], ['pl', 'Polish'], ['ja', 'Japanese'], ['zh', 'Chinese']]
const ABOUT: Record<Preset, string> = {
  manuscript: 'Standard manuscript format: Times New Roman 12 pt, double spaced, one-inch margins, your surname, title and the page number at the top of every page, each chapter on a new page.',
  paperback: 'Mirrored margins, running heads (your name on left pages, the title on right ones) and page numbers, each chapter on a new page. Upload it at the same trim size to KDP Print or IngramSpark.',
  ebook: 'EPUB 3 with a linked contents, footnotes as endnotes, and the details from Book details. It opens in Apple Books, Kobo and Google Play Books, and Kindle Direct Publishing takes it as it is.',
  reading: 'Generous margins, page numbers and each chapter on a new page.',
  markdown: 'Italics as *text*, bold as **text**, headings with #, footnotes as [^1]. The book details are left out.',
  text: 'No formatting at all: italics and bold are dropped, and footnotes become numbered notes after each chapter.',
}
const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="ex-opt"><span className="lbl">{label}</span><div className="row">{children}</div></div>
function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return <div className="seg" role="radiogroup" aria-label={label}>{options.map(([v, t]) => <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{t}</button>)}</div>
}
const bookLink = <button className="link" onClick={() => openSettings('book')}>Book details</button>

export function ExportSection({ s }: { s: State }) {
  const asked = usePending()
  const book = project(s).book || {}
  const multi = stories(s).length > 1
  const [preset, setPreset] = useState<Preset>(() => lastPreset(s))
  const [edits, setEdits] = useState<Partial<Record<Preset, ExportOpts>>>({})
  const o = edits[preset] || optsFor(s, preset)
  const set = (p: Partial<ExportOpts>) => setEdits(e => ({ ...e, [preset]: { ...o, ...p } }))
  const [some, setSome] = useState(!!asked?.length)
  const [ids, setIds] = useState<string[]>(asked || [])
  useEffect(() => { if (asked) { setIds(asked); setSome(asked.length > 0) } }, [asked])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const pick = some ? ids : []
  const scs = scenesFor(s, pick)
  const total = scs.reduce((k, sc) => k + words(sc.prose), 0)
  const inPick = chosen(s, pick)
  const skipped = allScenes(s).filter(sc => inPick(sc) && sc.prose.trim()).length - scs.length
  const empty = allScenes(s).filter(sc => inPick(sc) && !sc.prose.trim()).length
  const meta = PRESETS.find(p => p.id === preset)!
  const cover = book.cover ? get(s, book.cover, 'research') : undefined
  const pdf = preset === 'paperback' || preset === 'reading'
  const run = () => {
    setErr(''); setBusy(true)
    exportBook(s, pick, o).then(path => { if (path) { rememberOpts(o); savedToast(path) } }, e => setErr(msg(e))).finally(() => setBusy(false))
  }
  const check = (k: keyof ExportOpts, label: string, empty?: boolean) => (
    <label className={'row nowrap' + (empty ? ' faint' : '')} title={empty ? 'Nothing written for it yet: add it in Book details' : undefined}>
      <input type="checkbox" checked={!!o[k] && !empty} disabled={empty} onChange={e => set({ [k]: e.target.checked })} />{label}</label>
  )
  const font = <><select className="f set-sel" aria-label="Font" value={o.font} onChange={e => set({ font: e.target.value })}>{FONTS.map(f => <option key={f}>{f}</option>)}</select>
    <input className="f set-num" type="number" min={8} max={16} step={0.5} aria-label="Font size in points" value={o.size} onChange={e => set({ size: Math.min(16, Math.max(8, Number(e.target.value) || o.size)) })} /><span className="small muted">pt</span></>

  return (
    <>
      <Group label="What to export" aside={<Seg label="What to export" value={some ? 'some' : 'all'} options={[['all', 'Everything'], ['some', 'Choose…']]} onChange={v => setSome(v === 'some')} />}>
        {some && <PickTree s={s} ids={ids} onChange={setIds} />}
        <p className="small muted">{scs.length ? `${plural(scs.length, 'scene')}, ${plural(total, 'word')}` : some && !ids.length ? 'Tick what to export.' : 'No scene has any text yet.'}
          {skipped > 0 && ` · ${plural(skipped, 'scene')} marked “Leave out of export” ${skipped === 1 ? 'is' : 'are'} skipped`}
          {scs.length > 0 && empty > 0 && ` · ${plural(empty, 'empty scene')} left out until ${empty === 1 ? 'it has' : 'they have'} text`}</p>
      </Group>

      <Group label="Make">
        <div className="ex-presets" role="radiogroup" aria-label="What to make">
          {PRESETS.map(p => (
            <button key={p.id} role="radio" aria-checked={p.id === preset} aria-label={p.label} aria-describedby={'ex-h-' + p.id} className="ex-card" onClick={() => setPreset(p.id)}>
              <Thumb id={p.id} /><b>{p.label}</b><span id={'ex-h-' + p.id}>{p.hint}</span>
            </button>
          ))}
        </div>
      </Group>

      <Group label={meta.label}>
        <div className="set-box pad ex-opts">
          <p className="small muted">{ABOUT[preset]}</p>
          {preset === 'manuscript' && <>
            <Row label="File"><Seg label="File type" value={o.file} options={[['docx', 'Word (.docx)'], ['rtf', 'RTF']]} onChange={file => set({ file })} /></Row>
            <Row label="Paper"><Seg label="Paper size" value={o.paper} options={[['letter', 'US Letter'], ['a4', 'A4']]} onChange={paper => set({ paper })} /></Row>
            <label className="field"><span className="lbl">Contact details</span>
              <textarea className="f grow-area" rows={3} value={o.contact} placeholder={`${project(s).author || 'Your name'}\nAddress\nEmail · phone`} onChange={e => set({ contact: e.target.value })} />
              <span className="hint">Top left of the title page; the word count ({n(Math.round(total / 1000) * 1000 || total)}) goes top right.</span></label>
          </>}
          {preset === 'paperback' && <>
            <Row label="Trim size"><select className="f set-sel" aria-label="Trim size" value={o.trim} onChange={e => set({ trim: e.target.value as ExportOpts['trim'] })}>
              {Object.entries(TRIMS).map(([k, [w, h]]) => <option key={k} value={k}>{w} × {h} in</option>)}</select></Row>
            <Row label="Type">{font}</Row>
          </>}
          {preset === 'reading' && <>
            <Row label="Page"><Seg label="Page size" value={o.page} options={Object.entries(PAGES) as [ExportOpts['page'], string][]} onChange={page => set({ page })} /></Row>
            <Row label="Type">{font}</Row>
          </>}
          {preset === 'ebook' && <>
            <Row label="Cover">{cover?.file ? <><img className="ex-cover" src={fileUrl(cover.file)} alt="" /><span className="clip">{cover.title}</span><button className="link" onClick={() => openSettings('book')}>Change</button></>
              : <span className="small muted">None yet. Choose an image in {bookLink}.</span>}</Row>
            <Row label="Details"><span className="small muted clip">{[LANGUAGES.find(l => l[0] === (book.language || 'en'))?.[1] || book.language, book.publisher, book.isbn && 'ISBN ' + book.isbn, book.series && `${book.series}${book.seriesIndex ? ' #' + book.seriesIndex : ''}`].filter(Boolean).join(' · ')}</span>
              <button className="link" onClick={() => openSettings('book')}>Edit</button></Row>
          </>}
        </div>
        <details className="disclosure ex-more">
          <summary>More options</summary>
          <div className="set-box pad ex-opts">
            <Row label="Chapters"><select className="f set-sel" aria-label="Chapter headings" value={o.chapters} onChange={e => set({ chapters: e.target.value as Numbering })}>{NUMBERING.map(([v, t]) => <option key={v} value={v}>{t('Chapter')}</option>)}</select>
              {check('chapterTitles', 'and their titles')}</Row>
            <Row label="Parts"><select className="f set-sel" aria-label="Part headings" value={o.parts} onChange={e => set({ parts: e.target.value as Numbering })}>{NUMBERING.map(([v, t]) => <option key={v} value={v}>{t('Part')}</option>)}</select></Row>
            {multi && <Row label="Stories">{check('storyTitles', 'Start each story with its title')}</Row>}
            <Row label="Between scenes">
              <input className="f ex-break" value={o.breakText} disabled={o.sceneTitles} aria-label="Scene break" onChange={e => set({ breakText: e.target.value })} />
              {check('sceneTitles', 'Scene titles instead')}</Row>
            <Row label="Front matter">{check('titlePage', 'Title page')}{pdf || preset === 'ebook' ? check('copyright', 'Copyright') : null}
              {check('dedication', 'Dedication', !book.dedication?.trim())}{check('epigraph', 'Epigraph', !book.epigraph?.trim())}{preset !== 'manuscript' && preset !== 'markdown' && preset !== 'text' && check('contents', 'Contents')}</Row>
            <Row label="Back matter">{check('acknowledgements', 'Acknowledgements', !book.acknowledgements?.trim())}{check('about', 'About the author', !book.about?.trim())}</Row>
            <div className="row"><span className="small muted grow">The text of these is in {bookLink}.</span><button className="btn sm ghost" onClick={() => setEdits(e => ({ ...e, [preset]: { ...defaultsFor(preset), contact: o.contact } }))}>Reset to defaults</button></div>
          </div>
        </details>
      </Group>

      <div className="ex-foot">
        <button className="btn pri" disabled={busy || !scs.length} onClick={run}>{busy ? 'Exporting…' : 'Export…'}</button>
        <span className="small muted">{FILE_LABEL[o.file]}{preset === 'paperback' ? `, ${TRIMS[o.trim].join(' × ')} in` : preset === 'reading' ? `, ${PAGES[o.page]}` : ''}{some && ids.length ? ' · only what’s ticked' : ''}</span>
        {err && <div className="err">{err}</div>}
      </div>
    </>
  )
}

// ---------------- book details ----------------

/** Settings › Book details: subtitle, series, front and back matter, cover, metadata (project.book). */
export function BookSection({ s }: { s: State }) {
  const p = project(s), b = p.book || {}
  const edit = <K extends keyof BookInfo>(k: K, v: BookInfo[K] | '') => update<'project'>('project', x => {
    const next: BookInfo = { ...x.book }
    if (v === '' || v === undefined) delete next[k]; else next[k] = v as BookInfo[K]
    x.book = next
  })
  const text = (k: 'subtitle' | 'series' | 'publisher' | 'isbn' | 'description' | 'copyright' | 'dedication' | 'epigraph' | 'acknowledgements' | 'about') => ({ value: b[k] || '', onChange: (v: string) => edit(k, v) })
  const images = researchOf(s).filter(r => r.type === 'image' && r.file)
  const lang = b.language || 'en'
  return (
    <>
      <Group label="Title">
        <div className="set-box pad stack">
          <Area label="Subtitle" single placeholder="A Novel" {...text('subtitle')} />
          <div className="row" style={{ alignItems: 'start' }}>
            <div style={{ flex: '3 1 220px' }}><Area label="Series" single placeholder="The series this book belongs to" {...text('series')} /></div>
            <label className="field" style={{ flex: '1 1 100px' }}><span className="lbl">Book number</span>
              <input className="f" type="number" min={1} value={b.seriesIndex ?? ''} placeholder="1" onChange={e => edit('seriesIndex', e.target.value ? Number(e.target.value) : '')} /></label>
          </div>
          <p className="small muted">The title and author are in <button className="link" onClick={() => openSettings('details')}>Details</button>.</p>
        </div>
      </Group>
      <Group label="Cover">
        {images.length ? <div className="ex-covers" role="radiogroup" aria-label="Cover image">
          <button role="radio" aria-checked={!b.cover} className="ex-cv none" onClick={() => edit('cover', '')}><span>No cover</span></button>
          {images.map(r => <CoverTile key={r.id} file={r.file!} title={r.title} on={b.cover === r.id} onPick={() => edit('cover', r.id)} />)}
        </div> : <div className="set-box pad ex-empty"><Icon name="image" /><span className="small muted">Add the cover image to Research, then choose it here. Ebook stores ask for a JPEG about 1600 × 2560 pixels.</span>
          <button className="btn sm" onClick={() => { closeSettings(); go('research') }}>Open Research</button></div>}
      </Group>
      <Group label="Front matter">
        <div className="set-box pad stack">
          <Area label="Copyright" rows={2} placeholder={suggestedCopyright(s) + '\nAll rights reserved.'} {...text('copyright')} />
          <Area label="Dedication" rows={2} placeholder="For …" {...text('dedication')} />
          <Area label="Epigraph" rows={2} placeholder={'> A quotation\n— Who said it'} {...text('epigraph')} />
        </div>
      </Group>
      <Group label="Back matter">
        <div className="set-box pad stack">
          <Area label="Acknowledgements" rows={3} {...text('acknowledgements')} />
          <Area label="About the author" rows={3} {...text('about')} />
          <p className="small muted">Write these as you write scenes: *italics*, one paragraph per line. Empty ones are left out; choose which go in each export under Export › More options.</p>
        </div>
      </Group>
      <Group label="For ebook stores and catalogues">
        <div className="set-box pad stack">
          <div className="row" style={{ alignItems: 'start' }}>
            <div style={{ flex: '2 1 200px' }}><Area label="Publisher" single placeholder="Your imprint, if you have one" {...text('publisher')} /></div>
            <div style={{ flex: '1 1 160px' }}><Area label="ISBN" single placeholder="978…" {...text('isbn')} /></div>
            <label className="field" style={{ flex: '1 1 140px' }}><span className="lbl">Language</span>
              <select className="f" value={lang} onChange={e => edit('language', e.target.value === 'en' ? '' : e.target.value)}>
                {!LANGUAGES.some(l => l[0] === lang) && <option value={lang}>{lang}</option>}
                {LANGUAGES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
          </div>
          <Area label="Description" rows={3} placeholder="The blurb readers see in the store" {...text('description')} />
        </div>
      </Group>
    </>
  )
}

function CoverTile({ file, title, on, onPick }: { file: string; title: string; on: boolean; onPick: () => void }) {
  const [size, setSize] = useState<[number, number]>()
  const small = size && (size[0] < 1000 || size[1] < 1500)
  return (
    <button role="radio" aria-checked={on} className="ex-cv" onClick={onPick} title={title}>
      <img src={fileUrl(file)} alt="" onLoad={e => setSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])} />
      <span className="clip">{title}</span>
      {size && <span className={'ex-px' + (small ? ' warn' : '')} title={small ? 'Smaller than ebook stores ask for (about 1600 × 2560)' : undefined}>{size[0]} × {size[1]}</span>}
    </button>
  )
}
