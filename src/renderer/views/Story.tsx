import './outline.css'
import { useRef, useState, type ReactNode } from 'react'
import {
  update, create, remove, tx, get, getState, list, stories, scenesOf, entities, words, project, nameOf, guidesFor, matchScenes, showToast, applyProposal, typeIds, typeDef,
  eventCode, newScene, newQuestion, STATUSES, LABELS, type State, type Story, type Scene, type Proposal, type GuideKind, type Filter, type SceneStatus, type Link,
} from '../store.ts'
import { completeJSON, useAI, aiReady, modelFor, providerName } from '../ai.ts'
import { deriveCard, findProblems, normalizeProposal, type FoundQ } from '../prompts.ts'
import { suggestScenesByBeat } from '../outlinePrompts.ts'
import { Popover, useJob, JobStatus, go, Bar, Icon, Spark, ConnectPrompt, ProposedChanges, AssistMenu, openSettings, stored, store } from '../ui.tsx'
import { RecordPicker, GuideRow } from './shared.tsx'
import { useHashes, builtState, BUILT, buildOne, continuity } from '../scenes.ts'

type Mode = 'board' | 'list'
type Group = 'beat' | 'status' | 'label' | 'order'
const GROUPS: { id: Group; label: string }[] = [{ id: 'beat', label: 'Beat' }, { id: 'status', label: 'Status' }, { id: 'label', label: 'Label' }, { id: 'order', label: 'Story order' }]
const excerpt = (sc: Scene) => sc.prose.trim().replace(/\s+/g, ' ').slice(0, 200)
const labelColor = (l?: string) => (l ? `var(--l-${l})` : 'transparent')
const statusOf = (sc: Scene) => STATUSES.find(x => x.id === (sc.status || 'todo'))!
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
const openNotes = (s: State) => { const m: Record<string, number> = {}; for (const n of list(s, 'note')) if (!n.done) m[n.scene] = (m[n.scene] || 0) + 1; return m }
const listNames = (scs: Scene[]) => scs.length <= 2 ? scs.map(x => x.title).join(' and ') : `${scs.slice(0, 2).map(x => x.title).join(', ')} and ${scs.length - 2} more`

// ---------------- assistant work, reviewed where it lands ----------------

/** Draft from card (scenes.ts): into an empty scene it writes the text; over existing text it arrives as a suggestion in the editor. */
const draftOne = async (id: string, sig: AbortSignal) => { await buildOne(id, sig) }

type CardFill = { title?: string; beat?: string; card?: string; wants?: string; mustLand?: string[]; links?: Record<string, Link>; cast?: string[] }
/** Read a scene's text and propose its card, for review. Cast and event links ride along and are applied with it. */
async function cardFor(id: string, sig: AbortSignal): Promise<{ p: Proposal; cast: string[]; links: Record<string, Link> } | undefined> {
  const s = getState(), sc = get(s, id, 'scene')!, st = get(s, sc.story, 'story')!
  const d = await completeJSON<CardFill>('assist', deriveCard(s, st, sc), sig)
  const set: Record<string, unknown> = {}
  if (d.title && (!sc.title.trim() || /^(Scene \d+|New scene)$/.test(sc.title))) set.title = d.title
  if (d.card) set.card = d.card
  if (d.wants && !sc.wants.trim()) set.wants = d.wants
  if (d.mustLand?.length && !sc.mustLand.length) set.mustLand = d.mustLand
  if (d.beat && st.beats.includes(d.beat) && !sc.beat) set.beat = d.beat
  if (!Object.keys(set).length) return
  const links = Object.fromEntries(Object.entries(d.links || {}).filter(([k, v]) => get(s, k, 'fact') && (v === 'on' || v === 'felt'))) as Record<string, Link>
  return { p: { op: 'update', id, set, why: 'Read from the scene’s text' }, cast: (d.cast || []).filter(e => get(s, e, 'entity')), links }
}

export function StoryView({ s, storyId }: { s: State; storyId: string }) {
  const st = get(s, storyId, 'story')!
  const scs = scenesOf(s, storyId)
  const [mode, setMode] = useState<Mode>(() => (stored('canon.outline.' + storyId, 'board') === 'list' ? 'list' : 'board'))
  const pick = (m: Mode) => { setMode(m); store('canon.outline.' + storyId, m) }
  const [group, setGroup] = useState<Group>(() => (stored('canon.outline.group', 'beat') as Group))
  const pickGroup = (g: Group) => { setGroup(g); store('canon.outline.group', g) }
  const [details, setDetails] = useState(() => !scs.length && !st.premise.trim())
  const [cols, setCols] = useState<string[]>(() => stored('canon.outline.cols', 'beat,status,card,words,cast').split(','))
  const hashes = useHashes(s, storyId)
  const job = useJob()
  const [ghosts, setGhosts] = useState<Proposal[]>([])
  const [cards, setCards] = useState<Proposal[]>([])
  const extras = useRef(new Map<string, { cast: string[]; links: Record<string, Link> }>())

  const locked = scs.filter(x => x.pinned && x.card.trim())
  const toDraft = scs.filter(x => !x.pinned && x.card.trim() && (!x.prose.trim() || builtState(x, hashes[x.id]) === 'stale'))
  const toFill = scs.filter(x => x.prose.trim() && !x.card.trim())
  const hasText = scs.some(x => x.prose.trim())

  const batch = (verb: string, ids: string[], fn: (id: string, sig: AbortSignal) => Promise<void>, done: (n: number) => void) => job.run(verb + '…', async (sig, progress) => {
    const errs: string[] = []
    for (const [i, id] of ids.entries()) {
      if (sig.aborted) return
      progress(`${verb} ${i + 1} of ${ids.length}: ${get(getState(), id, 'scene')?.title}`)
      try { await fn(id, sig) } catch (e) { if (sig.aborted) return; errs.push(`${get(getState(), id, 'scene')?.title}: ${String(e).replace(/^Error: /, '')}`) }
    }
    done(ids.length - errs.length)
    if (errs.length) throw new Error(`${ids.length - errs.length} of ${ids.length} done. These failed and can be retried:\n${errs.join('\n')}`)
  })
  const suggest = () => job.run('Looking for missing scenes…', async sig => {
    const out = await completeJSON<Proposal[]>('assist', suggestScenesByBeat(getState(), st), sig)
    const gs = out.filter(p => p.op === 'create' && p.kind === 'scene').map(p => normalizeProposal(getState(), { ...p, data: { ...p.data, story: storyId, status: 'todo' } }))
    setGhosts(g => [...g, ...gs])
    if (!gs.length) job.setErr('No missing scenes: the outline covers the story as it stands.')
    pick('board')
  })
  const draft = () => batch('Drafting', toDraft.map(x => x.id), draftOne, n => {
    const sugg = toDraft.filter(x => x.prose.trim()).length
    showToast(`Drafted ${plural(n, 'scene')} from ${n === 1 ? 'its card' : 'their cards'}${sugg ? `; ${sugg} with text arrived as suggestions` : ''}`)
  })
  const fill = () => {
    const found: Proposal[] = []
    batch('Reading', toFill.map(x => x.id), async (id, sig) => { const r = await cardFor(id, sig); if (r) { found.push(r.p); extras.current.set(id, { cast: r.cast, links: r.links }) } }, () => {
      setCards(found)
      if (!found.length) showToast('Nothing to fill: the cards already say what the text does')
    })
  }
  const linkAlong = (ps: Proposal[]) => tx('Add cast and events from the text', () => ps.forEach(p => {
    const x = extras.current.get(p.id!)
    if (x) update<'scene'>(p.id!, sc => { sc.cast = [...new Set([...sc.cast, ...x.cast])]; for (const [k, v] of Object.entries(x.links)) sc.links[k] ??= v })
  }), false)
  const check = () => job.run('Reading the whole story against the canon…', sig => continuity(storyId, sig))
  const problems = () => job.run('Looking for plot holes and open questions…', async sig => {
    const out = await completeJSON<FoundQ[]>('check', findProblems(getState(), storyId), sig)
    tx(`Raise ${plural(out.length, 'question')}`, () => {
      for (const f of out) create('question', newQuestion({
        type: (['question', 'hole', 'contradiction'] as const).includes(f.kind) ? f.kind : 'question', text: f.text, by: 'ai',
        about: [...new Set([...(f.about || []).filter(id => getState().recs[id]), storyId])],
        options: (f.options || []).map(o => ({ title: o.title, detail: o.detail, proposal: o.proposal ? normalizeProposal(getState(), o.proposal) : undefined })),
      }))
    }, false)
    showToast(out.length ? `${plural(out.length, 'question')} added to Questions` : 'No problems found in this story', false, out.length ? { label: 'Open Questions', run: () => go('questions') } : undefined)
  })

  const items: AssistRow[] = [
    { label: 'Suggest missing scenes', hint: 'Cards you can add or dismiss', dest: 'Board', run: suggest, disabled: !st.premise.trim() && !scs.length, why: 'Write a premise first' },
    { label: toDraft.length ? `Draft ${plural(toDraft.length, 'scene')} from ${toDraft.length === 1 ? 'its card' : 'their cards'}` : 'Draft scenes from their cards',
      hint: toDraft.length ? `${listNames(toDraft)}. ${locked.length ? `${plural(locked.length, 'locked scene')} skipped.` : 'Locked scenes are skipped.'}` : scs.some(x => x.card.trim()) ? 'Every scene with a card already has a current draft' : 'Write a card on a scene first',
      dest: toDraft.some(x => x.prose.trim()) ? 'Suggestions' : 'Scene text', run: draft, disabled: !toDraft.length },
    { label: toFill.length ? `Fill ${plural(toFill.length, 'card')} from text` : 'Fill cards from text', hint: toFill.length ? listNames(toFill) : hasText ? 'Every scene with text already has a card' : 'No scene has text yet', dest: 'Cards', run: fill, disabled: !toFill.length },
    { label: 'Check continuity', hint: hasText ? 'Reads the whole story against the canon' : 'Needs text in at least one scene', dest: 'Margin + Questions', run: check, disabled: !hasText },
    { label: 'Find problems', hint: 'Plot holes and open questions in this story', dest: 'Questions', run: problems },
  ]
  const ghostsHere = ghosts.filter(g => (g.data as { story?: string }).story === storyId)
  return (
    <>
      <Bar>
        <div className="ol-crumb grow"><b className="clip">{st.title || 'Untitled story'}</b><span className="lbl">Outline</span></div>
        <div className="seg" role="tablist" aria-label="View">{(['board', 'list'] as Mode[]).map(m => <button key={m} role="tab" aria-selected={mode === m} onClick={() => pick(m)}>{m === 'board' ? 'Board' : 'List'}</button>)}</div>
        <span className="bar-sep" />
        <OutlineAssist st={st} items={items} busy={job.busy} />
        <button className="btn sm" onClick={() => addIn(st, scs, group, '')}><Icon name="plus" size={14} />Scene</button>
        <span className="bar-sep" />
      </Bar>
      <div className="ol">
        <Head s={s} st={st} scs={scs} details={details} setDetails={setDetails} mode={mode} group={group} pickGroup={pickGroup} cols={cols} setCols={setCols} />
        {details && <Details s={s} st={st} scs={scs} onClose={() => setDetails(false)} />}
        {(job.busy || job.err) && <div className="ol-pad"><JobStatus job={job} /></div>}
        {cards.length > 0 && <div className="ol-pad"><ProposedChanges s={s} items={cards} onChange={setCards} title="Proposed cards" onApplied={linkAlong}
          note="Cast and events the text mentions are added with each card you apply." /></div>}
        {!scs.length && !ghostsHere.length ? <EmptyOutline st={st} onSuggest={suggest} busy={!!job.busy} />
          : mode === 'board' ? <Board s={s} st={st} scs={scs} hashes={hashes} group={group} ghosts={ghostsHere} setGhosts={g => setGhosts(all => [...all.filter(x => !ghostsHere.includes(x)), ...g])} />
            : <ListTable s={s} scs={scs} hashes={hashes} cols={cols} reorderable />}
      </div>
    </>
  )
}

// ---------------- the Assist menu, with where each result goes ----------------

type AssistRow = { label: string; hint: string; dest: string; run: () => void; disabled?: boolean; why?: string }
function OutlineAssist({ st, items, busy }: { st: Story; items: AssistRow[]; busy: string }) {
  return <AssistMenu busy={busy} items={items.map(it => ({ label: it.label, hint: it.disabled && it.why ? it.why : it.hint, dest: it.dest, run: it.run, disabled: it.disabled }))}
    title={<><span className="grow clip">Assist with {st.title || 'this story'}</span><span style={{ fontWeight: 400 }}>Results go to</span></>} />
}

// ---------------- header: title, premise, the story's properties ----------------

function Head({ s, st, scs, details, setDetails, mode, group, pickGroup, cols, setCols }: {
  s: State; st: Story; scs: Scene[]; details: boolean; setDetails: (b: boolean) => void; mode: Mode; group: Group; pickGroup: (g: Group) => void; cols: string[]; setCols: (c: string[]) => void
}) {
  const edit = (fn: (x: Story) => void) => update<'story'>(st.id, fn)
  const total = scs.reduce((n, x) => n + words(x.prose), 0)
  const guides = [...guidesFor(s, 'project'), ...guidesFor(s, 'story:' + st.id)]
  const fresh = st.title === 'Untitled story'
  return (
    <div className="ol-head">
      <input className="ol-title" value={st.title} placeholder="Untitled story" aria-label="Story title" autoFocus={fresh} onFocus={e => { if (fresh) e.target.select() }} onChange={e => edit(x => { x.title = e.target.value })} />
      <textarea className="ol-prem" value={st.premise} placeholder="What this story is, in a sentence or two" aria-label="Premise" rows={1} onChange={e => edit(x => { x.premise = e.target.value })} />
      <div className="ol-props">
        <Popover trigger={o => <button className="ol-chip" onClick={o}><span className="k">POV</span>{st.pov ? nameOf(s, st.pov) : 'None'}</button>}>{close => <div className="ol-pick">
          <button className={'menu-item' + (!st.pov ? ' on' : '')} onClick={() => { edit(x => { x.pov = undefined }); close() }}>No point-of-view character</button>
          {typeIds(s).map(t => entities(s, t).length ? <div key={t}><div className="menu-sep" /><span className="lbl ol-pick-h">{typeDef(s, t).label}</span>
            {entities(s, t).map(e => <button key={e.id} className={'menu-item' + (st.pov === e.id ? ' on' : '')} onClick={() => { edit(x => { x.pov = e.id }); close() }}>{e.name}</button>)}</div> : null)}
        </div>}</Popover>
        <Popover trigger={o => <button className="ol-chip" onClick={o}><span className="k">Form</span>{st.form === 'documents' ? 'In-world documents' : 'Prose'}</button>}>{close => <>
          {([['prose', 'Prose', 'Scenes of narrative prose'], ['documents', 'In-world documents', 'Letters, minutes, reports: the story told through artefacts']] as const).map(([id, l, h]) =>
            <button key={id} className={'menu-item' + (st.form === id ? ' on' : '')} onClick={() => { edit(x => { x.form = id }); close() }}><span className="grow">{l}<br /><span className="small muted">{h}</span></span></button>)}
        </>}</Popover>
        <Popover trigger={o => <button className="ol-chip" onClick={o}><span className="k">Words</span>{total.toLocaleString()}{st.target ? ` / ${st.target.toLocaleString()}` : ''}</button>}>{() => (
          <label className="field ol-target"><span className="lbl">Target for this story</span>
            <input className="f" type="number" min={0} step={500} autoFocus placeholder="No target" value={st.target || ''} onChange={e => edit(x => { x.target = Number(e.target.value) || undefined })} />
            <span className="hint">{total.toLocaleString()} words written across {plural(scs.length, 'scene')}</span></label>
        )}</Popover>
        <button className="ol-chip" onClick={() => setDetails(true)} title="Guides apply to every draft and check in this story"><span className="k">Guides</span>{guides.length ? `${guides[0].title}${guides.length > 1 ? ` +${guides.length - 1}` : ''}` : 'None'}</button>
        <button className="btn sm ghost" aria-expanded={details} onClick={() => setDetails(!details)}>Story details</button>
        <span className="grow" />
        <span className="lbl">Columns</span>
        {mode === 'board'
          ? <Popover className="right" trigger={o => <button className="ol-chip" onClick={o}>{GROUPS.find(g => g.id === group)!.label}<Icon name="down" size={12} /></button>}>{close => <>
            <span className="lbl ol-pick-h">Group cards by</span>
            {GROUPS.map(g => <button key={g.id} className={'menu-item' + (group === g.id ? ' on' : '')} onClick={() => { pickGroup(g.id); close() }}>{g.label}{g.id === 'beat' && !st.beats.filter(Boolean).length ? <span className="small muted">· no beats yet</span> : null}</button>)}
          </>}</Popover>
          : <ColumnPicker s={s} cols={cols} setCols={setCols} />}
      </div>
    </div>
  )
}

// ---------------- story details: what used to be the story's Settings tab ----------------

function Details({ s, st, scs, onClose }: { s: State; st: Story; scs: Scene[]; onClose: () => void }) {
  const edit = (fn: (x: Story) => void) => update<'story'>(st.id, fn)
  const scope = 'story:' + st.id
  const used = (b: string) => scs.filter(x => x.beat === b).length
  const renameBeat = (i: number, v: string) => {
    const old = st.beats[i]
    edit(x => { x.beats[i] = v })
    for (const sc of scs) if (old && sc.beat === old) update<'scene'>(sc.id, x => { x.beat = v })
  }
  const dropBeat = (i: number) => tx(`Remove beat “${st.beats[i]}”`, () => {
    const old = st.beats[i]
    edit(x => { x.beats.splice(i, 1) })
    for (const sc of scs) if (sc.beat === old) update<'scene'>(sc.id, x => { x.beat = '' })
  })
  const moveBeat = (i: number, d: number) => tx('Reorder beats', () => edit(x => { const [b] = x.beats.splice(i, 1); x.beats.splice(i + d, 0, b) }), false)
  return (
    <section className="ol-details" aria-label="Story details">
      <div className="ol-details-h"><h3>Story details</h3><span className="grow" /><button className="x" aria-label="Close story details" onClick={onClose}>×</button></div>
      <div className="ol-details-grid">
        <div className="stack">
          <div className="ol-field"><span className="lbl">Beats</span><span className="hint">The story’s shape. Each beat is a column on the board.</span>
            <div className="ol-beats">
              {st.beats.map((b, i) => (
                <span key={i} className="ol-beat">
                  <span className="n">{i + 1}</span>
                  <input className="inline" value={b} placeholder="Beat name" aria-label={`Beat ${i + 1}`} onChange={e => renameBeat(i, e.target.value)} />
                  {used(b) > 0 && <span className="lbl" style={{ fontWeight: 400 }}>{plural(used(b), 'scene')}</span>}
                  <button className="icon-btn sm" aria-label="Move earlier" disabled={i === 0} onClick={() => moveBeat(i, -1)}><Icon name="left" size={12} /></button>
                  <button className="icon-btn sm" aria-label="Move later" disabled={i === st.beats.length - 1} onClick={() => moveBeat(i, 1)}><Icon name="right" size={12} /></button>
                  <button className="x" aria-label={`Remove beat ${b}`} onClick={() => dropBeat(i)}>×</button>
                </span>
              ))}
              <button className="chip dash" onClick={() => tx('Add beat', () => edit(x => { x.beats.push('') }), false)}>+ Beat</button>
            </div>
            {!st.beats.length && <div className="row" style={{ gap: 4 }}><span className="hint">Start from a shape:</span>
              {[['Setup', 'Confrontation', 'Resolution'], ['Arrival', 'Discovery', 'Pressure', 'Turn', 'Choice'], ['Before', 'The event', 'After']].map(bs =>
                <button key={bs.join()} className="chip" onClick={() => tx('Add beats', () => edit(x => { x.beats = [...bs] }))}>{bs.join(' · ')}</button>)}</div>}
          </div>
        </div>
        <div className="stack">
          <div className="ol-field"><span className="lbl">Guides for this story</span><span className="hint">Sent with every draft and check in this story, on top of the project’s guides.</span></div>
          {guidesFor(s, 'project').length > 0 && <p className="small muted">From the project: {guidesFor(s, 'project').map(g => g.title).join(', ')}. <button className="link" onClick={() => openSettings('guides')}>Edit in Settings</button></p>}
          {guidesFor(s, scope).map(g => <GuideRow key={g.id} g={g} />)}
          <div className="row" style={{ gap: 6 }}>{(['rule', 'style'] as GuideKind[]).map(k => <button key={k} className="btn sm" onClick={() => tx('Add guide', () => { create('guide', { use: k, scope, title: k === 'rule' ? 'Rule' : 'Style', text: '' }) }, false)}>+ {k === 'rule' ? 'Rule' : 'Style guide'}</button>)}</div>
        </div>
      </div>
      <div className="ol-details-f">
        <span className="small muted grow">{plural(scs.length, 'scene')} · story {stories(s).indexOf(st) + 1} of {stories(s).length} in the project</span>
        <button className="btn sm ghost danger" onClick={() => { tx(`Delete story “${st.title}” and ${plural(scs.length, 'scene')}`, () => { scs.forEach(x => remove(x.id)); remove(st.id) }); go('home') }}><Icon name="trash" size={14} />Delete story</button>
      </div>
    </section>
  )
}

function EmptyOutline({ st, onSuggest, busy }: { st: Story; onSuggest: () => void; busy: boolean }) {
  const ai = useAI()
  return (
    <div className="ol-empty">
      <div className="ol-empty-card">
        <h2>No scenes yet</h2>
        <p className="muted">Write the premise and the beats, then add scenes yourself, or let the assistant suggest cards from the canon. Nothing is added until you accept it.</p>
        <div className="row">
          <button className="btn pri" onClick={() => addIn(st, [], 'beat', st.beats.find(Boolean) || '')}><Icon name="plus" size={14} />First scene</button>
          <button className="btn soft" disabled={busy || !st.premise.trim() || !aiReady(ai)} title={st.premise.trim() ? '' : 'Write a premise first'} onClick={onSuggest}><Spark size={13} />Suggest scenes</button>
        </div>
        {!aiReady(ai) && <ConnectPrompt what="suggest scenes" />}
      </div>
    </div>
  )
}

// ---------------- the board ----------------

const keyOf = (sc: Scene, g: Group, st?: Story) => g === 'beat' ? (st?.beats.includes(sc.beat) && sc.beat ? sc.beat : '') : g === 'status' ? (sc.status || 'todo') : g === 'label' ? (sc.label || '') : ''
interface Column { key: string; name: string; color?: string }
function columns(s: State, st: Story, scs: Scene[], g: Group): Column[] {
  if (g === 'status') return STATUSES.map(x => ({ key: x.id, name: x.label }))
  if (g === 'label') {
    const names = project(s).labels || {}
    return [...LABELS.filter(l => names[l] || scs.some(x => x.label === l)).map(l => ({ key: l, name: names[l] || l[0].toUpperCase() + l.slice(1), color: `var(--l-${l})` })), { key: '', name: 'No label' }]
  }
  if (g === 'beat') {
    const bs = [...new Set(st.beats.filter(Boolean))].map(b => ({ key: b, name: b }))
    return !bs.length || scs.some(x => !keyOf(x, 'beat', st)) ? [...bs, { key: '', name: 'No beat' }] : bs
  }
  return [{ key: '', name: '' }]
}

/** Move a scene before another (or to the end of a column), taking the column's beat, status or label. One undo step. */
function moveScene(st: Story, scs: Scene[], g: Group, cols: Column[], id: string, key: string, before?: string) {
  const rest = scs.filter(x => x.id !== id)
  const col = (sc: Scene) => cols.findIndex(c => c.key === keyOf(sc, g, st))
  let at = before ? rest.findIndex(x => x.id === before) : -1
  if (at < 0) {
    const ci = cols.findIndex(c => c.key === key)
    const inCol = g === 'order' ? rest : rest.filter(x => keyOf(x, g, st) === key)
    at = inCol.length ? rest.indexOf(inCol[inCol.length - 1]) + 1 : g === 'beat' ? (i => (i < 0 ? rest.length : i))(rest.findIndex(x => col(x) > ci)) : rest.length
  }
  const ids = rest.map(x => x.id)
  ids.splice(at, 0, id)
  const sc = scs.find(x => x.id === id)!
  const patch = g === 'order' || keyOf(sc, g, st) === key ? null : g
  tx(patch ? `Move “${sc.title}” to ${cols.find(c => c.key === key)?.name}` : 'Reorder scenes', () => {
    if (patch === 'beat') update<'scene'>(id, x => { x.beat = key })
    if (patch === 'status') update<'scene'>(id, x => { x.status = key as SceneStatus })
    if (patch === 'label') update<'scene'>(id, x => { x.label = key || undefined })
    ids.forEach((x, i) => { if (get(getState(), x, 'scene')!.order !== i + 1) update<'scene'>(x, y => { y.order = i + 1 }) })
  })
}

/** A new scene at the end of a column, carrying the column's beat, status or label; opens it in the editor. */
function addIn(st: Story, scs: Scene[], g: Group, key: string) {
  const inCol = g === 'order' ? scs : scs.filter(x => keyOf(x, g, st) === key)
  const last = inCol[inCol.length - 1], next = last ? scs[scs.indexOf(last) + 1] : undefined
  const order = !last ? (scs.length ? scs[scs.length - 1].order + 1 : 1) : next ? (last.order + next.order) / 2 : last.order + 1
  const patch = g === 'beat' ? { beat: key } : g === 'status' ? { status: key as SceneStatus } : g === 'label' && key ? { label: key } : {}
  let id = ''
  tx('New scene', () => { id = create('scene', newScene(st.id, order, { cast: st.pov ? [st.pov] : [], ...patch })) })
  go('scene/' + id)
}

function useMove(onDrop: (id: string, key: string, before?: string) => void) {
  const drag = useRef<string>(undefined)
  const [over, setOver] = useState<string>()
  const end = () => { drag.current = undefined; setOver(undefined) }
  const drop = (key: string, before?: string) => { const id = drag.current; end(); if (id && id !== before) onDrop(id, key, before) }
  const card = (id: string, key: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { drag.current = id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id) },
    onDragOver: (e: React.DragEvent) => { if (drag.current) { e.preventDefault(); e.stopPropagation(); setOver(id) } },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); drop(key, id) },
    onDragEnd: end,
  })
  const col = (key: string) => ({
    onDragOver: (e: React.DragEvent) => { if (drag.current) { e.preventDefault(); setOver('col:' + key) } },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); drop(key) },
  })
  return { card, col, over, dragging: () => !!drag.current }
}

function Board({ s, st, scs, hashes, group, ghosts, setGhosts }: { s: State; st: Story; scs: Scene[]; hashes: Record<string, string>; group: Group; ghosts: Proposal[]; setGhosts: (g: Proposal[]) => void }) {
  const cols = columns(s, st, scs, group)
  const mv = useMove((id, key, before) => moveScene(st, scs, group, cols, id, key, before))
  const notes = openNotes(s)
  // A suggestion sits in its beat's column, else after the scene it follows.
  const ghostKey = (g: Proposal) => {
    const d = g.data as { beat?: string; order?: number; status?: string; label?: string }
    if (group === 'beat') return d.beat && st.beats.includes(d.beat) ? d.beat : keyOf([...scs].reverse().find(x => x.order < (d.order ?? 0)) || ({ beat: '' } as Scene), 'beat', st)
    return group === 'status' ? 'todo' : group === 'label' ? (d.label || '') : ''
  }
  const add = (g: Proposal, key: string) => {
    const p = group === 'beat' && key ? { ...g, data: { ...g.data, beat: key } } : g
    tx('Add suggested scene', () => applyProposal(p))
    setGhosts(ghosts.filter(x => x !== g))
  }
  return (
    <div className={group === 'order' ? 'ol-flow' : 'ol-board'} style={group === 'order' ? undefined : { gridTemplateColumns: `repeat(${cols.length}, minmax(208px, 1fr))` }}>
      {cols.map(c => {
        const items = scs.filter(x => group === 'order' || keyOf(x, group, st) === c.key)
        const gs = ghosts.filter(g => group === 'order' || ghostKey(g) === c.key)
        const body = <>
          {items.map(sc => <Card key={sc.id} s={s} sc={sc} n={scs.indexOf(sc) + 1} hash={hashes[sc.id]} notes={notes[sc.id] || 0} over={mv.over === sc.id} drag={mv.card(sc.id, c.key)} />)}
          {gs.map((g, i) => <Ghost key={'g' + i} g={g} onAdd={() => add(g, ghostKey(g))} onDismiss={() => setGhosts(ghosts.filter(x => x !== g))} />)}
          <button className={'ol-add' + (mv.over === 'col:' + c.key ? ' over' : '')} onClick={() => addIn(st, scs, group, c.key)} {...mv.col(c.key)}>+ Scene</button>
        </>
        if (group === 'order') return <div key="flow" className="ol-flow-in">{body}</div>
        return (
          <div key={c.key || '-'} className={'ol-col' + (mv.over === 'col:' + c.key ? ' over' : '')} {...mv.col(c.key)}>
            <div className="ol-colh">{c.color && <i className="dot" style={{ background: c.color }} />}<b className="clip">{c.name}</b>
              <span className="lbl">{items.length}{gs.length ? ` + ${gs.length} suggested` : ''}</span></div>
            {body}
          </div>
        )
      })}
    </div>
  )
}

function Card({ s, sc, n, hash, notes, over, drag }: { s: State; sc: Scene; n?: number; hash?: string; notes: number; over?: boolean; drag?: ReturnType<ReturnType<typeof useMove>['card']> }) {
  const b = builtState(sc, hash)
  const st = statusOf(sc)
  const ready = !sc.pinned && sc.card.trim() && !sc.prose.trim()
  const label = sc.label ? project(s).labels?.[sc.label] || sc.label : undefined
  return (
    <a className={'ol-card' + (over ? ' over' : '')} href={'#scene/' + sc.id} title={label ? `Label: ${label}` : undefined} {...drag}>
      {sc.label && <span className="stripe" style={{ background: labelColor(sc.label) }} />}
      <span className="ol-card-top"><span className="lbl">{n ?? nameOf(s, sc.story)}</span>{sc.pinned && <span className="ol-lock" title="Locked: the assistant won’t redraft it"><Icon name="lock" size={12} />Locked</span>}</span>
      <h4>{sc.title || 'Untitled scene'}</h4>
      {sc.card.trim() ? <p>{sc.card}</p> : sc.prose.trim() ? <p className="ex">{excerpt(sc)}…</p> : <p className="none">No card yet. What happens?</p>}
      <span className="ol-ft">
        <span className={'ol-pill ' + st.id}>{st.label}</span>
        {sc.prose.trim() && <span className="wc">{words(sc.prose).toLocaleString()}{sc.target ? ` / ${sc.target.toLocaleString()}` : ''} words</span>}
        {notes > 0 && <span className="wc warn">{plural(notes, 'note')}</span>}
        {ready ? <span className="wc ai">Ready to draft</span> : BUILT[b].label && <span className={'wc ' + BUILT[b].cls} title={BUILT[b].hint}>{BUILT[b].label}</span>}
      </span>
    </a>
  )
}

function Ghost({ g, onAdd, onDismiss }: { g: Proposal; onAdd: () => void; onDismiss: () => void }) {
  const d = g.data as { title?: string; card?: string }
  return (
    <div className="ol-ghost">
      <span className="ol-sugg"><Spark size={12} />Suggested</span>
      <h4>{d.title || 'Untitled scene'}</h4>
      {d.card && <p>{d.card}</p>}
      {g.why && <p className="why">{g.why}</p>}
      <span className="row" style={{ gap: 6 }}><button className="btn sm ai" onClick={onAdd}>Add</button><button className="btn sm ghost" onClick={onDismiss}>Dismiss</button></span>
    </div>
  )
}

// ---------------- the list ----------------

type Col = { id: string; label: string; get: (sc: Scene) => string | number; render?: (sc: Scene) => ReactNode }
function allColumns(s: State, hashes: Record<string, string>, withStory: boolean): Col[] {
  const labels = project(s).labels || {}
  const notes = openNotes(s)
  const short = (id: string) => { const f = get(s, id, 'fact'); return f?.at !== undefined ? eventCode(s, id) : (nameOf(s, id) || 'Missing').slice(0, 24) }
  return [
    ...(withStory ? [{ id: 'story', label: 'Story', get: (sc: Scene) => nameOf(s, sc.story) }] : []),
    { id: 'beat', label: 'Beat', get: sc => sc.beat },
    { id: 'status', label: 'Status', get: sc => STATUSES.findIndex(x => x.id === (sc.status || 'todo')), render: sc => <span className={'ol-pill ' + statusOf(sc).id}>{statusOf(sc).label}</span> },
    { id: 'card', label: 'Card', get: sc => sc.card, render: sc => <span className="small">{sc.card || <i className="faint">{sc.prose.trim() ? 'No card' : 'No card yet'}</i>}</span> },
    { id: 'words', label: 'Words', get: sc => words(sc.prose), render: sc => <span className="ol-num">{words(sc.prose).toLocaleString()}{sc.target ? <><span className="faint"> / {sc.target.toLocaleString()}</span><span className="bar" style={{ display: 'block', marginTop: 4 }}><i style={{ width: Math.min(100, (words(sc.prose) / sc.target) * 100) + '%' }} /></span></> : null}</span> },
    { id: 'cast', label: 'Cast', get: sc => sc.cast.map(c => nameOf(s, c)).join(', '), render: sc => <span className="small">{sc.cast.map(c => nameOf(s, c)).join(' · ')}</span> },
    { id: 'links', label: 'Shows', get: sc => Object.keys(sc.links).length, render: sc => <span className="small">{Object.entries(sc.links).map(([id, h], i) => <span key={id}>{i ? ' · ' : ''}{h === 'felt' ? <span className="muted">felt </span> : ''}{short(id)}</span>)}</span> },
    { id: 'label', label: 'Label', get: sc => sc.label || '', render: sc => sc.label ? <span className="row nowrap" style={{ gap: 6 }}><i className="dot" style={{ background: labelColor(sc.label) }} />{labels[sc.label] || sc.label}</span> : '' },
    { id: 'notes', label: 'Notes', get: sc => notes[sc.id] || 0, render: sc => notes[sc.id] ? <span className="warn-text">{notes[sc.id]}</span> : '' },
    { id: 'draft', label: 'Draft', get: sc => builtState(sc, hashes[sc.id]), render: sc => { const b = builtState(sc, hashes[sc.id]); return BUILT[b].label ? <span className={'chip ' + BUILT[b].cls} title={BUILT[b].hint}>{BUILT[b].label}</span> : '' } },
    { id: 'locked', label: 'Locked', get: sc => (sc.pinned ? 1 : 0), render: sc => (sc.pinned ? <Icon name="lock" size={13} /> : '') },
    { id: 'tags', label: 'Tags', get: sc => (sc.tags || []).join(', ') },
    { id: 'target', label: 'Target', get: sc => sc.target || 0, render: sc => sc.target?.toLocaleString() || '' },
    { id: 'export', label: 'Leave out of export', get: sc => (sc.exclude ? 1 : 0), render: sc => (sc.exclude ? 'Left out' : '') },
    ...(project(s).sceneFields || []).map(f => ({ id: 'm:' + f.key, label: f.label, get: (sc: Scene) => sc.meta?.[f.key] || '' })),
  ]
}

function ColumnPicker({ s, cols, setCols, withStory }: { s: State; cols: string[]; setCols: (c: string[]) => void; withStory?: boolean }) {
  const all = allColumns(s, {}, !!withStory)
  const toggleCol = (id: string) => { const next = cols.includes(id) ? cols.filter(x => x !== id) : [...cols, id]; store('canon.outline.cols', next.join(',')); setCols(next) }
  return (
    <Popover className="right" trigger={o => <button className="ol-chip" onClick={o}>{all.filter(c => cols.includes(c.id)).length} shown<Icon name="down" size={12} /></button>}>{() => <>
      <span className="lbl ol-pick-h">Show columns</span>
      {all.map(c => <label key={c.id} className="menu-item"><input type="checkbox" checked={cols.includes(c.id)} onChange={() => toggleCol(c.id)} />{c.label}</label>)}
    </>}</Popover>
  )
}

function ListTable({ s, scs, hashes, cols, reorderable, withStory }: { s: State; scs: Scene[]; hashes: Record<string, string>; cols: string[]; reorderable?: boolean; withStory?: boolean }) {
  const all = allColumns(s, hashes, !!withStory)
  const [sort, setSort] = useState<{ id: string; dir: 1 | -1 }>()
  const shown = all.filter(c => cols.includes(c.id) || (withStory && c.id === 'story'))
  const rows = sort ? [...scs].sort((a, b) => { const c = all.find(x => x.id === sort.id)!; const x = c.get(a), y = c.get(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir }) : scs
  const st = reorderable ? get(s, scs[0]?.story, 'story') : undefined
  const mv = useMove((id, _k, before) => { if (st) moveScene(st, scs, 'order', [{ key: '', name: '' }], id, '', before) })
  const drag = reorderable && !sort
  return (
    <div className="ol-list">
      {sort && <div className="row" style={{ marginBottom: 8 }}><span className="small muted">Sorted by {all.find(c => c.id === sort.id)?.label.toLowerCase()}</span><button className="btn sm ghost" onClick={() => setSort(undefined)}>Back to story order</button></div>}
      <div className="tablewrap">
        <table className="mx ol-table">
          <thead><tr>{drag && <th aria-label="Drag to reorder" />}<th>#</th><th>Scene</th>{shown.map(c => <th key={c.id}><button onClick={() => setSort(x => (x?.id === c.id ? (x.dir === 1 ? { id: c.id, dir: -1 } : undefined) : { id: c.id, dir: 1 }))}>{c.label}{sort?.id === c.id ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</button></th>)}</tr></thead>
          <tbody>{rows.map(sc => (
            <tr key={sc.id} className={'click' + (mv.over === sc.id ? ' over' : '')} onClick={() => go('scene/' + sc.id)} {...(drag ? mv.card(sc.id, '') : {})}>
              {drag && <td className="ol-handle" title="Drag to reorder"><Icon name="drag" size={14} /></td>}
              <td className="mono faint">{withStory ? scenesOf(s, sc.story).indexOf(sc) + 1 : scs.indexOf(sc) + 1}</td>
              <td className="ol-name"><b>{sc.title || 'Untitled scene'}</b>{sc.pinned && <span className="ol-lock" title="Locked"><Icon name="lock" size={11} /></span>}</td>
              {shown.map(c => <td key={c.id}>{c.render ? c.render(sc) : String(c.get(sc))}</td>)}
            </tr>))}</tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------- collections: saved filters over scenes ----------------

export function CollectionView({ s, id }: { s: State; id: string }) {
  const c = (project(s).collections || []).find(x => x.id === id)
  const [cols, setCols] = useState<string[]>(() => stored('canon.outline.cols', 'beat,status,card,words,cast').split(','))
  if (!c) return <><Bar /><div className="empty"><h2>Not found</h2><p>It may have been deleted, or undone.</p><a className="btn" href="#home">Back to Home</a></div></>
  const set = (fn: (f: Filter & { name?: string }) => void, label = 'Edit collection') => tx(label, () => update<'project'>('project', x => {
    const col = x.collections!.find(y => y.id === id)!
    const f: Filter & { name?: string } = { ...col.filter, name: col.name }
    fn(f); col.name = f.name || ''; delete f.name; col.filter = f
  }), false)
  const f = c.filter
  const hits = matchScenes(s, f)
  const clear = (k: keyof Filter) => <button className="x" aria-label="Clear" onClick={() => set(x => { delete x[k] })}>×</button>
  return (
    <>
      <Bar>
        <div className="ol-crumb grow"><b className="clip">{c.name || 'Untitled collection'}</b><span className="lbl">Collection</span></div>
        <button className="btn sm ghost danger" onClick={() => { tx(`Delete collection “${c.name}”`, () => update<'project'>('project', x => { x.collections = x.collections!.filter(y => y.id !== id) })); go('home') }}><Icon name="trash" size={14} />Delete</button>
        <span className="bar-sep" />
      </Bar>
      <div className="ol">
        <div className="ol-head">
          <input className="ol-title" value={c.name} placeholder="Untitled collection" aria-label="Collection name" onChange={e => set(x => { x.name = e.target.value })} />
          <p className="ol-sub">{plural(hits.length, 'scene')} match, and the list updates as you write. A collection never changes the scenes in it.</p>
          <div className="ol-props">
            <label className="ol-chip ol-q"><span className="k">Text</span><input className="inline" value={f.q || ''} placeholder="contains…" aria-label="Text contains" onChange={e => set(x => { x.q = e.target.value || undefined })} /></label>
            <Popover trigger={o => <span className="ol-chip-wrap"><button className="ol-chip" onClick={o}><span className="k">Story</span>{f.story ? nameOf(s, f.story) : 'Any'}</button>{f.story && clear('story')}</span>}>{close => <>
              <button className="menu-item" onClick={() => { set(x => { x.story = undefined }); close() }}>Any story</button>
              {stories(s).map(x => <button key={x.id} className={'menu-item' + (f.story === x.id ? ' on' : '')} onClick={() => { set(y => { y.story = x.id }); close() }}>{x.title}</button>)}</>}</Popover>
            <Popover trigger={o => <span className="ol-chip-wrap"><button className="ol-chip" onClick={o}><span className="k">Status</span>{f.status ? STATUSES.find(x => x.id === f.status)?.label : 'Any'}</button>{f.status && clear('status')}</span>}>{close => <>
              <button className="menu-item" onClick={() => { set(x => { x.status = undefined }); close() }}>Any status</button>
              {STATUSES.map(x => <button key={x.id} className={'menu-item' + (f.status === x.id ? ' on' : '')} onClick={() => { set(y => { y.status = x.id }); close() }}>{x.label}</button>)}</>}</Popover>
            <Popover trigger={o => <span className="ol-chip-wrap"><button className="ol-chip" onClick={o}><span className="k">Label</span>{f.label ? <><i className="dot" style={{ background: labelColor(f.label) }} />{project(s).labels?.[f.label] || f.label}</> : 'Any'}</button>{f.label && clear('label')}</span>}>{close => <>
              <button className="menu-item" onClick={() => { set(x => { x.label = undefined }); close() }}>Any label</button>
              {LABELS.map(l => <button key={l} className={'menu-item' + (f.label === l ? ' on' : '')} onClick={() => { set(y => { y.label = l }); close() }}><i className="dot" style={{ background: labelColor(l) }} />{project(s).labels?.[l] || l}</button>)}</>}</Popover>
            <label className="ol-chip ol-q"><span className="k">Tag</span><input className="inline" value={f.tag || ''} placeholder="any" aria-label="Tag" onChange={e => set(x => { x.tag = e.target.value || undefined })} /></label>
            {f.cast ? <span className="ol-chip on"><span className="k">With</span>{nameOf(s, f.cast)}{clear('cast')}</span>
              : <RecordPicker s={s} kinds={['entity']} label="+ With someone or something" onPick={v => set(x => { x.cast = v })} />}
            {f.fact ? <span className="ol-chip on"><span className="k">Shows</span>{nameOf(s, f.fact).slice(0, 40)}{clear('fact')}</span>
              : <RecordPicker s={s} kinds={['fact']} label="+ Shows an event or fact" onPick={v => set(x => { x.fact = v })} />}
            <label className="ol-chip"><input type="checkbox" checked={!!f.exclude} onChange={e => set(x => { x.exclude = e.target.checked || undefined })} />Left out of export only</label>
            <span className="grow" />
            <span className="lbl">Columns</span><ColumnPicker s={s} cols={cols} setCols={setCols} withStory />
          </div>
        </div>
        {hits.length ? <ListTable s={s} scs={hits} hashes={{}} cols={cols} withStory />
          : <div className="ol-empty"><div className="ol-empty-card"><h2>No scenes match yet</h2><p className="muted">Loosen a filter, or keep writing: scenes join the collection as soon as they match.</p></div></div>}
      </div>
    </>
  )
}
