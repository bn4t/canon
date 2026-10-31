import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  update, create, remove, tx, get, list, getState, stories, scenesOf, entities, words, nextOrder, uid, showToast, applyProposal, isApplied, pushSnapshot,
  project, nameOf, sessionWords, newScene, newNote, newQuestion, typeIds, typeDef, STATUSES, LABELS,
  type State, type Story, type Scene, type Proposal, type Severity, type SceneStatus, type Link,
} from '../store.ts'
import { complete, completeJSON } from '../ai.ts'
import { buildScene, inputHash, directPassage, deriveCard, critiqueScene, continuityCheck, suggestScenes, normalizeProposal } from '../prompts.ts'
import { diffWords, diffText } from '../diff.ts'
import { Area, Popover, useJob, JobStatus, Diff, go, replaceRoute } from '../ui.tsx'
import { RecordPicker, hrefOf } from './shared.tsx'

// ---------------- pending inline edits (tracked changes not yet accepted) ----------------

const pending = new Map<string, Proposal[]>()
const subs = new Set<() => void>()
let ver = 0
const bump = () => { ver++; subs.forEach(f => f()) }
export function addPending(p: Proposal) { pending.set(p.id!, [...(pending.get(p.id!) || []), p]); bump() }
const dropPending = (p: Proposal) => { pending.set(p.id!, (pending.get(p.id!) || []).filter(x => x !== p)); bump() }
const usePendingVer = () => useSyncExternalStore(f => (subs.add(f), () => subs.delete(f)), () => ver)

interface Hunk { p: Proposal; at: number; reject: () => void; who: string }
/** Every open edit for a scene: local ones plus "edit" proposals in Director chats. */
function hunksFor(s: State, sc: Scene): Hunk[] {
  const out: Hunk[] = (pending.get(sc.id) || []).map(p => ({ p, at: sc.prose.indexOf(p.find!), reject: () => dropPending(p), who: p.why ? 'Assistant' : 'Rewrite' }))
  for (const c of list(s, 'chat')) c.messages.forEach((m, i) => (m.proposals || []).forEach(p => {
    if (p.op === 'edit' && p.id === sc.id && !isApplied(s, p)) out.push({ p, at: sc.prose.indexOf(p.find!), who: 'Assistant', reject: () => update<'chat'>(c.id, x => { x.messages[i].proposals = x.messages[i].proposals!.filter(y => JSON.stringify(y) !== JSON.stringify(p)) }) })
  }))
  // Drop edits whose passage is gone; keep the first of any overlapping pair.
  const ok = out.filter(h => h.p.find && h.at >= 0).sort((a, b) => a.at - b.at)
  return ok.filter((h, i) => i === 0 || h.at >= ok[i - 1].at + ok[i - 1].p.find!.length)
}
const accept = (h: Hunk) => { tx('Accept change', () => applyProposal(h.p)); if (pending.get(h.p.id!)?.includes(h.p)) dropPending(h.p) }

// ---------------- AI operations (read fresh state; safe to run in batches) ----------------

type Built = 'empty' | 'manual' | 'built' | 'stale'
export const builtState = (sc: Scene, hash?: string): Built => (!sc.prose.trim() ? 'empty' : !sc.builtHash ? 'manual' : hash && hash !== sc.builtHash ? 'stale' : 'built')
export const BUILT: Record<Built, { label: string; cls: string; hint: string }> = {
  empty: { label: 'No text', cls: '', hint: 'Nothing written or built yet' },
  manual: { label: 'Hand-written', cls: '', hint: 'Written or imported, not built from the plan' },
  built: { label: 'Built', cls: 'ok', hint: 'Built from the current plan and canon' },
  stale: { label: 'Stale', cls: 'warn', hint: 'The plan or canon changed since this was built' },
}

/** Input hashes per scene of a story, recomputed (debounced) when the canon changes. */
export function useHashes(s: State, storyId?: string) {
  const [h, setH] = useState<Record<string, string>>({})
  useEffect(() => {
    let live = true
    const t = setTimeout(async () => {
      const st = get(s, storyId, 'story')
      if (!st) return
      const out: Record<string, string> = {}
      for (const sc of scenesOf(s, st.id)) out[sc.id] = await inputHash(s, st, sc)
      if (live) setH(out)
    }, 400)
    return () => { live = false; clearTimeout(t) }
  }, [s, storyId])
  return h
}

const fresh = (id: string) => { const s = getState(); const sc = get(s, id, 'scene')!; return { s, sc, st: get(s, sc.story, 'story')! } }

export async function buildOne(id: string, signal: AbortSignal, onText?: (t: string) => void) {
  const { s, sc, st } = fresh(id)
  const p = buildScene(s, st, sc)
  const hash = await inputHash(s, st, sc)
  const out = (await complete('build', p.system, p.prompt, onText, signal)).trim()
  if (!out) throw new Error('The model returned no text.')
  tx(`Build “${sc.title}”`, () => update<'scene'>(id, x => { pushSnapshot(x); x.prose = out; x.builtHash = hash; if (!x.status || x.status === 'todo') x.status = 'draft' }))
}

export async function deriveOne(id: string, signal: AbortSignal) {
  const { s, sc, st } = fresh(id)
  const d = await completeJSON<{ title?: string; beat?: string; card?: string; wants?: string; mustLand?: string[]; links?: Record<string, Link>; cast?: string[] }>('assist', deriveCard(s, st, sc), signal)
  tx(`Derive plan for “${d.title || sc.title}”`, () => update<'scene'>(id, x => {
    if (d.title && (!x.title.trim() || /^(Scene \d+|New scene)$/.test(x.title))) x.title = d.title
    if (d.beat && st.beats.includes(d.beat)) x.beat = d.beat
    if (d.card) x.card = d.card
    if (d.wants) x.wants = d.wants
    if (d.mustLand?.length) x.mustLand = d.mustLand
    for (const [k, v] of Object.entries(d.links || {})) if (get(s, k, 'fact') && (v === 'on' || v === 'felt')) x.links[k] = v
    x.cast = [...new Set([...x.cast, ...(d.cast || []).filter(e => get(s, e, 'entity'))])]
  }), false)
}

/** Rewrite prose[start:end] following a direction; the result arrives as a tracked change. */
export async function direct(id: string, start: number, end: number, direction: string, signal: AbortSignal) {
  const { s, sc, st } = fresh(id)
  const p = directPassage(s, st, sc, start, end, direction)
  const out = (await complete('build', p.system, p.prompt, undefined, signal)).trim()
  addPending({ op: 'edit', id, find: sc.prose.slice(start, end), replace: out })
}

/** Locate a quoted passage in prose. ponytail: exact, then case-insensitive; paraphrased quotes aren't found. */
export function locate(prose: string, quote?: string): [number, number] | undefined {
  const q = quote?.trim().replace(/^["“]|["”]$/g, '')
  if (!q) return
  let i = prose.indexOf(q)
  if (i < 0) i = prose.toLowerCase().indexOf(q.toLowerCase())
  return i < 0 ? undefined : [i, i + q.length]
}

export async function critique(id: string, signal: AbortSignal) {
  const { s, sc, st } = fresh(id)
  const out = await completeJSON<{ topic?: string; text: string; quote?: string }[]>('check', critiqueScene(s, st, sc), signal)
  tx('Critique scene', () => {
    for (const n of list(getState(), 'note')) if (n.scene === id && n.by === 'ai' && !n.done) remove(n.id) // replace the previous open critique
    for (const n of out) create('note', newNote(id, { by: 'ai', topic: n.topic, text: n.text, quote: n.quote || undefined }))
  }, false)
  return out.length
}

export async function continuity(storyId: string, signal: AbortSignal) {
  const s = getState(), st = get(s, storyId, 'story')!
  const out = await completeJSON<{ severity?: Severity; scene?: number; quote?: string; problem: string; fix?: string; canon?: 'hole' | 'contradiction'; about?: string[] }[]>('check', continuityCheck(s, st), signal)
  const ids = scenesOf(getState(), storyId).map(x => x.id)
  let notes = 0, qs = 0
  tx('Continuity check', () => {
    for (const n of list(getState(), 'note')) if (ids.includes(n.scene) && n.by === 'check' && !n.done) remove(n.id)
    for (const f of out) {
      if (f.canon) { qs++; create('question', newQuestion({ type: f.canon, text: f.problem, about: (f.about || []).filter(x => getState().recs[x]), by: 'check' })) }
      else if (f.scene && ids[f.scene - 1]) { notes++; create('note', newNote(ids[f.scene - 1], { by: 'check', severity: (['critical', 'error', 'warning', 'note'] as const).includes(f.severity!) ? f.severity : 'warning', quote: f.quote, text: f.problem, fix: f.fix })) }
    }
  }, false)
  showToast(out.length ? `Continuity check: ${notes} note${notes === 1 ? '' : 's'} on scenes${qs ? `, ${qs} question${qs === 1 ? '' : 's'} about the canon` : ''}` : 'Continuity check: no problems found')
}

export function newStory() {
  let id = ''
  tx('New story', () => { id = create('story', { title: 'Untitled story', order: nextOrder(stories(getState())), form: 'prose', premise: '', beats: [] }) })
  go('story/' + id)
}
export function addScene(st: Story, order?: number) {
  let id = ''
  tx('New scene', () => { id = create('scene', newScene(st.id, order ?? nextOrder(scenesOf(getState(), st.id)), { cast: st.pov ? [st.pov] : [] })) })
  go(`write/${st.id}/${id}`)
  return id
}
export function reorder(scs: Scene[], dragId: string, beforeId?: string) {
  const ids = scs.map(x => x.id).filter(x => x !== dragId)
  const at = beforeId ? ids.indexOf(beforeId) : ids.length
  ids.splice(at < 0 ? ids.length : at, 0, dragId)
  tx('Reorder scenes', () => ids.forEach((id, i) => { if (get(getState(), id, 'scene')!.order !== i + 1) update<'scene'>(id, x => { x.order = i + 1 }) }))
}
function splitAt(sc: Scene, at: number) {
  const scs = scenesOf(getState(), sc.story), next = scs[scs.findIndex(x => x.id === sc.id) + 1]
  let id = ''
  tx('Split scene', () => {
    id = create('scene', newScene(sc.story, next ? (sc.order + next.order) / 2 : sc.order + 1, { title: sc.title + ' (2)', cast: sc.cast, links: { ...sc.links }, prose: sc.prose.slice(at).trimStart(), status: sc.status, label: sc.label }))
    update<'scene'>(sc.id, x => { pushSnapshot(x, 'Before split'); x.prose = x.prose.slice(0, at).trimEnd() })
  })
  go(`write/${sc.story}/${id}`)
}
function mergeNext(sc: Scene) {
  const scs = scenesOf(getState(), sc.story), next = scs[scs.findIndex(x => x.id === sc.id) + 1]
  if (!next) return showToast('This is the last scene of the story.')
  tx(`Merge “${next.title}” into “${sc.title}”`, () => {
    update<'scene'>(sc.id, x => { pushSnapshot(x, 'Before merge'); x.prose = [x.prose.trimEnd(), next.prose.trim()].filter(Boolean).join('\n\n'); x.cast = [...new Set([...x.cast, ...next.cast])]; x.links = { ...next.links, ...x.links }; x.mustLand = [...x.mustLand, ...next.mustLand].filter(Boolean) })
    for (const n of list(getState(), 'note')) if (n.scene === next.id) update<'note'>(n.id, y => { y.scene = sc.id })
    remove(next.id)
  })
}

// ---------------- the view ----------------

const labelColor = (l?: string) => (l ? `var(--l-${l})` : 'var(--line2)')
const stored = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
const store = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } }

export function WriteView({ s, storyId, sceneId }: { s: State; storyId?: string; sceneId?: string }) {
  const sts = stories(s)
  const st = get(s, storyId, 'story') || sts[0]
  const scs = st ? scenesOf(s, st.id) : []
  const sc = scs.find(x => x.id === sceneId) || scs[0]
  const [contents, setContents] = useState(() => stored('canon.contents', '1') === '1')
  useEffect(() => { if (st && sc && (st.id !== storyId || sc.id !== sceneId)) replaceRoute(`write/${st.id}/${sc.id}`) }, [st, sc, storyId, sceneId])
  if (!st) return <div className="empty"><h2>No stories yet</h2><p>A project holds one or more stories; each story is an ordered run of scenes.</p><button className="btn pri" onClick={newStory}>New story</button></div>
  const toggle = () => setContents(c => { store('canon.contents', c ? '0' : '1'); return !c })
  return (
    <div className="cols" style={contents ? undefined : { gridTemplateColumns: 'minmax(0, 1fr)' }}>
      {contents && <Contents s={s} st={st} sc={sc} />}
      {sc ? <Document key={sc.id} s={s} st={st} sc={sc} scs={scs} toggleContents={toggle} />
        : <div className="empty"><h2>{st.title}</h2><p>No scenes yet. Add one, or plan the story first.</p><div className="row"><button className="btn pri" onClick={() => addScene(st)}>Add a scene</button><a className="btn" href={'#story/' + st.id}>Plan the story</a></div></div>}
    </div>
  )
}

function Contents({ s, st, sc }: { s: State; st: Story; sc?: Scene }) {
  const drag = useRef<string>(undefined)
  const [over, setOver] = useState<string>()
  const cols = project(s).collections || []
  const scs = scenesOf(s, st.id)
  return (
    <nav className="index" aria-label="Contents">
      <div className="grp"><span>Stories · {stories(s).length}</span><button className="x" title="New story" aria-label="New story" onClick={newStory}>+</button></div>
      {stories(s).map(x => <a key={x.id} href={'#write/' + x.id} className={x.id === st.id ? 'on' : ''}><span className="clip">{x.title}</span><small>{scenesOf(s, x.id).length}</small></a>)}
      <div className="grp"><span>Scenes · {scs.length}</span><a className="grp-link" href={'#story/' + st.id} title="Board, outline and story settings">Plan</a></div>
      {scs.map((y, i) => (
        <a key={y.id} href={`#write/${st.id}/${y.id}`} className={(y.id === sc?.id ? 'on' : '') + (over === y.id ? ' drag-over' : '')} draggable
          onDragStart={() => { drag.current = y.id }} onDragOver={e => { if (drag.current) { e.preventDefault(); setOver(y.id) } }} onDragLeave={() => setOver(undefined)}
          onDrop={e => { e.preventDefault(); if (drag.current && drag.current !== y.id) reorder(scs, drag.current, y.id); drag.current = undefined; setOver(undefined) }}>
          <i className="dot" style={{ background: labelColor(y.label) }} /><span className="clip">{i + 1}. {y.title}</span><small>{words(y.prose) || '–'}</small>
        </a>
      ))}
      <button className="item add" onClick={() => addScene(st, sc ? sc.order + 0.5 : undefined)}>+ Scene{sc ? ' after this' : ''}</button>
      <div className="grp"><span>Collections</span><button className="x" title="New collection" aria-label="New collection" onClick={() => { const id = uid('col'); tx('New collection', () => update<'project'>('project', x => { x.collections = [...(x.collections || []), { id, name: 'New collection', filter: {} }] }), false); go('collection/' + id) }}>+</button></div>
      {cols.map(c => <a key={c.id} href={'#collection/' + c.id}><span className="clip">{c.name}</span></a>)}
    </nav>
  )
}

function Document({ s, st, sc, scs, toggleContents }: { s: State; st: Story; sc: Scene; scs: Scene[]; toggleContents: () => void }) {
  usePendingVer()
  const job = useJob()
  const hashes = useHashes(s, st.id)
  const area = useRef<HTMLTextAreaElement>(null)
  const [sel, setSel] = useState<[number, number]>()
  const [live, setLive] = useState('')
  const [focus, setFocus] = useState(false)
  const [editing, setEditing] = useState(false)
  const edit = (fn: (x: Scene) => void) => update<'scene'>(sc.id, fn)
  const hunks = hunksFor(s, sc)
  const review = hunks.length > 0 && !editing && !live
  const built = builtState(sc, hashes[sc.id])
  const p = project(s)
  const i = scs.indexOf(sc)

  // Notes and Find ask the editor to select a quoted passage.
  useEffect(() => {
    const onSel = (e: Event) => {
      const at = locate(get(getState(), sc.id, 'scene')!.prose, (e as CustomEvent<string>).detail)
      if (!at) return showToast('That passage is no longer in the text.')
      setEditing(true)
      setTimeout(() => { const t = area.current; if (!t) return; t.focus(); t.setSelectionRange(at[0], at[1]); setSel(at); t.closest('.main')?.scrollTo({ top: t.offsetTop + (at[0] / Math.max(1, t.value.length)) * t.offsetHeight - 200, behavior: 'smooth' }) }, 30)
    }
    addEventListener('canon:select', onSel)
    return () => removeEventListener('canon:select', onSel)
  }, [sc.id])
  useEffect(() => { if (!hunks.length) setEditing(false) }, [hunks.length])

  const run = (cmd: string, arg = '') => {
    const [a, b] = sel || [0, 0]
    switch (cmd) {
      case 'rebuild': return job.run(sc.prose.trim() ? 'Rebuilding from the plan…' : 'Building from the plan…', sig => buildOne(sc.id, sig, setLive)).finally(() => setLive(''))
      case 'critique': return job.run('Reading the scene as an editor…', async sig => { const n = await critique(sc.id, sig); showToast(`${n} note${n === 1 ? '' : 's'} from the assistant`); dispatchEvent(new CustomEvent('canon:notes')) })
      case 'check': return job.run('Reading the whole story for continuity…', sig => continuity(st.id, sig))
      case 'derive': return job.run('Deriving the plan from the text…', sig => deriveOne(sc.id, sig))
      case 'snapshot': return tx('Take snapshot', () => edit(x => { x.snapshots = [{ text: x.prose, at: new Date().toISOString(), name: arg || `Snapshot ${x.snapshots.filter(t => t.name).length + 1}` }, ...x.snapshots] }))
      case 'split': return sel || area.current ? splitAt(sc, sel ? a : area.current!.selectionStart) : undefined
      case 'merge': return mergeNext(sc)
      case 'comment': return sel ? tx('Add comment', () => { create('note', newNote(sc.id, { quote: sc.prose.slice(a, b), text: arg })) }, false) : showToast('Select a passage to comment on.')
      case 'direct': return sel && arg ? job.run('Rewriting the passage…', sig => direct(sc.id, a, b, arg, sig)).then(() => setSel(undefined)) : undefined
      case 'focus': return setFocus(true)
      case 'suggest': return job.run('Looking for missing scenes…', async sig => {
        const out = await completeJSON<Proposal[]>('assist', suggestScenes(getState(), st), sig)
        tx(`Add ${out.length} suggested scenes`, () => out.filter(x => x.op === 'create' && x.kind === 'scene').forEach(x => applyProposal(normalizeProposal(getState(), { ...x, data: { ...x.data, story: st.id, status: 'todo' } }))))
      })
    }
  }

  const editor = (big?: boolean) => (
    <textarea ref={area} className="prose-area" value={live || sc.prose} readOnly={!!live} aria-label="Scene text" autoFocus={big}
      placeholder={sc.card.trim() ? 'Write here, or type /rebuild below to render the scene from its plan.' : 'Write here. Or fill in the plan above and type /rebuild.'}
      onChange={e => edit(x => { x.prose = e.target.value })}
      onSelect={e => { const t = e.currentTarget; setSel(t.selectionEnd - t.selectionStart > 1 ? [t.selectionStart, t.selectionEnd] : undefined) }} />
  )
  const selWords = sel ? words(sc.prose.slice(sel[0], sel[1])) : 0
  const w = words(sc.prose)

  if (focus) return <Focus sc={sc} editor={editor(true)} onExit={() => setFocus(false)} />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', minWidth: 0 }}>
      <header className="pagehead">
        <button className="btn sm ghost" title="Show or hide the contents" onClick={toggleContents}>☰</button>
        <div className="crumbs grow"><a href={'#story/' + st.id}>{st.title}</a><span className="faint">/</span><b className="clip">{i + 1}. {sc.title}</b></div>
        {hunks.length > 0 && <>
          <span className="chip on">{hunks.length} change{hunks.length === 1 ? '' : 's'}</span>
          <button className="btn sm" onClick={() => tx(`Accept ${hunks.length} changes`, () => [...hunks].reverse().forEach(h => { applyProposal(h.p); if (pending.get(h.p.id!)?.includes(h.p)) dropPending(h.p) }))}>Accept all</button>
          <button className="btn sm ghost" onClick={() => setEditing(e => !e)}>{editing ? 'Review changes' : 'Edit text'}</button>
        </>}
        <span className={'chip ' + BUILT[built].cls} title={BUILT[built].hint}>{BUILT[built].label}</span>
        <button className="btn sm ghost" disabled={i <= 0} title="Previous scene" onClick={() => go(`write/${st.id}/${scs[i - 1].id}`)}>←</button>
        <button className="btn sm ghost" disabled={i >= scs.length - 1} title="Next scene" onClick={() => go(`write/${st.id}/${scs[i + 1].id}`)}>→</button>
      </header>
      <article className="doc">
        <Plan s={s} st={st} sc={sc} onDerive={() => run('derive')} busy={!!job.busy} />
        <input className="doc-title" value={sc.title} aria-label="Scene title" onChange={e => edit(x => { x.title = e.target.value })} />
        <JobStatus job={job} />
        {review ? <Review sc={sc} hunks={hunks} /> : editor()}
        <div className="doc-foot">
          <span>{w.toLocaleString()}{sc.target ? ` / ${sc.target.toLocaleString()}` : ''} words</span>
          {sc.target ? <div className="bar" style={{ width: 70 }}><i style={{ width: Math.min(100, (w / sc.target) * 100) + '%' }} /></div> : null}
          {selWords > 0 && <span>{selWords} selected</span>}
          <span>Today {sessionWords(s).toLocaleString()}{p.sessionTarget ? ` / ${p.sessionTarget.toLocaleString()}` : ''}</span>
          <span className="grow" />
          {sc.pinned && <span title="Batch builds skip this scene">Pinned</span>}
          {sc.exclude && <span>Not in compile</span>}
          <Snapshots sc={sc} />
        </div>
      </article>
      <CommandBar sel={sel ? sc.prose.slice(sel[0], sel[1]) : ''} busy={!!job.busy} run={run} canBuild={!!sc.card.trim()} />
    </div>
  )
}

/** The text with open edits shown as tracked changes, each with Accept / Reject. */
function Review({ sc, hunks }: { sc: Scene; hunks: Hunk[] }) {
  const out: React.ReactNode[] = []
  let pos = 0
  hunks.forEach((h, k) => {
    out.push(<span key={'t' + k}>{sc.prose.slice(pos, h.at)}</span>)
    out.push(<span key={'h' + k}><Diff parts={diffWords(h.p.find!, h.p.replace || '')} /></span>)
    const end = sc.prose.indexOf('\n', h.at + h.p.find!.length)
    const stop = end < 0 ? sc.prose.length : end
    out.push(<span key={'r' + k}>{sc.prose.slice(h.at + h.p.find!.length, stop)}</span>)
    out.push(<span key={'a' + k} className="hunk" role="group" aria-label="Change">
      <span className="who">{h.who}</span>{h.p.why && <span>{h.p.why}</span>}
      <button className="btn sm ins" onClick={() => accept(h)}>Accept</button>
      <button className="btn sm" onClick={h.reject}>Reject</button>
    </span>)
    pos = sc.prose[stop] === '\n' ? stop + 1 : stop
  })
  out.push(<span key="end">{sc.prose.slice(pos)}</span>)
  return <div className="review">{out}</div>
}

const COMMANDS: { cmd: string; hint: string; sel?: boolean }[] = [
  { cmd: 'rebuild', hint: 'Render the scene from its plan; the current text becomes a snapshot' },
  { cmd: 'critique', hint: 'The assistant reads the scene as an editor and leaves notes' },
  { cmd: 'check', hint: 'Continuity check of the whole story against the canon' },
  { cmd: 'derive', hint: 'Fill the plan from the text' },
  { cmd: 'snapshot', hint: 'Save a named version of the text: /snapshot before the cut' },
  { cmd: 'split', hint: 'Split the scene at the cursor or selection' },
  { cmd: 'merge', hint: 'Merge the next scene into this one' },
  { cmd: 'comment', hint: 'Comment on the selected passage: /comment too soft', sel: true },
  { cmd: 'suggest', hint: 'Suggest scenes the story is missing' },
  { cmd: 'focus', hint: 'Full-screen writing; Esc to leave' },
]

function CommandBar({ sel, busy, run, canBuild }: { sel: string; busy: boolean; run: (cmd: string, arg?: string) => void; canBuild: boolean }) {
  const [v, setV] = useState('')
  const [i, setI] = useState(0)
  const slash = v.startsWith('/')
  const name = v.slice(1).split(' ')[0].toLowerCase()
  const menu = slash ? COMMANDS.filter(c => c.cmd.startsWith(name) && (!c.sel || sel)) : []
  const submit = () => {
    if (!v.trim() || busy) return
    if (slash) {
      const c = menu[i] || COMMANDS.find(x => x.cmd === name)
      if (!c) return
      if (c.cmd === 'rebuild' && !canBuild) return showToast('Rebuild needs a plan: say what happens in the plan above, or /derive it from the text.')
      run(c.cmd, v.slice(1 + c.cmd.length).trim())
    } else if (sel) run('direct', v.trim())
    else dispatchEvent(new CustomEvent('canon:ask', { detail: v.trim() }))
    setV(''); setI(0)
  }
  return (
    <div className="cmdbar">
      <div className="cmdbar-in">
        {menu.length > 0 && <div className="cmd-menu">{menu.map((c, k) => (
          <button key={c.cmd} className={'menu-item' + (k === i ? ' on' : '')} onMouseEnter={() => setI(k)} onClick={() => { setV('/' + c.cmd + ' '); setI(k) }}>
            <span className="mono ai-text" style={{ width: 80 }}>/{c.cmd}</span><span className="muted small">{c.hint}</span></button>))}</div>}
        {sel && !slash && <div className="row small muted"><span className="chip on">Selection</span><span className="clip grow">“{sel.slice(0, 120)}{sel.length > 120 ? '…' : ''}”</span><span>Type how it should change, or /comment</span></div>}
        <label className="cmd">
          <span className="slash">{sel && !slash ? '✦' : '/'}</span>
          <input value={v} aria-label="Command" placeholder={sel ? 'Direct the selection: colder; cut the metaphor; she doesn’t say it' : 'Type / for commands, or tell the assistant what this scene needs'}
            onChange={e => { setV(e.target.value); setI(0) }}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); submit() }
              else if (e.key === 'ArrowDown' && menu.length) { e.preventDefault(); setI(x => Math.min(x + 1, menu.length - 1)) }
              else if (e.key === 'ArrowUp' && menu.length) { e.preventDefault(); setI(x => Math.max(x - 1, 0)) }
              else if (e.key === 'Tab' && menu[i]) { e.preventDefault(); setV('/' + menu[i].cmd + ' ') }
              else if (e.key === 'Escape') setV('')
            }} />
          {busy && <span className="spinner" />}
        </label>
      </div>
    </div>
  )
}

function Focus({ sc, editor, onExit }: { sc: Scene; editor: React.ReactNode; onExit: () => void }) {
  const [paper, setPaper] = useState(() => stored('canon.paper', '700'))
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onExit() }; addEventListener('keydown', esc); return () => removeEventListener('keydown', esc) }, [onExit])
  return (
    <div className="focus-mode" style={{ ['--paper' as string]: paper + 'px' }}>
      <div className="focus-bar">
        <span>{words(sc.prose).toLocaleString()} words</span>
        <select className="f" style={{ width: 'auto', padding: '2px 24px 2px 6px' }} value={paper} aria-label="Page width" onChange={e => { setPaper(e.target.value); store('canon.paper', e.target.value) }}>
          <option value="560">Narrow</option><option value="700">Medium</option><option value="880">Wide</option></select>
        <button className="btn sm" onClick={onExit}>Leave <kbd>esc</kbd></button>
      </div>
      <div className="doc"><h1>{sc.title}</h1>{editor}</div>
    </div>
  )
}

function Snapshots({ sc }: { sc: Scene }) {
  const [cmp, setCmp] = useState<number>()
  const parts = useMemo(() => (cmp === undefined ? [] : diffText(sc.snapshots[cmp]?.text || '', sc.prose)), [cmp, sc])
  return <>
    <Popover className="right" trigger={o => <button className="btn sm ghost" onClick={o}>Snapshots{sc.snapshots.length ? ` · ${sc.snapshots.length}` : ''}</button>}>{close => <div className="stack" style={{ gap: 4, width: 320, padding: 4 }}>
      <span className="lbl">Earlier versions of the text. Builds, rewrites, splits and accepted changes keep one automatically.</span>
      {!sc.snapshots.length && <p className="muted small">None yet. Type /snapshot to take one.</p>}
      {sc.snapshots.map((t, k) => (
        <div key={k} className="row nowrap" style={{ padding: '4px 6px', borderTop: '1px solid var(--line)' }}>
          <div className="grow"><b className="small">{t.name || 'Automatic'}</b><div className="small muted">{new Date(t.at).toLocaleString()} · {words(t.text)} words</div></div>
          <button className="btn sm ghost" onClick={() => { setCmp(k); close() }}>Compare</button>
          <button className="btn sm" onClick={() => { tx('Restore snapshot', () => update<'scene'>(sc.id, x => { const cur = x.prose; x.prose = t.text; x.snapshots[k] = { text: cur, at: new Date().toISOString(), name: 'Before restore' } })); close() }}>Restore</button>
        </div>
      ))}
    </div>}</Popover>
    {cmp !== undefined && <div className="overlay" onMouseDown={() => setCmp(undefined)}>
      <div className="palette" style={{ width: 'min(820px, calc(100vw - 32px))' }} onMouseDown={e => e.stopPropagation()} role="dialog" aria-label="Compare">
        <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}><b>{sc.snapshots[cmp].name || 'Automatic snapshot'}</b><span className="muted small">{new Date(sc.snapshots[cmp].at).toLocaleString()} → now</span><span className="grow" />
          <span className="small"><del style={{ color: 'var(--del)' }}>removed</del> · <ins style={{ color: 'var(--ins)', textDecoration: 'none' }}>added</ins></span><button className="x" onClick={() => setCmp(undefined)}>×</button></div>
        <div className="review" style={{ maxHeight: '64vh', overflowY: 'auto', padding: '16px 22px', fontSize: 16 }}><Diff parts={parts} /></div>
      </div>
    </div>}
  </>
}

// ---------------- the plan (scene card) ----------------

function Plan({ s, st, sc, onDerive, busy }: { s: State; st: Story; sc: Scene; onDerive: () => void; busy: boolean }) {
  const edit = (fn: (x: Scene) => void) => update<'scene'>(sc.id, fn)
  const p = project(s)
  const labels = p.labels || {}
  const empty = !sc.card.trim()
  const [open, setOpen] = useState(empty && !sc.prose.trim())
  return (
    <details className="plan" open={open} onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span className="kicker">Plan</span>
        <span className="syn">{sc.card || (sc.prose.trim() ? 'No plan yet: derive one from the text' : 'What happens in this scene?')}</span>
        <span className="small">{STATUSES.find(x => x.id === (sc.status || 'todo'))!.label}</span>
      </summary>
      {open && <div className="plan-body">
        {empty && sc.prose.trim() && <div className="card tint row"><span className="grow small">The plan is what rebuilds, checks and the timeline work from.</span><button className="btn sm ai" disabled={busy} onClick={onDerive}>✦ Derive from the text</button></div>}
        <Area label={st.form === 'documents' ? 'What the document is and does' : 'What happens'} value={sc.card} placeholder="What happens, and what changes" onChange={v => edit(x => { x.card = v })} />
        {st.form !== 'documents' && <Area label="What each person wants" value={sc.wants} onChange={v => edit(x => { x.wants = v })} />}
        <Area label="Must land · one per line" value={sc.mustLand.join('\n')} onChange={v => edit(x => { x.mustLand = v.split('\n') })} />
        <div className="grid3">
          <label className="field"><span className="lbl">Status</span><select className="f" value={sc.status || 'todo'} onChange={e => edit(x => { x.status = e.target.value as SceneStatus })}>{STATUSES.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
          <label className="field"><span className="lbl">Beat</span><select className="f" value={sc.beat} onChange={e => edit(x => { x.beat = e.target.value })}><option value="">None</option>{[...new Set([...st.beats, sc.beat].filter(Boolean))].map(b => <option key={b}>{b}</option>)}</select></label>
          <label className="field"><span className="lbl">Target words</span><input className="f" type="number" min={0} step={100} value={sc.target || ''} onChange={e => edit(x => { x.target = Number(e.target.value) || undefined })} /></label>
          <label className="field"><span className="lbl">Tags</span><input className="f" value={(sc.tags || []).join(', ')} placeholder="comma-separated" onChange={e => edit(x => { x.tags = e.target.value.split(',').map(t => t.trimStart()) })} /></label>
        </div>
        {(p.sceneFields || []).length > 0 && <div className="grid3">{p.sceneFields!.map(f => {
          const v = sc.meta?.[f.key] || '', set = (val: string) => edit(x => { x.meta = { ...x.meta, [f.key]: val } })
          return <label key={f.key} className="field"><span className="lbl">{f.label}</span>
            {f.kind === 'check' ? <input type="checkbox" checked={v === 'yes'} onChange={e => set(e.target.checked ? 'yes' : '')} />
              : f.kind === 'list' ? <select className="f" value={v} onChange={e => set(e.target.value)}><option value="" />{(f.options || []).map(o => <option key={o}>{o}</option>)}</select>
                : <input className="f" type={f.kind === 'date' ? 'date' : 'text'} value={v} onChange={e => set(e.target.value)} />}</label>
        })}</div>}
        <div className="field"><span className="lbl">Label</span><div className="row" style={{ gap: 6 }}>
          {LABELS.map(l => <button key={l} className="dot" title={labels[l] || l} aria-label={labels[l] || l} aria-pressed={sc.label === l} style={{ width: 18, height: 18, border: 0, background: labelColor(l), outline: sc.label === l ? '2px solid var(--ink)' : undefined, outlineOffset: 2 }} onClick={() => edit(x => { x.label = x.label === l ? undefined : l })} />)}
          {sc.label && <span className="small muted">{labels[sc.label] || sc.label}</span>}</div></div>
        <div className="field"><span className="lbl">Cast and setting</span><div className="row" style={{ gap: 4 }}>
          {sc.cast.map(c => <span key={c} className="chip on"><a href={'#world/' + c} style={{ textDecoration: 'none' }}>{nameOf(s, c) || 'Missing'}</a><button className="x" style={{ fontSize: 13, padding: 0, color: 'inherit' }} aria-label="Remove" onClick={() => edit(x => { x.cast = x.cast.filter(y => y !== c) })}>×</button></span>)}
          <CastPicker s={s} cast={sc.cast} onPick={id => edit(x => { x.cast.push(id) })} /></div></div>
        <div className="field"><span className="lbl">Events and facts it touches</span><div className="row" style={{ gap: 4 }}>
          {Object.entries(sc.links).map(([id, how]) => <span key={id} className="chip on" title={how === 'on' ? 'On the page' : 'Felt: the effect, not the cause'}>
            <a href={'#' + hrefOf(s, id)} style={{ textDecoration: 'none' }}>{nameOf(s, id) || 'Missing'}</a>
            <button className="x" style={{ fontSize: 11, padding: '0 2px', color: 'inherit' }} onClick={() => edit(x => { x.links[id] = how === 'on' ? 'felt' : 'on' })}>{how === 'on' ? 'on page' : 'felt'}</button>
            <button className="x" style={{ fontSize: 13, padding: 0, color: 'inherit' }} aria-label="Remove" onClick={() => edit(x => { delete x.links[id] })}>×</button></span>)}
          <RecordPicker s={s} kinds={['fact']} label="+ Event or fact" exclude={Object.keys(sc.links)} onPick={id => edit(x => { x.links[id] = 'on' })} /></div></div>
        <div className="row small">
          <label className="row nowrap"><input type="checkbox" checked={sc.pinned} onChange={e => edit(x => { x.pinned = e.target.checked })} />Pinned: batch builds skip it</label>
          <label className="row nowrap"><input type="checkbox" checked={!sc.exclude} onChange={e => edit(x => { x.exclude = !e.target.checked })} />Include in compile</label>
          <span className="grow" />
          {sc.card.trim() && sc.prose.trim() && <button className="btn sm ghost" disabled={busy} onClick={onDerive}>✦ Re-derive</button>}
          <button className="btn sm ghost danger" onClick={() => { const next = scenesOf(s, st.id).find(x => x.id !== sc.id); tx(`Delete scene “${sc.title}”`, () => remove(sc.id)); go(next ? `write/${st.id}/${next.id}` : 'story/' + st.id) }}>Delete scene</button>
        </div>
      </div>}
    </details>
  )
}

function CastPicker({ s, cast, onPick }: { s: State; cast: string[]; onPick: (id: string) => void }) {
  return <Popover trigger={o => <button className="chip dash" onClick={o}>+ Add</button>}>{close => <>
    {typeIds(s).map(t => { const xs = entities(s, t).filter(e => !cast.includes(e.id)); return xs.length ? <div key={t}><span className="lbl" style={{ padding: '6px 10px', display: 'block' }}>{typeDef(s, t).label}</span>
      {xs.map(e => <button key={e.id} className="menu-item" onClick={() => { onPick(e.id); close() }}>{e.name}</button>)}</div> : null })}
  </>}</Popover>
}

