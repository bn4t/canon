import { useState, type DragEvent, type ReactNode } from 'react'
import {
  update, create, remove, tx, get, getState, events, eventCode, stories, scenesOf, allScenes, nameOf, knowers, plainFacts, readerLearns, questionsAbout,
  newFact, nextAt, sceneRef, entities,
  type State, type Fact, type Proposal,
} from '../store.ts'
import { completeJSON } from '../ai.ts'
import { suggestFacts, normalizeProposal } from '../prompts.ts'
import { Bar, AssistMenu, ProposedChanges, Popover, Icon, JobStatus, useJob, Empty, go, toggle } from '../ui.tsx'
import { RecordPicker, History, KnowledgeChip, Av, factCode, findProblemsInto, AIButton, kindLabel } from './shared.tsx'
import './timeline.css'

type Lens = 'stories' | 'knowledge'
const route = (lens: Lens, id?: string) => (lens === 'knowledge' ? 'knowledge' : 'timeline') + (id ? '/' + id : '')
const firstLine = (t: string) => { const x = t.split(/(?<=[.;!?])\s/)[0].trim(); return x.length > 90 ? x.slice(0, 88) + '…' : x.replace(/\.$/, '') }
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

function addEvent(lens: Lens) {
  let id = ''
  tx('New event', () => { const s = getState(); id = create('fact', newFact({ text: 'New event', at: nextAt(s), causes: events(s).slice(-1).map(e => e.id) })) })
  go(route(lens, id))
}
function addFact(lens: Lens) {
  let id = ''
  tx('New fact', () => { id = create('fact', newFact({ text: 'New fact' })) })
  go(route(lens, id))
}
/** Move an event before or after another; `at` is renumbered 1…n in world order, codes stay. */
function moveEvent(dragId: string, targetId: string, after: boolean) {
  const s = getState()
  const ids = events(s).map(e => e.id).filter(id => id !== dragId)
  const i = ids.indexOf(targetId)
  ids.splice(i < 0 ? ids.length : i + (after ? 1 : 0), 0, dragId)
  tx(`Move ${eventCode(s, dragId)}`, () => ids.forEach((id, n) => { if (get(getState(), id, 'fact')!.at !== n + 1) update<'fact'>(id, x => { x.at = n + 1 }) }))
}
/** A scene dragged from the sidebar carries its #scene/<id> link. */
const droppedScene = (e: DragEvent) => {
  const t = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
  return t.match(/#scene\/([^/\s]+)/)?.[1]
}

// ---------------- the page: one table, two lenses, one inspector ----------------

export function TimelineView({ s, sel, lens = 'stories' }: { s: State; sel?: string; lens?: Lens }) {
  const job = useJob()
  const [props, setProps] = useState<Proposal[]>([])
  const f = get(s, sel, 'fact')
  const suggest = () => job.run('Looking for secrets and misbeliefs…', async sig => {
    const out = (await completeJSON<Proposal[]>('assist', suggestFacts(getState()), sig)).map(p => normalizeProposal(getState(), p))
    setProps(out)
    if (!out.length) job.setErr('Nothing to add: the canon already covers it.')
  })
  const problems = () => job.run('Looking for problems in the timeline…', sig => findProblemsInto(undefined, sig).then(() => {}))
  const empty = !events(s).length && !plainFacts(s).length
  return (
    <>
      <Bar>
        <div className="grow" style={{ fontWeight: 500 }}>Timeline</div>
        <div className="seg" role="tablist" aria-label="Lens">
          <button role="tab" aria-selected={lens === 'stories'} className={lens === 'stories' ? 'on' : ''} onClick={() => go(route('stories', f?.id))}>Stories</button>
          <button role="tab" aria-selected={lens === 'knowledge'} className={lens === 'knowledge' ? 'on' : ''} onClick={() => go(route('knowledge', f?.id))}>Knowledge</button>
        </div>
        <span className="bar-sep" />
        <AssistMenu busy={job.busy} items={[
          { label: 'Suggest facts', hint: 'Secrets and misbeliefs the canon is missing', dest: 'Proposed changes', run: suggest },
          { label: 'Find problems', hint: 'Plot holes and contradictions across the canon', dest: 'Questions', run: problems },
        ]} />
        {lens === 'stories' ? <button className="btn sm" onClick={() => addEvent(lens)}><Icon name="plus" size={14} />Event</button>
          : <button className="btn sm" onClick={() => addFact(lens)}><Icon name="plus" size={14} />Fact</button>}
        <span className="bar-sep" />
      </Bar>
      <div className="tl-page">
        <div className="tl-main">
          <JobStatus job={job} />
          <ProposedChanges s={s} items={props} onChange={setProps} title="Suggested facts" />
          {empty ? <Empty title="Nothing on the timeline yet">
            <p>An event is a fact with a place in world order: it happens, it has causes, and characters know about it or don’t. An undated fact is true throughout, like a secret.</p>
            <div className="row"><button className="btn pri" onClick={() => addEvent(lens)}>Add the first event</button><button className="btn" onClick={() => addFact(lens)}>Add a fact</button></div>
          </Empty> : lens === 'stories' ? <StoriesTable s={s} sel={f?.id} /> : <KnowledgeTable s={s} sel={f?.id} />}
        </div>
        {f && <Inspector key={f.id} s={s} f={f} lens={lens} />}
      </div>
    </>
  )
}
/** @deprecated The knowledge lens is part of the timeline now. */
export const KnowledgeView = ({ s }: { s: State }) => <TimelineView s={s} lens="knowledge" />

/** Shared row drag state: drop above or below the row under the pointer. */
function useRowDrag() {
  const [drag, setDrag] = useState<string>()
  const [over, setOver] = useState<{ id: string; after: boolean }>()
  const end = () => { setDrag(undefined); setOver(undefined) }
  const row = (id: string, dated: boolean) => !dated ? {} : {
    draggable: true,
    onDragStart: (e: DragEvent) => { if ((e.target as HTMLElement).closest?.('a, button')) return; setDrag(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-canon-event', id) },
    onDragOver: (e: DragEvent) => { if (!drag) return; e.preventDefault(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setOver({ id, after: e.clientY > r.top + r.height / 2 }) },
    onDrop: (e: DragEvent) => { if (!drag) return; e.preventDefault(); if (drag !== id && over) moveEvent(drag, id, over.after); end() },
    onDragEnd: end,
  }
  const cls = (id: string) => (drag === id ? ' dragging' : '') + (over?.id === id && drag !== id ? (over.after ? ' over-after' : ' over-before') : '')
  return { row, cls, dragging: !!drag }
}

function Group({ title, sub }: { title: string; sub: string }) {
  return <div className="tl-grp" role="row"><span>{title}</span><span>{sub}</span></div>
}

function Code({ s, f, on }: { s: State; f: Fact; on?: boolean }) { return <span className={'ecode' + (on ? ' on' : '')}>{factCode(s, f.id)}</span> }

// ---------------- Stories lens: which scenes show each event ----------------

function StoriesTable({ s, sel }: { s: State; sel?: string }) {
  const sts = stories(s)
  const d = useRowDrag()
  const [drop, setDrop] = useState<string>()
  const cols = `26px minmax(240px, 1.9fr) repeat(${sts.length}, minmax(150px, 1fr))`
  const cells = (f: Fact) => sts.map(st => {
    const key = st.id + f.id
    return (
      <div key={key} className={'tl-cell' + (drop === key ? ' drop' : '')} role="cell"
        onDragOver={e => { if (!d.dragging && e.dataTransfer.types.includes('text/uri-list')) { e.preventDefault(); setDrop(key) } }}
        onDragLeave={() => setDrop(undefined)}
        onDrop={e => { const id = droppedScene(e); setDrop(undefined); if (!id || !get(s, id, 'scene')) return; e.preventDefault(); tx(`Show ${factCode(s, f.id)} in “${nameOf(s, id)}”`, () => update<'scene'>(id, x => { x.links[f.id] ??= 'on' })) }}>
        {scenesOf(s, st.id).map((sc, i) => sc.links[f.id] && (
          <a key={sc.id} className={'tl-s' + (sc.links[f.id] === 'felt' ? ' felt' : '')} href={'#scene/' + sc.id} title={sc.card || sc.title} onClick={e => e.stopPropagation()}><span>{i + 1}</span>{sc.title || 'Untitled scene'}</a>
        ))}
      </div>
    )
  })
  const row = (f: Fact, dated: boolean) => {
    const open = questionsAbout(s, f.id).filter(q => !q.answer && !q.dismissed)
    const anyScene = allScenes(s).some(sc => sc.links[f.id])
    const causes = f.causes.map(id => eventCode(s, id)).filter(Boolean)
    const decided = Object.values(f.knows).filter(c => c.state).length
    const sub = dated ? [causes.length ? '← ' + causes.join(', ') : '', !anyScene ? 'Not shown in any scene' : f.detail ? firstLine(f.detail) : ''].filter(Boolean).join(' · ')
      : [firstLine(f.detail) || 'A secret', decided ? plural(decided, 'person', 'people') + ' decided' : ''].filter(Boolean).join(' · ')
    return (
      <div key={f.id} role="row" className={'tl-row' + (f.id === sel ? ' sel' : '') + d.cls(f.id)} style={{ gridTemplateColumns: cols }}
        onClick={() => go(route('stories', f.id === sel ? undefined : f.id))} {...d.row(f.id, dated)}>
        <div className="tl-drag" aria-hidden="true">{dated && <Icon name="drag" size={14} />}</div>
        <div className="tl-ev" role="cell">
          <span className="top"><Code s={s} f={f} on={f.id === sel} /><b className="clip">{f.text || 'Untitled'}</b>
            {open.length > 0 && <a className="tl-qb" href={'#questions/' + open[0].id} onClick={e => e.stopPropagation()}>{plural(open.length, 'question')}</a>}</span>
          {sub && <span className="tl-cz">{sub}</span>}
        </div>
        {cells(f)}
      </div>
    )
  }
  return (
    <>
      <div className="tl-table" role="table" aria-label="Events by story">
        <div className="tl-row tl-head" role="row" style={{ gridTemplateColumns: cols }}>
          <div /><div>Event</div>
          {sts.map(st => <div key={st.id}><a href={'#story/' + st.id}><b className="clip">{st.title || 'Untitled story'}</b></a>
            {st.form === 'documents' ? 'Documents' : [st.pov ? nameOf(s, st.pov).split(' ')[0] : '', plural(scenesOf(s, st.id).length, 'scene')].filter(Boolean).join(' · ')}</div>)}
        </div>
        {plainFacts(s).length > 0 && <><Group title="Undated facts" sub="true throughout; no place in world order" />{plainFacts(s).map(f => row(f, false))}</>}
        {events(s).length > 0 && <><Group title="In world order" sub="drag to reorder · codes stay with their event" />{events(s).map(f => row(f, true))}</>}
      </div>
      <div className="tl-legend">
        <span className="row nowrap" style={{ gap: 6 }}><span className="tl-s sw" />Shown on the page</span>
        <span className="row nowrap" style={{ gap: 6 }}><span className="tl-s felt sw" />Felt: the effect, not the event</span>
        <span>Link scenes from the scene card, or drag a scene from the sidebar onto a cell</span>
      </div>
    </>
  )
}

// ---------------- Knowledge lens: who knows what, and from where ----------------

function KnowledgeTable({ s, sel }: { s: State; sel?: string }) {
  const [extra, setExtra] = useState<string[]>([])
  const base = knowers(s).map(e => e.id)
  const who = [...base, ...extra.filter(id => get(s, id, 'entity') && !base.includes(id))]
  const cols = `26px minmax(220px, 1.7fr) repeat(${who.length}, minmax(130px, 1fr)) 92px minmax(160px, 1fr)`
  const reader = (f: Fact) => {
    const r = readerLearns(s, f.id)
    if (r) return <a className="tl-rl" href={'#scene/' + r.id} onClick={e => e.stopPropagation()}><span>{sceneRef(s, r).replace(' · ', '·')}</span>{r.title}</a>
    return <span className="tl-rl none">{allScenes(s).some(sc => sc.links[f.id] === 'felt') ? 'Felt only' : 'Not on the page yet'}</span>
  }
  const row = (f: Fact) => (
    <div key={f.id} role="row" className={'tl-row k' + (f.id === sel ? ' sel' : '')} style={{ gridTemplateColumns: cols }} onClick={() => go(route('knowledge', f.id === sel ? undefined : f.id))}>
      <div />
      <div className="tl-ev" role="cell"><span className="top"><Code s={s} f={f} on={f.id === sel} /><b className="clip">{f.text || 'Untitled'}</b></span></div>
      {who.map(k => <div key={k} className="tl-kc" role="cell" onClick={e => e.stopPropagation()}><KnowledgeChip s={s} f={f} who={k} withNote /></div>)}
      <div />
      <div role="cell">{reader(f)}</div>
    </div>
  )
  return (
    <>
      <div className="tl-legend k">
        <span className="lbl">Who knows what, and from which story on. Drafts and checks enforce it.</span><span className="grow" />
        <span className="kst knows">Knows</span><span className="kst almost">Almost</span><span className="kst believes">Believes otherwise</span><span className="kst never">Never</span><span>Empty = not decided</span>
      </div>
      <div className="tl-table" role="table" aria-label="Knowledge by character">
        <div className="tl-row tl-head" role="row" style={{ gridTemplateColumns: cols }}>
          <div /><div>Fact or event</div>
          {who.map(k => <div key={k} className="row nowrap" style={{ gap: 6 }}><Av name={nameOf(s, k)} /><a className="clip" href={'#world/' + k}>{nameOf(s, k).split(' ')[0]}</a></div>)}
          <div><RecordPicker s={s} kinds={['entity']} label="+ Person" exclude={who} onPick={id => setExtra(x => [...x, id])} /></div>
          <div>Reader learns in</div>
        </div>
        {plainFacts(s).length > 0 && <><Group title="Undated facts" sub="" />{plainFacts(s).map(row)}</>}
        {events(s).length > 0 && <><Group title="In world order" sub="" />{events(s).map(row)}</>}
      </div>
      {!who.length && <p className="small muted">Add a person to track what they know. Story narrators are added for you.</p>}
    </>
  )
}

// ---------------- the inspector: one fact or event ----------------

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="tl-f"><span className="lbl">{label}</span>{children}</div>
}

function Inspector({ s, f, lens }: { s: State; f: Fact; lens: Lens }) {
  const evs = events(s)
  const dated = f.at !== undefined
  const i = evs.indexOf(f)
  const edit = (fn: (x: Fact) => void) => update<'fact'>(f.id, fn)
  const code = factCode(s, f.id)
  const scs = allScenes(s).filter(sc => sc.links[f.id])
  const leads = evs.filter(e => e.causes.includes(f.id))
  const who = Object.keys(f.knows).filter(k => get(s, k, 'entity'))
  const qs = questionsAbout(s, f.id).filter(q => !q.answer && !q.dismissed)
  const job = useJob()
  const close = () => go(route(lens))
  const addDate = () => tx(`Add a date to ${code}`, () => edit(x => { x.at = nextAt(getState()); x.causes = [] }))
  const removeDate = () => tx(`Remove the date from ${code}`, () => edit(x => { delete x.at; x.causes = [] }))
  const unlink = (id: string) => tx(`Stop showing ${code} in “${nameOf(s, id)}”`, () => update<'scene'>(id, x => { delete x.links[f.id] }))
  const flip = (id: string) => tx(`Change how “${nameOf(s, id)}” shows ${code}`, () => update<'scene'>(id, x => { x.links[f.id] = x.links[f.id] === 'felt' ? 'on' : 'felt' }))
  return (
    <aside className="tl-insp" aria-label={`${dated ? 'Event' : 'Fact'} ${code}`}>
      <div className="row nowrap">
        <span className="ecode on">{code}</span>
        <span className="lbl grow" style={{ fontWeight: 400 }}>{dated ? `${i + 1} of ${evs.length} in world order` : 'Undated fact'}</span>
        {!dated && <button className="btn sm" onClick={addDate}>Add a date</button>}
        <Popover className="right" trigger={o => <button className="icon-btn" aria-label="More" title="More" onClick={o}><Icon name="more" /></button>}>
          {c => <>
            {dated ? <button className="menu-item" onClick={() => { c(); removeDate() }}>Remove date<span className="grow" /><span className="small muted">keeps it as an undated fact</span></button>
              : <button className="menu-item" onClick={() => { c(); addDate() }}>Add a date</button>}
            <div className="menu-sep" />
            <button className="menu-item danger" onClick={() => { c(); tx(`Delete ${code}`, () => remove(f.id)); close() }}>Delete {dated ? 'event' : 'fact'}</button>
          </>}
        </Popover>
        <button className="icon-btn" aria-label="Close" title="Close" onClick={close}><Icon name="close" /></button>
      </div>
      <textarea className="inline tl-title" value={f.text} placeholder={dated ? 'What happens' : 'What is true'} aria-label={dated ? 'Event' : 'Fact'} onChange={e => edit(x => { x.text = e.target.value })} />
      <textarea className="inline tl-detail" value={f.detail} placeholder={dated ? 'How it happens, what it changes' : 'Detail'} aria-label="Detail" onChange={e => edit(x => { x.detail = e.target.value })} />
      {dated && <Field label="Caused by">
        <div className="tl-chips">
          {f.causes.map(id => get(s, id, 'fact') && <span key={id} className="chip"><a href={'#' + route(lens, id)}><span className="mono muted">{eventCode(s, id)}</span> {nameOf(s, id).replace(/^E\d+ /, '')}</a>
            <button className="x" style={{ fontSize: 13, padding: 0 }} aria-label="Remove cause" onClick={() => tx(`Remove a cause of ${code}`, () => edit(x => { x.causes = x.causes.filter(y => y !== id) }))}>×</button></span>)}
          {i > 0 && <Popover trigger={o => <button className="chip dash" aria-label="Add a cause" onClick={o}>+</button>}>
            {c => <>{evs.slice(0, i).filter(e => !f.causes.includes(e.id)).map(e => <button key={e.id} className="menu-item" onClick={() => { c(); tx(`Add a cause to ${code}`, () => edit(x => { x.causes = toggle(x.causes, e.id) })) }}><span className="mono muted">{eventCode(s, e.id)}</span><span className="clip">{e.text}</span></button>)}
              {evs.slice(0, i).every(e => f.causes.includes(e.id)) && <p className="small muted" style={{ padding: 8 }}>Every earlier event is already a cause.</p>}</>}
          </Popover>}
          {i === 0 && !f.causes.length && <span className="small muted">The first event: nothing earlier causes it.</span>}
        </div>
      </Field>}
      {dated && leads.length > 0 && <Field label="Leads to">
        <div className="tl-chips">{leads.map(e => <a key={e.id} className="chip" href={'#' + route(lens, e.id)}><span className="mono muted">{eventCode(s, e.id)}</span>{e.text}</a>)}</div>
      </Field>}
      <Field label="Who knows">
        {who.map(k => (
          <div key={k} className="tl-kr">
            <span className="grow"><a href={'#world/' + k}><b>{nameOf(s, k)}</b></a>{f.knows[k]?.note && <span className="small muted" style={{ display: 'block' }}>{f.knows[k].note}</span>}</span>
            <KnowledgeChip s={s} f={f} who={k} />
          </div>
        ))}
        <div><RecordPicker s={s} kinds={['entity']} label="+ Someone" exclude={who} onPick={id => tx(`Track what ${nameOf(s, id)} knows`, () => edit(x => { x.knows[id] = { state: '' } }), false)} /></div>
        {!who.length && !entities(s).length && <span className="small muted">Add characters in World to track what they know.</span>}
      </Field>
      <Field label="Shown in">
        {scs.map(sc => (
          <div key={sc.id} className="tl-in">
            <a className={'tl-s grow' + (sc.links[f.id] === 'felt' ? ' felt' : '')} href={'#scene/' + sc.id}><span>{sceneRef(s, sc).replace(' · ', '·')}</span>{sc.title}</a>
            <button className="btn sm ghost hover-only" title={sc.links[f.id] === 'felt' ? 'Show it on the page instead' : 'Only felt: the effect, not the event'} onClick={() => flip(sc.id)}>{sc.links[f.id] === 'felt' ? 'Felt' : 'On the page'}</button>
            <button className="x hover-only" aria-label="Unlink" title="Stop linking this scene" onClick={() => unlink(sc.id)}>×</button>
          </div>
        ))}
        <div><RecordPicker s={s} kinds={['scene']} label="+ Scene" exclude={scs.map(x => x.id)} onPick={id => tx(`Show ${code} in “${nameOf(s, id)}”`, () => update<'scene'>(id, x => { x.links[f.id] = 'on' }))} /></div>
      </Field>
      <Field label="Questions">
        {qs.map(q => <a key={q.id} className="tl-q" href={'#questions/' + q.id}><span className={'tag ' + q.type}>{kindLabel(q)}</span><span className="clip2">{q.text}</span></a>)}
        <div className="row nowrap">
          {!qs.length && <span className="small muted grow">None open</span>}
          {qs.length > 0 && <span className="grow" />}
          <AIButton label="Find problems" busy={job.busy} onClick={() => job.run('Looking for problems…', sig => findProblemsInto(f.id, sig).then(() => {}))} />
        </div>
        {job.err && <JobStatus job={job} />}
      </Field>
      <details className="disclosure tl-hist"><summary>History</summary><History id={f.id} /></details>
    </aside>
  )
}

