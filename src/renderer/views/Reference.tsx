// The reference pane: a second document beside the main view (a scene, chapter, character sheet, event or research item),
// to read one thing while you write another. ⌥-click any link to open it here; its width is remembered on this machine.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  get, update, getState, list, nameOf, entities, allScenes, stories, scenesOf, flowOf, contentsOf, chapterOf, partOf, sectionNumber,
  statusOf, typeDef, researchOf, project, words,
  type State, type Scene, type Entity, type Fact, type Section, type Story, type Question,
} from '../store.ts'
import { closeReference, openReference, Icon, go, stored, store } from '../ui.tsx'
import { hrefOf, factCode, kLabel, QuestionCard } from './shared.tsx'
import { ResearchViewer, Thumb, fileUrl } from './Research.tsx'
import { ProseText, ProseField } from './Prose.tsx'
import './reference.css'

const n = (x: number) => x.toLocaleString()
const plural = (k: number, one: string) => `${n(k)} ${k === 1 ? one : one + 's'}`
const W = { min: 300, def: 440 }
const maxW = () => Math.min(900, Math.round(innerWidth * .6))
const clampW = (w: number) => Math.max(W.min, Math.min(maxW(), w))

// ⌥-click a link to a record anywhere in the app: it opens beside, here, instead of replacing the main view.
const ROUTES = new Set(['scene', 'story', 'text', 'world', 'timeline', 'knowledge', 'research', 'questions'])
addEventListener('click', e => {
  if (!e.altKey || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
  const a = (e.target as Element | null)?.closest?.('a[href^="#"]')
  const [view, id] = (a?.getAttribute('href') || '').slice(1).split('/')
  if (!ROUTES.has(view) || !id || !getState().recs[id]) return
  e.preventDefault(); e.stopPropagation()
  openReference(id)
}, true)

/** What a record is, in a word or two: "Scene", "Chapter 3", "Character", "E4". */
export function refKind(s: State, id: string): string {
  const r = s.recs[id]
  if (!r) return ''
  if (r.kind === 'section') return `${r.type === 'part' ? 'Part' : 'Chapter'} ${sectionNumber(s, id)}`
  if (r.kind === 'entity') return typeDef(s, r.type).one
  if (r.kind === 'fact') return r.at !== undefined ? 'Event ' + factCode(s, id) : 'Fact'
  return ({ scene: 'Scene', story: 'Story', research: 'Research', question: 'Question' } as Record<string, string>)[r.kind] || ''
}
const titleOf = (s: State, id: string) => { const r = s.recs[id]; return r?.kind === 'fact' ? r.text : nameOf(s, id) || 'Untitled' }

function useHash() {
  const [h, setH] = useState(location.hash.slice(1))
  useEffect(() => { const f = () => setH(location.hash.slice(1)); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  return h.split('/') as [string, string | undefined]
}

export function ReferencePane({ s, id }: { s: State; id: string }) {
  const [w, setW] = useState(() => clampW(Number(stored('canon.ref.w', String(W.def))) || W.def))
  const [picking, setPicking] = useState(false)
  const [view, main] = useHash()
  const drag = useRef<{ x: number; w: number } | null>(null)
  useEffect(() => setPicking(false), [id])
  useEffect(() => { const f = () => setW(x => clampW(x)); addEventListener('resize', f); return () => removeEventListener('resize', f) }, [])
  const rec = id ? s.recs[id] : undefined
  const pick = !id || picking
  const mainId = main && s.recs[main] && main !== id && ROUTES.has(view) ? main : undefined
  return (
    <aside className="ref-pane" aria-label="Reference" style={{ width: w }}
      onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented && !(e.target as HTMLElement).matches('textarea')) { e.preventDefault(); picking && id ? setPicking(false) : closeReference() } }}>
      <div className="ref-grip" role="separator" aria-orientation="vertical" aria-label="Resize the reference pane" title="Drag to resize. Double-click for the default width."
        onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, w } }}
        onPointerMove={e => { if (drag.current) setW(clampW(drag.current.w + drag.current.x - e.clientX)) }}
        onPointerUp={() => { drag.current = null; store('canon.ref.w', String(w)) }}
        onDoubleClick={() => { setW(W.def); store('canon.ref.w', String(W.def)) }} />
      <header className="pagehead ref-head">
        {pick ? <b className="grow">Open beside</b> : <>
          <button className="ref-title grow" title="Show something else here" onClick={() => setPicking(true)}>
            <span className="lbl">{refKind(s, id) || 'Deleted'}</span><b className="clip">{rec ? titleOf(s, id) : 'Not found'}</b><Icon name="down" size={12} />
          </button>
          {mainId && <button className="icon-btn" title={`Swap with ${titleOf(s, mainId)}`} aria-label="Swap with the main view" onClick={() => { go(hrefOf(s, id)); openReference(mainId) }}><Icon name="swap" /></button>}
          {rec && <button className="icon-btn" title="Open in the main view" aria-label="Open in the main view" onClick={() => { go(hrefOf(s, id)); closeReference() }}><Icon name="external" /></button>}
        </>}
        {pick && id && <button className="btn sm ghost" onClick={() => setPicking(false)}>Cancel</button>}
        <button className="icon-btn" title="Close the reference pane" aria-label="Close the reference pane" onClick={closeReference}><Icon name="close" /></button>
      </header>
      <div className="ref-body">
        {pick ? <Picker s={s} view={view} main={main} current={id} />
          : !rec ? <div className="ref-empty"><p>This was deleted, or undone.</p><button className="btn sm" onClick={() => setPicking(true)}>Choose something else</button></div>
            : <Body key={id} s={s} id={id} />}
      </div>
    </aside>
  )
}

function Body({ s, id }: { s: State; id: string }) {
  const r = s.recs[id]
  switch (r?.kind) {
    case 'scene': return <SceneRef s={s} sc={r} />
    case 'section': return <SectionRef s={s} sec={r} />
    case 'story': return <StoryRef s={s} st={r} />
    case 'entity': return <EntityRef s={s} e={r} />
    case 'fact': return <FactRef s={s} f={r} />
    case 'research': return <ResearchViewer s={s} id={id} />
    case 'question': return <QuestionCard s={s} q={r as Question} />
    default: return <p className="small muted">This can’t be shown here.</p>
  }
}

// ---------------- the picker ----------------

interface Opt { id: string; g: string; detail?: string }

function Picker({ s, view, main, current }: { s: State; view: string; main?: string; current: string }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const opts = useMemo(() => q.trim() ? searchAll(s, q) : suggest(s, view, main).filter(o => o.id !== current), [s, q, view, main, current])
  useEffect(() => setI(0), [q])
  const choose = (o?: Opt) => { if (o) openReference(o.id) }
  return (
    <div className="ref-pick">
      <input className="f" autoFocus value={q} placeholder="A scene, chapter, character, event or research item" aria-label="Find something to open beside"
        onChange={e => setQ(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setI(x => Math.min(x + 1, opts.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setI(x => Math.max(x - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); choose(opts[i]) }
          else if (e.key === 'Escape' && q) { e.preventDefault(); setQ('') }
        }} />
      <div className="ref-opts" role="listbox" aria-label="Results">
        {opts.map((o, k) => <div key={o.id + o.g} role="presentation">
          {(k === 0 || opts[k - 1].g !== o.g) && <div className="lbl ref-g">{o.g}</div>}
          <button role="option" aria-selected={k === i} className={'menu-item ref-opt' + (k === i ? ' on' : '')} onMouseEnter={() => setI(k)} onClick={() => choose(o)}>
            <span className="ref-ok">{refKind(s, o.id)}</span><span className="grow clip">{titleOf(s, o.id)}</span>{o.detail && <span className="small muted clip ref-od">{o.detail}</span>}
          </button>
        </div>)}
        {!opts.length && <p className="small muted ref-none">{q.trim() ? 'Nothing matches.' : 'Search for anything in the project.'}</p>}
      </div>
      <p className="small muted ref-tip"><kbd>⌥</kbd>-click any link to open it here. From {'⌘'}K, <kbd>⌥↵</kbd> does the same.</p>
    </div>
  )
}

/** Things worth having beside what's open: a scene's cast, events and chapter; a chapter's scenes; a sheet's relations. Then pins. */
function suggest(s: State, view: string, main?: string): Opt[] {
  const out: Opt[] = [], seen = new Set<string>()
  const add = (id: string | undefined, g: string, detail?: string) => { if (id && s.recs[id] && !seen.has(id)) { seen.add(id); out.push({ id, g, detail }) } }
  const r = main ? s.recs[main] : undefined
  if (r?.kind === 'scene') {
    const g = 'With this scene', scs = scenesOf(s, r.story), at = scs.findIndex(x => x.id === r.id)
    r.cast.forEach(c => add(c, g))
    Object.keys(r.links).forEach(f => add(f, g))
    add(chapterOf(s, r.id)?.id, g)
    add(scs[at - 1]?.id, g, 'The scene before'); add(scs[at + 1]?.id, g, 'The scene after')
  } else if (r?.kind === 'section' || r?.kind === 'story') {
    const g = r.kind === 'story' ? 'In this story' : 'In this ' + r.type, pov = get(s, r.kind === 'story' ? r.id : r.story, 'story')?.pov
    add(pov, g, 'Point of view')
    const its = r.kind === 'story' ? flowOf(s, r.id) : contentsOf(s, r.id)
    its.slice(0, 8).forEach(x => add(x.id, g))
  } else if (r?.kind === 'entity') {
    const g = 'Around ' + r.name
    r.relations.forEach(x => add(x.to, g, x.label))
    allScenes(s).filter(sc => sc.cast.includes(r.id)).slice(0, 6).forEach(sc => add(sc.id, g))
    researchOf(s, r.id).slice(0, 4).forEach(x => add(x.id, g))
  } else if (r?.kind === 'fact') {
    const g = 'Around this ' + (r.at !== undefined ? 'event' : 'fact')
    r.causes.forEach(c => add(c, g, 'Caused by'))
    allScenes(s).filter(sc => sc.links[r.id]).slice(0, 6).forEach(sc => add(sc.id, g, 'On the page'))
    Object.keys(r.knows).filter(k => r.knows[k]?.state).forEach(k => add(k, g, kLabel(r.knows[k].state)))
  } else if (r?.kind === 'research') {
    r.about.forEach(x => add(x, 'Linked'))
  }
  ;(project(s).pins || []).forEach(p => add(p, 'Pinned'))
  if (out.length < 6) researchOf(s).slice(0, 4).forEach(x => add(x.id, 'Recent research'))
  return out
}

function searchAll(s: State, raw: string): Opt[] {
  const q = raw.trim().toLowerCase()
  const score = (t: string) => { const l = t.toLowerCase(); return l.startsWith(q) ? 3 : new RegExp('\\b' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(l) ? 2 : l.includes(q) ? 1 : 0 }
  const rows: (Opt & { sc: number })[] = []
  const add = (id: string, g: string, sc: number, detail?: string) => { if (sc) rows.push({ id, g, sc, detail }) }
  const multi = stories(s).length > 1
  for (const x of allScenes(s)) add(x.id, 'Scenes', score(x.title), multi ? nameOf(s, x.story) : undefined)
  for (const x of list(s, 'section')) add(x.id, 'Chapters and parts', Math.max(score(nameOf(s, x.id)), score(refKind(s, x.id))), multi ? nameOf(s, x.story) : undefined)
  for (const x of stories(s)) add(x.id, 'Stories', score(x.title))
  for (const e of entities(s)) add(e.id, 'World', Math.max(score(e.name), ...e.aliases.map(score)))
  for (const f of list(s, 'fact')) add(f.id, 'Events and facts', Math.max(score(f.text), q === factCode(s, f.id).toLowerCase() ? 3 : 0))
  for (const x of researchOf(s)) add(x.id, 'Research', score(x.title))
  const order = ['Scenes', 'Chapters and parts', 'World', 'Events and facts', 'Research', 'Stories']
  return order.flatMap(g => rows.filter(x => x.g === g).sort((a, b) => b.sc - a.sc).slice(0, 8))
}

// ---------------- bodies ----------------

const Chip = ({ s, id, note }: { s: State; id: string; note?: string }) =>
  s.recs[id] ? <button className="chip" title={`${refKind(s, id)}: open here`} onClick={() => openReference(id)}>{get(s, id, 'fact') ? factCode(s, id) : titleOf(s, id)}{note && <span className="muted">{note}</span>}</button> : null
const Part = ({ label, children }: { label: string; children: ReactNode }) => <section className="ref-sec"><span className="lbl">{label}</span>{children}</section>

function SceneRef({ s, sc }: { s: State; sc: Scene }) {
  const [edit, setEdit] = useState(false)
  const st = statusOf(s, sc.status), ch = chapterOf(s, sc.id), story = get(s, sc.story, 'story')
  return (
    <div className="ref-doc">
      <div className="ref-meta">
        <i className="dot" style={{ background: st.color }} /><span>{st.label}</span><span>·</span><span>{plural(words(sc.prose), 'word')}</span>
        {story && <><span>·</span><button className="link quiet clip" onClick={() => openReference(ch?.id || story.id)}>{ch ? `${refKind(s, ch.id)}${ch.title ? ': ' + ch.title : ''}` : story.title}</button></>}
        <span className="grow" />
        <button className={'btn sm ghost' + (edit ? ' on' : '')} aria-pressed={edit} title="Write in this scene here" onClick={() => setEdit(x => !x)}>{edit ? 'Done' : 'Edit here'}</button>
      </div>
      {sc.card.trim() && <p className="ref-card">{sc.card}</p>}
      {sc.cast.length > 0 && <div className="ref-chips">{sc.cast.map(c => <Chip key={c} s={s} id={c} />)}</div>}
      {edit ? <ProseField className="ref-pf" value={sc.prose} autoFocus ariaLabel={`Text of ${sc.title || 'untitled scene'}`} placeholder="Write the scene."
        onChange={v => update<'scene'>(sc.id, x => { x.prose = v })} />
        : <ProseText text={sc.prose} empty="No text yet." />}
    </div>
  )
}

function SectionRef({ s, sec }: { s: State; sec: Section }) {
  const items = contentsOf(s, sec.id), part = sec.type === 'chapter' ? partOf(s, sec.id) : undefined
  const scs = items.filter((x): x is Scene => x.kind === 'scene')
  return (
    <div className="ref-doc">
      <div className="ref-meta"><span>{plural(scs.length, 'scene')} · {plural(scs.reduce((k, x) => k + words(x.prose), 0), 'word')}</span>
        {part && <><span>·</span><button className="link quiet clip" onClick={() => openReference(part.id)}>{refKind(s, part.id)}{part.title ? ': ' + part.title : ''}</button></>}</div>
      {sec.synopsis.trim() && <p className="ref-card">{sec.synopsis}</p>}
      {items.map(x => x.kind === 'section'
        ? <button key={x.id} className="ref-h ref-ch" onClick={() => openReference(x.id)}><span className="lbl">{refKind(s, x.id)}</span>{x.title || 'Untitled chapter'}</button>
        : <section key={x.id} className="ref-scene">
          <button className="ref-h" onClick={() => openReference(x.id)} title="Open this scene here"><i className="dot" style={{ background: statusOf(s, x.status).color }} />{x.title || 'Untitled scene'}</button>
          <ProseText text={x.prose} empty="No text yet." />
        </section>)}
      {!items.length && <p className="pt-empty">No scenes in this {sec.type} yet.</p>}
    </div>
  )
}

function StoryRef({ s, st }: { s: State; st: Story }) {
  const flow = flowOf(s, st.id)
  return (
    <div className="ref-doc">
      {st.premise.trim() && <p className="ref-card">{st.premise}</p>}
      <div className="ref-list">{flow.map(x => x.kind === 'section'
        ? <button key={x.id} className={'ref-row sec ' + x.type} onClick={() => openReference(x.id)}><span className="lbl">{refKind(s, x.id)}</span><span className="grow clip">{x.title}</span></button>
        : <button key={x.id} className="ref-row" onClick={() => openReference(x.id)}><i className="dot" style={{ background: statusOf(s, x.status).color }} /><span className="grow clip">{x.title || 'Untitled scene'}</span><span className="small muted">{words(x.prose) ? n(words(x.prose)) : ''}</span></button>)}
        {!flow.length && <p className="pt-empty">No scenes yet.</p>}</div>
    </div>
  )
}

function EntityRef({ s, e }: { s: State; e: Entity }) {
  const def = typeDef(s, e.type)
  const fields = [...def.fields.map(f => ({ key: f.key, label: f.label })), ...Object.keys(e.fields).filter(k => !def.fields.some(f => f.key === k)).map(k => ({ key: k, label: k }))]
    .filter(f => e.fields[f.key]?.trim())
  const research = researchOf(s, e.id), imgs = research.filter(r => r.type === 'image' && r.file), other = research.filter(r => !imgs.includes(r))
  const scenes = allScenes(s).filter(sc => sc.cast.includes(e.id))
  return (
    <div className="ref-doc">
      <div className="ref-ent">
        {imgs[0] && <button className="ref-pic" title={imgs[0].title} onClick={() => openReference(imgs[0].id)}><img src={fileUrl(imgs[0].file!)} alt={e.name} /></button>}
        <div className="grow" style={{ minWidth: 0 }}>
          {e.aliases.length > 0 && <p className="small muted">Also {e.aliases.join(', ')}</p>}
          {e.summary.trim() ? <p className="ref-sum">{e.summary}</p> : <p className="pt-empty">No summary yet.</p>}
        </div>
      </div>
      {fields.length > 0 && <dl className="ref-fields">{fields.map(f => <div key={f.key}><dt>{f.label}</dt><dd>{e.fields[f.key]}</dd></div>)}</dl>}
      {e.relations.length > 0 && <Part label="Relations"><div className="ref-chips">{e.relations.map((x, k) => <Chip key={k} s={s} id={x.to} note={x.label ? ' · ' + x.label : ''} />)}</div></Part>}
      {e.notes.trim() && <Part label="Notes"><p className="ref-pre">{e.notes}</p></Part>}
      {imgs.length > 1 && <Part label="Pictures"><div className="ref-imgs">{imgs.slice(1).map(r => <button key={r.id} title={r.title} onClick={() => openReference(r.id)}><img src={fileUrl(r.file!)} alt={r.title} loading="lazy" /></button>)}</div></Part>}
      {other.length > 0 && <Part label="Research"><div className="ref-list">{other.map(r => <button key={r.id} className="ref-row" onClick={() => openReference(r.id)}><Thumb r={r} size={22} /><span className="grow clip">{r.title || 'Untitled'}</span></button>)}</div></Part>}
      {scenes.length > 0 && <Part label={`In ${plural(scenes.length, 'scene')}`}><div className="ref-chips">{scenes.slice(0, 24).map(sc => <Chip key={sc.id} s={s} id={sc.id} />)}</div></Part>}
    </div>
  )
}

function FactRef({ s, f }: { s: State; f: Fact }) {
  const who = Object.entries(f.knows).filter(([k, c]) => c?.state && s.recs[k])
  const scenes = allScenes(s).filter(sc => sc.links[f.id])
  return (
    <div className="ref-doc">
      {f.text.length > 48 && <p className="ref-sum">{f.text}</p>}
      {f.detail.trim() && <p className="ref-pre">{f.detail}</p>}
      {f.causes.length > 0 && <Part label="Caused by"><div className="ref-chips">{f.causes.map(c => <Chip key={c} s={s} id={c} />)}</div></Part>}
      {who.length > 0 && <Part label="Who knows"><div className="ref-know">{who.map(([k, c]) => <div key={k} className="row nowrap">
        <button className="link quiet clip" onClick={() => openReference(k)}>{nameOf(s, k)}</button><span className={'kst ' + c.state}>{kLabel(c.state)}</span>
        {c.note && <span className="small muted clip">{c.note}</span>}</div>)}</div></Part>}
      {scenes.length > 0 && <Part label="On the page"><div className="ref-chips">{scenes.map(sc => <Chip key={sc.id} s={s} id={sc.id} note={sc.links[f.id] === 'felt' ? ' · felt' : ''} />)}</div></Part>}
    </div>
  )
}
