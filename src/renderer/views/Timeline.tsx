import { useState } from 'react'
import {
  update, create, remove, tx, get, list, events, eventCode, stories, scenesOf, allScenes, nameOf, knowers, plainFacts, readerLearns, questionsAbout,
  newFact, newQuestion, nextAt, sceneRef,
  type State, type Fact, type KState, type KCell, type Proposal,
} from '../store.ts'
import { completeJSON } from '../ai.ts'
import { suggestFacts, normalizeProposal } from '../prompts.ts'
import { Area, Popover, Proposals, useJob, JobStatus, Empty, PageHead, toggle, go } from '../ui.tsx'
import { QuestionCard, FindProblems, RecordPicker } from './shared.tsx'

const KLABEL: Record<KState, string> = { '': 'Undecided', knows: 'Knows', almost: 'Almost', believes: 'Believes', never: 'Never' }
const STATES: KState[] = ['knows', 'almost', 'believes', 'never', '']

function addEvent(s: State) {
  let id = ''
  tx('New event', () => { id = create('fact', newFact({ text: 'New event', at: nextAt(s), causes: events(s).slice(-1).map(e => e.id) })) })
  go('timeline/' + id)
}

/** Knowledge cell editor: state, from which story, and a note. */
function KEdit({ s, f, who }: { s: State; f: Fact; who: string }) {
  const c: KCell = f.knows[who] || { state: '' }
  const set = (patch: Partial<KCell>) => update<'fact'>(f.id, x => { x.knows[who] = { ...c, ...patch } })
  return (
    <div className="stack" style={{ padding: 6, width: 260 }}>
      <span className="lbl">{nameOf(s, who)}</span>
      <div className="row" style={{ gap: 4 }}>{STATES.map(v => (
        <button key={v} className={'chip k-' + (v || 'unset')} style={c.state === v ? { outline: '2px solid var(--accent)' } : undefined} onClick={() => set({ state: v })}>{KLABEL[v]}</button>))}</div>
      <label className="field"><span className="lbl">From</span>
        <select className="f" value={c.from || ''} onChange={e => set({ from: e.target.value || undefined })}>
          <option value="">From the start</option>{stories(s).map(st => <option key={st.id} value={st.id}>{st.title}</option>)}
        </select></label>
      <Area label={c.state === 'believes' ? 'What they believe instead' : c.state === 'almost' ? 'How close they get' : 'Note'} value={c.note || ''} placeholder="Optional" onChange={v => set({ note: v })} />
    </div>
  )
}
const KChip = ({ s, f, who }: { s: State; f: Fact; who: string }) => {
  const c = f.knows[who]
  return <Popover trigger={o => <button className={'chip k-' + (c?.state || 'unset')} title={c?.note} onClick={o}>{KLABEL[c?.state || '']}{c?.from && c.state !== 'never' ? ` · ${nameOf(s, c.from)}` : ''}</button>}>{() => <KEdit s={s} f={f} who={who} />}</Popover>
}

// ---------------- timeline ----------------

export function TimelineView({ s, sel }: { s: State; sel?: string }) {
  const evs = events(s)
  const sts = stories(s)
  const ev = evs.find(e => e.id === sel)
  return (
    <>
      <PageHead title="Timeline" sub="Events in world order. Each story is a slice through them.">
        <div className="seg"><button className="on">Timeline</button><button onClick={() => go('knowledge')}>Who knows</button></div>
        <button className="btn" onClick={() => addEvent(s)}>+ Event</button>
      </PageHead>
      {!evs.length ? <Empty title="No events yet"><p>An event is a fact with a place in time: it happens, it has causes, and characters can know about it. Add the first, then tag scenes that show it.</p><button className="btn pri" onClick={() => addEvent(s)}>Add the first event</button></Empty> : (
        <div style={{ display: 'grid', gridTemplateColumns: ev ? 'minmax(0, 1fr) 340px' : 'minmax(0, 1fr)', flex: 1, alignItems: 'start' }}>
          <div className="body">
            <div className="tl-wrap"><div className="tl" style={{ gridTemplateColumns: `190px repeat(${evs.length}, minmax(168px, 1fr))` }}>
              <div className="rh" />
              {evs.map(e => {
                const open = questionsAbout(s, e.id).filter(q => !q.answer && !q.dismissed).length
                return <div key={e.id} className={'eh' + (e.id === ev?.id ? ' sel' : '')} onClick={() => go(e.id === ev?.id ? 'timeline' : 'timeline/' + e.id)} title={e.detail}>
                  <span className="mono" style={{ color: e.id === ev?.id ? 'var(--accent)' : 'var(--faint)' }}>{eventCode(s, e.id)}</span>{open > 0 && <span className="qdot" title={`${open} open question${open === 1 ? '' : 's'}`}>{open}</span>}
                  <b style={{ fontWeight: 600 }}>{e.text || 'Untitled'}</b>
                </div>
              })}
              {sts.map(st => [
                <div key={st.id} className="rh"><a href={'#story/' + st.id} style={{ textDecoration: 'none' }}><b>{st.title}</b></a>
                  <span className="small muted">{st.pov ? nameOf(s, st.pov) + ' · ' : ''}{scenesOf(s, st.id).length} scenes</span></div>,
                ...evs.map(e => (
                  <div key={st.id + e.id} className={e.id === ev?.id ? 'sel' : ''}>
                    {scenesOf(s, st.id).filter(sc => sc.links[e.id]).map(sc => (
                      <a key={sc.id} className={'scard' + (sc.links[e.id] === 'felt' ? ' felt' : '')} href={`#write/${st.id}/${sc.id}`} title={`${sc.title}${sc.card ? '\n' + sc.card : ''}`}><span className="n">{sceneRef(s, sc).split(' · ')[1]}</span>{sc.title}</a>
                    ))}
                  </div>
                )),
              ])}
            </div></div>
            <div className="row small muted" style={{ gap: 18 }}>
              <span className="row nowrap" style={{ gap: 6 }}><i className="swatch" /> A scene shows it</span>
              <span className="row nowrap" style={{ gap: 6 }}><i className="swatch felt" /> Felt: the effect, not the cause</span>
              <span>Tag scenes in their plan to place them here</span>
            </div>
          </div>
          {ev && <EventDrawer key={ev.id} s={s} ev={ev} />}
        </div>
      )}
    </>
  )
}

function EventDrawer({ s, ev }: { s: State; ev: Fact }) {
  const evs = events(s)
  const i = evs.indexOf(ev)
  const edit = (fn: (f: Fact) => void) => update<'fact'>(ev.id, fn)
  const scs = allScenes(s).filter(sc => sc.links[ev.id])
  const who = Object.keys(ev.knows)
  const move = (d: number) => {
    const o = evs[i + d]
    if (o) tx('Move event', () => { const a = ev.at; edit(x => { x.at = o.at }); update<'fact'>(o.id, x => { x.at = a }) })
  }
  return (
    <aside className="drawer">
      <div className="row"><span className="mono ai-text">{eventCode(s, ev.id)} · {i + 1} of {evs.length}</span><span className="grow" />
        <button className="btn sm ghost" disabled={i === 0} onClick={() => move(-1)}>← Earlier</button>
        <button className="btn sm ghost" disabled={i === evs.length - 1} onClick={() => move(1)}>Later →</button>
        <button className="x" aria-label="Close" title="Close" onClick={() => go('timeline')}>×</button></div>
      <textarea className="inline" style={{ font: '400 24px/1.25 var(--f-prose)' }} value={ev.text} placeholder="What happens" aria-label="Event" onChange={e => edit(x => { x.text = e.target.value })} />
      <Area value={ev.detail} placeholder="Detail: how it happens, what it changes" onChange={v => edit(x => { x.detail = v })} />
      <div className="field"><span className="lbl">Caused by</span>
        {i === 0 && !ev.causes.length && <span className="muted small">The first event: nothing earlier causes it.</span>}
        <div className="row" style={{ gap: 4 }}>{evs.filter((e, j) => j < i || ev.causes.includes(e.id)).map(e => (
          <button key={e.id} className={'chip' + (ev.causes.includes(e.id) ? ' on' : '')} title={e.detail} onClick={() => edit(x => { x.causes = toggle(x.causes, e.id) })}>{eventCode(s, e.id)} {e.text}</button>
        ))}</div></div>
      <div className="field"><span className="lbl">Who knows</span>
        {who.map(k => (
          <div key={k} className="row nowrap" style={{ justifyContent: 'space-between' }}>
            <a href={'#world/' + k} className="clip" style={{ textDecoration: 'none' }}>{nameOf(s, k) || 'Missing'}</a><KChip s={s} f={ev} who={k} />
          </div>
        ))}
        <div><RecordPicker s={s} kinds={['entity']} label="+ Someone" exclude={who} onPick={id => edit(x => { x.knows[id] = { state: '' } })} /></div></div>
      <div className="field"><span className="lbl">Scenes · {scs.length}</span>
        {scs.map(sc => <a key={sc.id} className={'scard' + (sc.links[ev.id] === 'felt' ? ' felt' : '')} href={`#write/${sc.story}/${sc.id}`}>{sceneRef(s, sc)} · {sc.title}</a>)}
        {!scs.length && <span className="muted small">No scene shows this yet. Link it from a scene’s plan.</span>}</div>
      {questionsAbout(s, ev.id).filter(q => !q.dismissed).map(q => <QuestionCard key={q.id} s={s} q={q} compact />)}
      <div className="row"><button className="btn sm" onClick={() => tx('Raise a question', () => { create('question', newQuestion({ about: [ev.id] })) }, false)}>Raise a question</button></div>
      <FindProblems s={s} focus={ev.id} label="Find problems with this event" />
      <div className="row">
        <button className="btn sm ghost" title="Keep it as a fact without a place in time" onClick={() => { tx('Make it a plain fact', () => edit(x => { delete x.at })); go('knowledge') }}>Make it a plain fact</button>
        <span className="grow" />
        <button className="btn sm ghost danger" onClick={() => { tx(`Delete ${eventCode(s, ev.id)}`, () => remove(ev.id)); go('timeline') }}>Delete</button>
      </div>
    </aside>
  )
}

// ---------------- who knows what ----------------

export function KnowledgeView({ s }: { s: State }) {
  const [extra, setExtra] = useState<string[]>([])
  const job = useJob()
  const [props, setProps] = useState<Proposal[]>([])
  const cols = [...knowers(s).map(e => e.id), ...extra.filter(id => get(s, id, 'entity') && !knowers(s).some(e => e.id === id))]
  const rows = [...plainFacts(s), ...events(s)]
  const suggest = () => job.run('Looking for dramatic irony…', async sig => {
    setProps((await completeJSON<Proposal[]>('assist', suggestFacts(s), sig)).map(p => normalizeProposal(s, p)))
  })
  return (
    <>
      <PageHead title="Who knows what" sub="Knowledge per character, and from which story on. Builds and checks enforce it.">
        <div className="seg"><button onClick={() => go('timeline')}>Timeline</button><button className="on">Who knows</button></div>
        <button className="btn soft" disabled={!!job.busy} onClick={suggest}>✦ Suggest facts</button>
        <button className="btn" onClick={() => tx('New fact', () => { create('fact', newFact({ text: 'New fact' })) })}>+ Fact</button>
      </PageHead>
      <div className="body">
        <JobStatus job={job} />
        <Proposals s={s} items={props} onChange={setProps} />
        {rows.length ? <div className="tablewrap">
          <table className="mx">
            <thead><tr><th>Fact</th>
              {cols.map(k => <th key={k}><a href={'#world/' + k} style={{ textDecoration: 'none' }}>{nameOf(s, k)}</a></th>)}
              <th><RecordPicker s={s} kinds={['entity']} label="+ Person" exclude={cols} onPick={id => setExtra(x => [...x, id])} /></th>
              <th>Reader learns</th><th /></tr></thead>
            <tbody>
              {rows.map(f => {
                const r = readerLearns(s, f.id)
                return (
                  <tr key={f.id}>
                    <td style={{ minWidth: 240 }}>
                      {f.at !== undefined && <a className="chip on" href={'#timeline/' + f.id} style={{ marginBottom: 4 }}>event {eventCode(s, f.id)}</a>}
                      <textarea className="inline serif" style={{ fontSize: 15 }} value={f.text} aria-label="Fact" onChange={e => update<'fact'>(f.id, x => { x.text = e.target.value })} />
                    </td>
                    {cols.map(k => <td key={k}><KChip s={s} f={f} who={k} />{f.knows[k]?.note && <p className="small muted" style={{ marginTop: 4, maxWidth: 180 }}>{f.knows[k].note}</p>}</td>)}
                    <td />
                    <td className="small" style={{ maxWidth: 200 }}>{r ? <a className="clip" style={{ display: 'block' }} title={r.title} href={`#write/${r.story}/${r.id}`}>{sceneRef(s, r)} · {r.title}</a> : <span className="faint">—</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {f.at === undefined && <button className="btn sm ghost hover-only" title="Give it a place in time" onClick={() => tx('Make it an event', () => update<'fact'>(f.id, x => { x.at = nextAt(s) }))}>Make it an event</button>}
                      <button className="btn sm ghost danger hover-only" aria-label="Delete fact" title="Delete" onClick={() => tx('Delete fact', () => remove(f.id))}>×</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div> : <Empty title="No facts yet"><p>Add the secrets and misbeliefs your stories turn on, or let the assistant suggest some. The reader learns a fact in the first scene that shows it on the page.</p></Empty>}
        {list(s, 'fact').length > 0 && !cols.length && <p className="muted small">Add a person to track what they know.</p>}
      </div>
    </>
  )
}
