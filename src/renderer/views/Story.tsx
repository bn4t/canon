import { useRef, useState } from 'react'
import {
  update, create, remove, tx, get, getState, stories, scenesOf, entities, words, project, nameOf, guidesFor, matchScenes, showToast, applyProposal, typeIds, typeDef,
  STATUSES, LABELS, type State, type Story, type Scene, type Proposal, type GuideKind, type Filter,
} from '../store.ts'
import { completeJSON } from '../ai.ts'
import { suggestScenes, normalizeProposal } from '../prompts.ts'
import { Area, Popover, useJob, JobStatus, go, Bar, Icon, stored, store } from '../ui.tsx'
import { FindProblems, RecordPicker, GuideRow } from './shared.tsx'
import { useHashes, builtState, BUILT, buildOne, deriveOne, continuity, addScene, reorder } from './Write.tsx'

type Mode = 'board' | 'outline' | 'settings'
const excerpt = (sc: Scene) => sc.prose.trim().replace(/\s+/g, ' ').slice(0, 220)
const labelColor = (l?: string) => (l ? `var(--l-${l})` : 'transparent')

export function StoryView({ s, storyId }: { s: State; storyId: string }) {
  const st = get(s, storyId, 'story')!
  const scs = scenesOf(s, storyId)
  const [mode, setMode] = useState<Mode>(() => (stored('canon.story.' + storyId, scs.length ? 'board' : 'settings') as Mode))
  const pick = (m: Mode) => { setMode(m); store('canon.story.' + storyId, m) }
  const hashes = useHashes(s, storyId)
  const job = useJob()
  const [ghosts, setGhosts] = useState<Proposal[]>([])
  const toDerive = scs.filter(x => x.prose.trim() && !x.card.trim())
  const toBuild = scs.filter(x => !x.pinned && x.card.trim() && (!x.prose.trim() || builtState(x, hashes[x.id]) === 'stale'))
  const total = scs.reduce((n, x) => n + words(x.prose), 0)
  const batch = (verb: string, ids: string[], fn: (id: string, sig: AbortSignal) => Promise<void>) => job.run(verb, async (sig, progress) => {
    const errs: string[] = []
    for (const [i, id] of ids.entries()) {
      if (sig.aborted) return
      progress(`${verb} ${i + 1} of ${ids.length}: ${get(getState(), id, 'scene')?.title}`)
      try { await fn(id, sig) } catch (e) { if (sig.aborted) return; errs.push(`${get(getState(), id, 'scene')?.title}: ${String(e).replace(/^Error: /, '')}`) }
    }
    if (errs.length) throw new Error(`${ids.length - errs.length} of ${ids.length} done. These failed and can be retried:\n${errs.join('\n')}`)
    showToast(`${verb}: ${ids.length} done`)
  })
  const suggest = () => job.run('Looking for missing scenes…', async sig => {
    const out = await completeJSON<Proposal[]>('assist', suggestScenes(getState(), st), sig)
    setGhosts(out.filter(p => p.op === 'create' && p.kind === 'scene').map(p => normalizeProposal(getState(), { ...p, data: { ...p.data, story: storyId, status: 'todo' } })))
    pick('board')
  })
  return (
    <>
      <Bar>
        <div className="ph grow">
          <input className="doc-title bar-title" value={st.title} aria-label="Story title" autoFocus={st.title === 'Untitled story'} onFocus={e => { if (st.title === 'Untitled story') e.target.select() }} onChange={e => update<'story'>(storyId, x => { x.title = e.target.value })} />
          <p>{st.form === 'documents' ? 'In-world documents' : 'Prose'}{st.pov ? ` · POV ${nameOf(s, st.pov)}` : ''} · {scs.length} scene{scs.length === 1 ? '' : 's'} · {total.toLocaleString()}{st.target ? ` / ${st.target.toLocaleString()}` : ''} words</p>
        </div>
        <div className="seg" role="tablist">{(['board', 'outline', 'settings'] as Mode[]).map(m => <button key={m} role="tab" aria-selected={mode === m} onClick={() => pick(m)}>{m === 'board' ? 'Board' : m === 'outline' ? 'Outline' : 'Settings'}</button>)}</div>
        <Popover className="right" trigger={o => <button className="btn sm soft" onClick={o} disabled={!!job.busy}>✦ Ask for help<Icon name="down" size={12} /></button>}>{close => <>
          <Item label="Suggest missing scenes" hint="Shown as cards you can add or dismiss" onClick={() => { close(); suggest() }} />
          <Item label={`Derive plans from the text · ${toDerive.length}`} hint="For scenes with text but no plan" disabled={!toDerive.length} onClick={() => { close(); batch('Deriving plan', toDerive.map(x => x.id), deriveOne) }} />
          <Item label={`Build ${toBuild.length} scene${toBuild.length === 1 ? '' : 's'}`} hint="Empty or stale scenes that have a plan; pinned ones are skipped" disabled={!toBuild.length} onClick={() => { close(); batch('Building', toBuild.map(x => x.id), (id, sig) => buildOne(id, sig)) }} />
          <Item label="Continuity check" hint="Notes on scenes; contradictions in the canon become questions" disabled={!scs.some(x => x.prose.trim())} onClick={() => { close(); job.run('Reading the whole story…', sig => continuity(storyId, sig)) }} />
        </>}</Popover>
        <button className="btn sm" onClick={() => addScene(st)}><Icon name="plus" size={14} />Scene</button>
      </Bar>
      <div className="body">
        <JobStatus job={job} />
        {mode === 'board' && toDerive.length > 0 && !job.busy && <div className="card tint row"><span className="grow"><b>{toDerive.length} of {scs.length} scenes</b> have text but no plan. Plans are what builds, checks and the timeline work from.</span>
          <button className="btn sm ai" onClick={() => batch('Deriving plan', toDerive.map(x => x.id), deriveOne)}>✦ Derive {toDerive.length} plans</button></div>}
        {mode === 'board' && <Board s={s} st={st} scs={scs} hashes={hashes} ghosts={ghosts} setGhosts={setGhosts} />}
        {mode === 'outline' && <Outline s={s} scs={scs} hashes={hashes} />}
        {mode === 'settings' && <Settings s={s} st={st} scs={scs} onSuggest={suggest} busy={!!job.busy} />}
      </div>
    </>
  )
}

const Item = ({ label, hint, disabled, onClick }: { label: string; hint: string; disabled?: boolean; onClick: () => void }) => (
  <button className="menu-item" disabled={disabled} onClick={onClick}><span className="grow">{label}<br /><span className="muted small">{hint}</span></span></button>
)

// ---------------- board ----------------

type Group = 'none' | 'label' | 'status' | 'beat'
function Card({ s, sc, n, hash, drag }: { s: State; sc: Scene; n?: number; hash?: string; drag?: ReturnType<typeof useDrag> }) {
  const b = builtState(sc, hash)
  return (
    <div role="button" tabIndex={0} className={'icard' + (drag?.over === sc.id ? ' drag-over' : '')} {...drag?.props(sc.id)} title={sc.label ? project(s).labels?.[sc.label] || sc.label : undefined}
      onClick={() => go(`write/${sc.story}/${sc.id}`)} onKeyDown={e => { if (e.key === 'Enter') go(`write/${sc.story}/${sc.id}`) }}>
      <span className="stripe" style={{ background: labelColor(sc.label) }} />
      <span className="lbl">{n !== undefined ? n : nameOf(s, sc.story)}{sc.beat ? ` · ${sc.beat}` : ''}</span>
      <h4>{sc.title}</h4>
      {sc.card ? <p className="syn">{sc.card}</p> : sc.prose.trim() ? <p className="syn excerpt">{excerpt(sc)}</p> : <p className="syn faint"><i>Empty scene</i></p>}
      <div className="foot"><span>{STATUSES.find(x => x.id === (sc.status || 'todo'))!.label}{sc.prose.trim() ? ` · ${words(sc.prose).toLocaleString()} words` : ''}</span>{b === 'stale' && <span className="chip warn">Stale</span>}</div>
    </div>
  )
}

function useDrag(scs: Scene[]) {
  const drag = useRef<string>(undefined)
  const [over, setOver] = useState<string>()
  const props = (id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { drag.current = id; e.dataTransfer.effectAllowed = 'move' },
    onDragOver: (e: React.DragEvent) => { if (drag.current) { e.preventDefault(); setOver(id) } },
    onDragLeave: () => setOver(undefined),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); if (drag.current && drag.current !== id) reorder(scs, drag.current, id); drag.current = undefined; setOver(undefined) },
    onDragEnd: () => { drag.current = undefined; setOver(undefined) },
  })
  return { props, over }
}

function Board({ s, st, scs, hashes, ghosts, setGhosts }: { s: State; st: Story; scs: Scene[]; hashes: Record<string, string>; ghosts: Proposal[]; setGhosts: (g: Proposal[]) => void }) {
  const drag = useDrag(scs)
  const [group, setGroup] = useState<Group>(() => stored('canon.board.group', 'none') as Group)
  const labels = project(s).labels || {}
  const lanes: { key: string; name: string; color?: string; items: Scene[] }[] = group === 'none' ? [{ key: '', name: '', items: scs }]
    : group === 'label' ? [...LABELS.map(l => ({ key: l, name: labels[l] || l, color: `var(--l-${l})`, items: scs.filter(x => x.label === l) })), { key: '-', name: 'No label', items: scs.filter(x => !x.label) }]
      : group === 'status' ? STATUSES.map(x => ({ key: x.id, name: x.label, items: scs.filter(y => (y.status || 'todo') === x.id) }))
        : [...st.beats.filter(Boolean).map(b => ({ key: b, name: b, items: scs.filter(x => x.beat === b) })), { key: '-', name: 'No beat', items: scs.filter(x => !x.beat || !st.beats.includes(x.beat)) }]
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row"><span className="lbl">Group by</span>
        <div className="seg">{(['none', 'label', 'status', 'beat'] as Group[]).map(g => <button key={g} className={group === g ? 'on' : ''} onClick={() => { setGroup(g); store('canon.board.group', g) }}>{g === 'none' ? 'Order' : g[0].toUpperCase() + g.slice(1)}</button>)}</div></div>
      {lanes.filter(l => l.items.length || group === 'none').map(l => (
        <section key={l.key} className="lane">
          {l.name && <div className="lane-h">{l.color && <i className="dot" style={{ background: l.color }} />}{l.name}<span className="small muted">{l.items.length}</span></div>}
          <div className="board">
            {l.items.map(sc => <Card key={sc.id} s={s} sc={sc} n={scs.indexOf(sc) + 1} hash={hashes[sc.id]} drag={group === 'none' ? drag : undefined} />)}
            {group === 'none' && ghosts.map((g, i) => { const d = g.data as { title?: string; card?: string; beat?: string }; return (
              <div key={'g' + i} className="icard ghost">
                <span className="kicker ai">✦ Suggested{d.beat ? ` · ${d.beat}` : ''}</span><h4>{d.title}</h4><p className="syn">{d.card}</p>
                {g.why && <p className="small muted">{g.why}</p>}
                <div className="foot"><button className="btn sm ai" onClick={() => { tx('Add suggested scene', () => applyProposal(g)); setGhosts(ghosts.filter(x => x !== g)) }}>Add</button>
                  <button className="btn sm ghost" onClick={() => setGhosts(ghosts.filter(x => x !== g))}>Dismiss</button></div>
              </div>) })}
            {group === 'none' && <button className="icard add" onClick={() => addScene(st)}>+ New scene</button>}
          </div>
        </section>
      ))}
    </div>
  )
}

// ---------------- outline ----------------

type Col = { id: string; label: string; get: (sc: Scene) => string | number; render?: (sc: Scene) => React.ReactNode }
function Outline({ s, scs, hashes }: { s: State; scs: Scene[]; hashes: Record<string, string> }) {
  const labels = project(s).labels || {}
  const all: Col[] = [
    { id: 'status', label: 'Status', get: sc => STATUSES.findIndex(x => x.id === (sc.status || 'todo')), render: sc => <span style={{ whiteSpace: 'nowrap' }}>{STATUSES.find(x => x.id === (sc.status || 'todo'))!.label}</span> },
    { id: 'synopsis', label: 'Synopsis', get: sc => sc.card, render: sc => <span className="small">{sc.card || <i className="faint">{excerpt(sc) ? excerpt(sc).slice(0, 140) + '…' : 'Empty'}</i>}</span> },
    { id: 'words', label: 'Words', get: sc => words(sc.prose), render: sc => <>{words(sc.prose).toLocaleString()}{sc.target ? <div className="bar" style={{ marginTop: 4 }}><i style={{ width: Math.min(100, (words(sc.prose) / sc.target) * 100) + '%' }} /></div> : null}</> },
    { id: 'target', label: 'Target', get: sc => sc.target || 0, render: sc => sc.target?.toLocaleString() || '' },
    { id: 'label', label: 'Label', get: sc => sc.label || '', render: sc => sc.label ? <span className="row nowrap"><i className="dot" style={{ background: labelColor(sc.label) }} />{labels[sc.label] || sc.label}</span> : '' },
    { id: 'beat', label: 'Beat', get: sc => sc.beat },
    { id: 'cast', label: 'Cast', get: sc => sc.cast.map(c => nameOf(s, c)).join(', '), render: sc => <span className="small">{sc.cast.map(c => nameOf(s, c)).join(', ')}</span> },
    { id: 'links', label: 'Events and facts', get: sc => Object.keys(sc.links).length, render: sc => <div className="row" style={{ gap: 3 }}>{Object.entries(sc.links).map(([id, h]) => <span key={id} className={'chip' + (h === 'felt' ? ' dash' : '')}>{nameOf(s, id).slice(0, 28)}</span>)}</div> },
    { id: 'tags', label: 'Tags', get: sc => (sc.tags || []).join(', ') },
    { id: 'built', label: 'Built', get: sc => builtState(sc, hashes[sc.id]), render: sc => { const b = builtState(sc, hashes[sc.id]); return <span className={'chip ' + BUILT[b].cls}>{BUILT[b].label}</span> } },
    { id: 'compile', label: 'In compile', get: sc => (sc.exclude ? 0 : 1), render: sc => (sc.exclude ? 'No' : '') },
    ...(project(s).sceneFields || []).map(f => ({ id: 'm:' + f.key, label: f.label, get: (sc: Scene) => sc.meta?.[f.key] || '' })),
  ]
  const [cols, setCols] = useState<string[]>(() => stored('canon.outline.cols', 'status,synopsis,words,label,cast').split(','))
  const [sort, setSort] = useState<{ id: string; dir: 1 | -1 }>()
  const shown = all.filter(c => cols.includes(c.id))
  const rows = sort ? [...scs].sort((a, b) => { const c = all.find(x => x.id === sort.id)!; const x = c.get(a), y = c.get(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir }) : scs
  const toggleCol = (id: string) => setCols(cs => { const next = cs.includes(id) ? cs.filter(x => x !== id) : [...cs, id]; store('canon.outline.cols', next.join(',')); return next })
  return (
    <div className="stack">
      <div className="row"><Popover trigger={o => <button className="btn sm" onClick={o}>Columns</button>}>{() => <>{all.map(c => <label key={c.id} className="menu-item"><input type="checkbox" checked={cols.includes(c.id)} onChange={() => toggleCol(c.id)} />{c.label}</label>)}</>}</Popover>
        {sort && <button className="btn sm ghost" onClick={() => setSort(undefined)}>Back to story order</button>}</div>
      <div className="tablewrap">
        <table className="mx">
          <thead><tr><th>#</th><th>Scene</th>{shown.map(c => <th key={c.id}><button onClick={() => setSort(x => (x?.id === c.id ? { id: c.id, dir: x.dir === 1 ? -1 : 1 } : { id: c.id, dir: 1 }))}>{c.label}{sort?.id === c.id ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</button></th>)}</tr></thead>
          <tbody>{rows.map(sc => (
            <tr key={sc.id} className="click" onClick={() => go(`write/${sc.story}/${sc.id}`)}>
              <td className="mono faint">{scs.indexOf(sc) + 1}</td>
              <td style={{ minWidth: 150 }}><b className="serif" style={{ fontWeight: 500, fontSize: 15 }}>{sc.title}</b></td>
              {shown.map(c => <td key={c.id}>{c.render ? c.render(sc) : String(c.get(sc))}</td>)}
            </tr>))}</tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------- story settings ----------------

function Settings({ s, st, scs, onSuggest, busy }: { s: State; st: Story; scs: Scene[]; onSuggest: () => void; busy: boolean }) {
  const edit = (fn: (x: Story) => void) => update<'story'>(st.id, fn)
  const scope = 'story:' + st.id
  return (
    <div className="split">
      <div className="stack">
        <Area label="Premise" value={st.premise} placeholder="What this story is, in two or three sentences" onChange={v => edit(x => { x.premise = v })} />
        <div className="grid3">
          <label className="field"><span className="lbl">Point of view</span><select className="f" value={st.pov || ''} onChange={e => edit(x => { x.pov = e.target.value || undefined })}>
            <option value="">None</option>{typeIds(s).map(t => <optgroup key={t} label={typeDef(s, t).label}>{entities(s, t).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</optgroup>)}</select></label>
          <label className="field"><span className="lbl">Form</span><select className="f" value={st.form} onChange={e => edit(x => { x.form = e.target.value as Story['form'] })}><option value="prose">Prose</option><option value="documents">In-world documents</option></select></label>
          <label className="field"><span className="lbl">Word target</span><input className="f" type="number" min={0} step={500} placeholder="None" value={st.target || ''} onChange={e => edit(x => { x.target = Number(e.target.value) || undefined })} /></label>
        </div>
        <Area label="Beat pattern · comma-separated" single value={st.beats.join(', ')} placeholder="Setup, Hook, Complication, Loss, Coda" onChange={v => edit(x => { x.beats = v.split(',').map(b => b.trimStart()) })} />
        {!scs.length && <div className="card"><h3>Next: scenes</h3><p className="muted small">Write the premise and beats, then add scenes yourself or let the assistant propose them from the canon.</p>
          <div className="row"><button className="btn pri" onClick={() => addScene(st)}>Add the first scene</button><button className="btn ai" disabled={busy || !st.premise.trim()} title={st.premise.trim() ? '' : 'Write a premise first'} onClick={onSuggest}>✦ Suggest scenes</button></div></div>}
        {(st.premise.trim() || scs.length > 0) && <section className="stack"><h3>What doesn't hold up</h3><FindProblems s={s} focus={st.id} label="Find holes in this story" /></section>}
      </div>
      <div className="stack">
        <h3>Guides for this story</h3>
        <p className="small muted">Style and rules sent with every build in this story, on top of the project's.</p>
        {guidesFor(s, scope).map(g => <GuideRow key={g.id} g={g} />)}
        <div className="row">{(['rule', 'style'] as GuideKind[]).map(k => <button key={k} className="btn sm" onClick={() => tx('Add guide', () => { create('guide', { use: k, scope, title: k === 'rule' ? 'Rule' : 'Style', text: '' }) }, false)}>+ {k === 'rule' ? 'Rule' : 'Style guide'}</button>)}</div>
        <button className="btn sm danger" style={{ justifySelf: 'start', marginTop: 24 }} onClick={() => { tx(`Delete story “${st.title}” and ${scs.length} scenes`, () => { scs.forEach(x => remove(x.id)); remove(st.id) }); go('write') }}>Delete story</button>
      </div>
    </div>
  )
}

// ---------------- smart collections ----------------

export function CollectionView({ s, id }: { s: State; id: string }) {
  const c = (project(s).collections || []).find(x => x.id === id)
  if (!c) return <><Bar /><div className="empty"><h2>Not found</h2><a className="btn" href="#write">Back to writing</a></div></>
  const set = (fn: (f: Filter & { name?: string }) => void, label = 'Edit collection') => tx(label, () => update<'project'>('project', x => {
    const col = x.collections!.find(y => y.id === id)!
    const f: Filter & { name?: string } = { ...col.filter, name: col.name }
    fn(f); col.name = f.name || ''; delete f.name; col.filter = f
  }), false)
  const f = c.filter
  const hits = matchScenes(s, f)
  return (
    <>
      <Bar>
        <div className="ph grow">
          <input className="doc-title bar-title" value={c.name} aria-label="Collection name" onChange={e => set(x => { x.name = e.target.value })} />
          <p>Collection · {hits.length} scene{hits.length === 1 ? '' : 's'} · updates as you write</p>
        </div>
        <button className="btn sm ghost danger" onClick={() => { tx('Delete collection', () => update<'project'>('project', x => { x.collections = x.collections!.filter(y => y.id !== id) })); go('write') }}>Delete</button>
      </Bar>
      <div className="body">
        <div className="card">
          <div className="grid3">
            <label className="field"><span className="lbl">Text contains</span><input className="f" value={f.q || ''} onChange={e => set(x => { x.q = e.target.value || undefined })} /></label>
            <label className="field"><span className="lbl">Story</span><select className="f" value={f.story || ''} onChange={e => set(x => { x.story = e.target.value || undefined })}><option value="">Any</option>{stories(s).map(x => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>
            <label className="field"><span className="lbl">Status</span><select className="f" value={f.status || ''} onChange={e => set(x => { x.status = e.target.value || undefined })}><option value="">Any</option>{STATUSES.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
            <label className="field"><span className="lbl">Label</span><select className="f" value={f.label || ''} onChange={e => set(x => { x.label = e.target.value || undefined })}><option value="">Any</option>{LABELS.map(l => <option key={l} value={l}>{project(s).labels?.[l] || l}</option>)}</select></label>
            <label className="field"><span className="lbl">Tag</span><input className="f" value={f.tag || ''} onChange={e => set(x => { x.tag = e.target.value || undefined })} /></label>
            <label className="field"><span className="lbl">Not in compile only</span><input type="checkbox" checked={!!f.exclude} onChange={e => set(x => { x.exclude = e.target.checked || undefined })} /></label>
          </div>
          <div className="row">
            {f.cast ? <span className="chip on">With {nameOf(s, f.cast)}<button className="x" style={{ fontSize: 13, padding: 0, color: 'inherit' }} onClick={() => set(x => { x.cast = undefined })}>×</button></span>
              : <RecordPicker s={s} kinds={['entity']} label="+ With someone or something" onPick={v => set(x => { x.cast = v })} />}
            {f.fact ? <span className="chip on">Touches {nameOf(s, f.fact)}<button className="x" style={{ fontSize: 13, padding: 0, color: 'inherit' }} onClick={() => set(x => { x.fact = undefined })}>×</button></span>
              : <RecordPicker s={s} kinds={['fact']} label="+ Touches an event or fact" onPick={v => set(x => { x.fact = v })} />}
          </div>
        </div>
        <div className="board">{hits.map(sc => <Card key={sc.id} s={s} sc={sc} />)}</div>
        {!hits.length && <p className="muted">No scenes match yet.</p>}
      </div>
    </>
  )
}
