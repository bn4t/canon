import './world.css'
import { useState, type ReactNode } from 'react'
import {
  update, create, remove, tx, list, get, getState, stories, allScenes, entities, typeIds, typeDef, typesOf, project, nameOf, sceneRef, storyLabel, eventCode, plainFacts,
  guidesFor, questionsAbout, newEntityData, newQuestion, showToast, QKINDS, type State, type Entity, type Proposal, type KState, type GuideKind, type Fact,
} from '../store.ts'
import { f, slug } from '../schema.ts'
import { completeJSON, useAI, aiReady } from '../ai.ts'
import { fillGaps, draftEntity, findProblems, normalizeProposal, type FoundQ } from '../prompts.ts'
import { useJob, JobStatus, Popover, go, Bar, Icon, AssistMenu, ProposedChanges, ConnectPrompt, Spark, startInterview, askAssistant, openSettings, type AssistItem } from '../ui.tsx'
import { ResearchCard, Picture } from './Research.tsx'
import { PinButton } from './Pinned.tsx'
import { History, GuideRow, RecordPicker, hrefOf, factCode, avatarColor } from './shared.tsx'

// ---------------- small pieces ----------------

const Av = ({ name, big, size }: { name: string; big?: boolean; size?: number }) =>
  <span className={'w-av' + (big ? ' big' : '')} style={{ background: avatarColor(name), ...(size ? { width: size, height: size } : {}) }} aria-hidden="true">{name.trim()[0]?.toUpperCase() || '?'}</span>
const KLABEL: Record<KState, string> = { '': 'Undecided', knows: 'Knows', almost: 'Almost', believes: 'Believes otherwise', never: 'Never' }
const firstName = (e: Entity) => e.name.trim().split(/\s+/)[0] || e.name
const isPerson = (s: State, e: Entity) => e.type === 'character' || /person|people|character/i.test(typeDef(s, e.type).label)
const castOf = (s: State, id: string) => allScenes(s).filter(sc => sc.cast.includes(id))
const shortRef = (s: State, id: string) => { const sc = get(s, id, 'scene'); return sc ? sceneRef(s, sc).replace(' · ', '·') : storyLabel(s, id) }
/** One proposal per field, so each change can be kept or dropped on its own. */
const perField = (ps: Proposal[]) => ps.flatMap(p => p.op === 'update' && p.set && Object.keys(p.set).length > 1 ? Object.entries(p.set).map(([k, v]) => ({ ...p, set: { [k]: v } })) : [p])

export function newEntity(type: string, name?: string) {
  let id = ''
  const one = typeDef(getState(), type).one.toLowerCase()
  tx(`New ${one}`, () => { id = create('entity', newEntityData(type, name || `New ${one}`)) }, false)
  go('world/' + id)
  return id
}

/** Plot holes and contradictions about one record. They land in Questions; a toast links there. */
async function findProblemsAbout(id: string, signal: AbortSignal) {
  const out = await completeJSON<FoundQ[]>('check', findProblems(getState(), id), signal)
  const name = nameOf(getState(), id)
  if (!out.length) return showToast(`No problems found with ${name}`)
  tx(`Find problems: ${name}`, () => {
    for (const x of out) create('question', newQuestion({
      type: (['question', 'hole', 'contradiction'] as const).includes(x.kind) ? x.kind : 'question', text: x.text, by: 'ai',
      about: [...new Set([...(x.about || []).filter(r => getState().recs[r]), id])],
      options: (x.options || []).map(o => ({ title: o.title, detail: o.detail, proposal: o.proposal ? normalizeProposal(getState(), o.proposal) : undefined })),
    }))
  }, false)
  showToast(`${out.length} problem${out.length === 1 ? '' : 's'} about ${name} added to Questions`, true, { label: 'Open Questions', run: () => go('questions') })
}

// ---------------- the screen ----------------

export function WorldView({ s, id }: { s: State; id?: string }) {
  const e = get(s, id, 'entity')
  const [drafting, setDrafting] = useState(false)
  const layout = (bar: ReactNode, body: ReactNode) => (
    <>
      {bar}
      <div className="w-shell">
        <Index s={s} cur={e?.id} onDraft={() => setDrafting(true)} />
        <div className="w-content">
          {drafting && <DraftNew s={s} onClose={() => setDrafting(false)} />}
          {body}
        </div>
      </div>
    </>
  )
  if (e) return <Sheet key={e.id} s={s} e={e} layout={layout} />
  return layout(
    <Bar><div className="crumbs grow"><b>World</b></div>
      <AssistMenu items={[{ label: 'Draft with the assistant', hint: 'Describe someone or something new in a sentence', dest: 'World', run: () => setDrafting(true) }]} />
      <span className="bar-sep" /></Bar>,
    <Overview s={s} onDraft={() => setDrafting(true)} />,
  )
}

/** The world's contents, inside the page: a filter, types as tabs, each entry, and a way to add more. */
function Index({ s, cur, onDraft }: { s: State; cur?: string; onDraft: () => void }) {
  const [q, setQ] = useState('')
  const [tab, setTab] = useState('')
  const used = typeIds(s).filter(t => entities(s, t).length)
  const shown = used.includes(tab) ? tab : ''
  const pov = new Set(stories(s).map(x => x.pov).filter(Boolean))
  const hit = (e: Entity) => !q || (e.name + ' ' + e.aliases.join(' ')).toLowerCase().includes(q.toLowerCase())
  const groups = typeIds(s).filter(t => !shown || t === shown).map(t => [t, entities(s, t).filter(hit)] as const).filter(([, es]) => es.length)
  return (
    <nav className="w-index" aria-label="World index">
      <div className="row nowrap" style={{ gap: 6 }}>
        <label className="w-filter"><Icon name="find" size={14} /><input placeholder="Filter" aria-label="Filter the world" value={q} onChange={ev => setQ(ev.target.value)} /></label>
        <Popover trigger={o => <button className="btn" style={{ padding: '0 9px' }} onClick={o}>+ New</button>}>{close => <NewMenu s={s} close={close} onDraft={onDraft} />}</Popover>
      </div>
      {used.length > 1 && <div className="w-tabs" role="tablist" aria-label="Types">
        {[['', 'All', entities(s).length] as const, ...used.map(t => [t, typeDef(s, t).label, entities(s, t).length] as const)].map(([t, l, n]) =>
          <button key={t} role="tab" aria-selected={shown === t} className={shown === t ? 'on' : ''} onClick={() => setTab(t)}>{l} <span className="n">{n}</span></button>)}
      </div>}
      {groups.map(([t, es]) => (
        <div key={t}>
          <div className="w-gh">{typeDef(s, t).label}</div>
          {es.map(x => (
            <a key={x.id} href={'#world/' + x.id} className={'w-it' + (x.id === cur ? ' on' : '')} aria-current={x.id === cur ? 'page' : undefined}>
              <Av name={x.name} /><span className="grow clip">{x.name || 'Unnamed'}</span>{pov.has(x.id) && <span className="lbl" style={{ fontWeight: 400 }}>POV</span>}
            </a>
          ))}
        </div>
      ))}
      {!groups.length && <p className="w-none">{q ? `Nothing matches “${q}”.` : 'Nothing here yet. Add a character, a place, or anything else your stories need.'}</p>}
      <span className="grow" />
      <button className="w-it w-types" onClick={() => openSettings('types')}><Icon name="sliders" size={14} /><span className="grow">Types and fields</span></button>
    </nav>
  )
}

function NewMenu({ s, close, onDraft }: { s: State; close: () => void; onDraft: () => void }) {
  return <>
    {typeIds(s).map(t => <button key={t} className="menu-item" onClick={() => { close(); newEntity(t) }}>New {typeDef(s, t).one.toLowerCase()}</button>)}
    <div className="menu-sep" />
    <button className="menu-item" onClick={() => { close(); onDraft() }}><Spark size={13} />Draft with the assistant</button>
  </>
}

/** #world with nothing selected: every type, its entries as tiles, and ways to add more. */
function Overview({ s, onDraft }: { s: State; onDraft: () => void }) {
  const used = typeIds(s).filter(t => entities(s, t).length), unused = typeIds(s).filter(t => !entities(s, t).length)
  return (
    <div className="w-over">
      <div className="stack" style={{ gap: 6 }}>
        <h1 className="w-name">World</h1>
        <p className="w-lead muted">People, places, groups and objects: everything that exists in your stories. Each kind has its own sheet, with fields you can change in <button className="link" onClick={() => openSettings('types')}>Types and fields</button>.</p>
      </div>
      {used.map(t => (
        <section key={t} className="stack">
          <div className="row"><h2 className="w-sec-h">{typeDef(s, t).label}</h2><span className="lbl">{entities(s, t).length}</span><span className="grow" />
            <button className="btn sm ghost" onClick={() => newEntity(t)}>+ New {typeDef(s, t).one.toLowerCase()}</button></div>
          <div className="w-grid">{entities(s, t).map(x => {
            const n = castOf(s, x.id).length
            return <a key={x.id} className="w-tile" href={'#world/' + x.id}><Av name={x.name} size={32} />
              <span className="grow"><b>{x.name || 'Unnamed'}</b><span className="w-tile-sum">{x.summary || <span className="faint">No summary yet</span>}</span>
                <span className="lbl" style={{ fontWeight: 400 }}>{n ? `In ${n} scene${n === 1 ? '' : 's'}` : 'Not in a scene yet'}</span></span></a>
          })}</div>
        </section>
      ))}
      <div className="row">
        {unused.map(t => <button key={t} className="chip dash" onClick={() => newEntity(t)}>+ {typeDef(s, t).one}</button>)}
        <button className="btn sm soft" onClick={onDraft}><Spark size={13} />Draft with the assistant</button>
      </div>
    </div>
  )
}

/** Describe something new; the assistant drafts it as a proposed change. Nothing is added before Apply. */
function DraftNew({ s, onClose }: { s: State; onClose: () => void }) {
  const [type, setType] = useState(typeIds(s)[0] || 'character')
  const [text, setText] = useState('')
  const [props, setProps] = useState<Proposal[]>([])
  const job = useJob()
  const ready = aiReady(useAI())
  const one = typeDef(s, type).one.toLowerCase()
  const draft = () => job.run(`Drafting a ${one}…`, async sig => {
    const [p] = await completeJSON<Proposal[]>('assist', draftEntity(getState(), one, text), sig)
    if (!p?.data) throw new Error('The assistant didn’t return a draft. Try a longer description.')
    setProps([normalizeProposal(getState(), { ...p, op: 'create', kind: 'entity', data: { ...p.data, type } })])
  })
  return (
    <section className="card w-draft" aria-label="Draft with the assistant">
      <div className="row nowrap"><span className="spark-ic"><Spark size={12} /></span><b className="grow">Draft with the assistant</b><button className="x" aria-label="Close" onClick={onClose}>×</button></div>
      {!ready && <ConnectPrompt what="draft from a description" />}
      {!props.length && <>
        <div className="row nowrap">
          <select className="f" style={{ width: 170 }} value={type} aria-label="Kind" onChange={ev => setType(ev.target.value)}>{typeIds(s).map(t => <option key={t} value={t}>{typeDef(s, t).one}</option>)}</select>
          <span className="small muted">Comes back as a proposed change. Nothing is added until you apply it.</span>
        </div>
        <textarea className="f" autoFocus value={text} placeholder={`Describe the ${one} in a sentence or two: who or what it is, and what it does to the story`} onChange={ev => setText(ev.target.value)}
          onKeyDown={ev => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && text.trim() && ready) draft() }} />
        <div className="row"><button className="btn sm ai" disabled={!text.trim() || !!job.busy || !ready} onClick={draft}><Spark size={13} />Draft</button></div>
      </>}
      <JobStatus job={job} />
      <ProposedChanges s={s} items={props} onChange={setProps} applyLabel={() => 'Add to the world'}
        onApplied={ps => { const id = ps[0]?.newId; onClose(); if (id) go('world/' + id) }} />
    </section>
  )
}

// ---------------- one sheet: the sheet on the left, its connections on the right ----------------

function Sheet({ s, e, layout }: { s: State; e: Entity; layout: (bar: ReactNode, body: ReactNode) => ReactNode }) {
  const def = typeDef(s, e.type), one = def.one.toLowerCase(), first = firstName(e)
  const edit = (fn: (x: Entity) => void) => update<'entity'>(e.id, fn)
  const job = useJob()
  const ready = aiReady(useAI())
  const [props, setProps] = useState<Proposal[]>([])
  const [opts, setOpts] = useState<{ key: string; items: Proposal[]; pick?: number }>()
  const [idea, setIdea] = useState(false)
  const [hist, setHist] = useState(false)
  const scenes = castOf(s, e.id)
  const povOf = stories(s).filter(st => st.pov === e.id)
  const blank = !e.summary.trim() && !Object.values(e.fields).some(v => v?.trim()) && !e.notes.trim()
  const empty = def.fields.filter(fd => !e.fields[fd.key]?.trim())
  const extra = Object.keys(e.fields).filter(k => !def.fields.some(x => x.key === k) && e.fields[k]?.trim())
  const person = isPerson(s, e)
  const fill = () => job.run('Filling empty fields from the canon…', async sig => {
    const out = perField((await completeJSON<Proposal[]>('assist', fillGaps(getState(), e), sig)).map(p => normalizeProposal(getState(), p)))
    setProps(out)
    if (!out.length) job.setErr('Nothing to fill: the canon doesn’t say more about this yet.')
  })
  const suggest = (key: string, label: string) => ready ? job.run(`Suggesting a ${label.toLowerCase()}…`, async sig => setOpts({ key, items: await completeJSON<Proposal[]>('assist', fillGaps(getState(), e, key), sig) })) : openSettings('assistant')
  const problems = () => ready ? job.run(`Looking for problems with ${first}…`, sig => findProblemsAbout(e.id, sig)) : openSettings('assistant')
  const items: (AssistItem | 'sep')[] = [
    { label: 'Fill empty fields', hint: empty.length ? `${empty.length} empty on this sheet, from what the canon already implies` : 'Every field has a value: suggests improvements to thin ones', dest: 'Fields', run: fill },
    { label: 'Draft with the assistant', hint: `Describe this ${one} in a sentence; it drafts the sheet`, dest: 'Fields', run: () => setIdea(true) },
    'sep',
    { label: 'Find problems', hint: `Plot holes and contradictions about ${first}`, dest: 'Questions', run: problems },
    ...(person ? [{ label: `Interview ${first}`, hint: 'A conversation in character, in the assistant panel', dest: 'Assistant', run: () => startInterview(e.id), local: true }] : []),
  ]
  const bar = (
    <Bar>
      <div className="crumbs grow"><a href="#world">World</a><Icon name="chevron" size={12} /><span className="clip">{def.label}</span><Icon name="chevron" size={12} /><b className="clip">{e.name || 'Unnamed'}</b></div>
      <PinButton s={s} id={e.id} />
      {person && <button className="btn sm" onClick={() => startInterview(e.id)}>Interview {first}</button>}
      <AssistMenu items={items} busy={job.busy} />
      <Popover className="right" trigger={o => <button className="icon-btn" aria-label="More" title="More" onClick={o}><Icon name="more" /></button>}>{close => <>
        <button className="menu-item" onClick={() => { close(); askAssistant(`What doesn't hold up about ${e.name}?`) }}>Ask the assistant about {first}</button>
        <button className="menu-item" onClick={() => { close(); setHist(true) }}><Icon name="history" size={14} />History</button>
        <div className="menu-sep" />
        <button className="menu-item danger" onClick={() => { close(); tx(`Delete ${e.name}`, () => remove(e.id)); go('world') }}><Icon name="trash" size={14} />Delete {one}</button>
      </>}</Popover>
      <span className="bar-sep" />
    </Bar>
  )
  const field = (key: string, label: string, hint: string, value: string, set: (v: string) => void, canSuggest: boolean) => {
    const mine = opts?.key === key ? opts : undefined
    return [
      <span key={key + 'k'} className="k" title={hint}>{label}</span>,
      <div key={key + 'v'} className={'v' + (value.trim() ? '' : ' unset')}>
        <div className="row nowrap" style={{ alignItems: 'flex-start', gap: 8 }}>
          <textarea className="inline" rows={1} value={value} placeholder={hint || '—'} aria-label={label} onChange={ev => set(ev.target.value)} />
          {canSuggest && !value.trim() && !blank && <button className="btn sm soft w-suggest" disabled={!!job.busy} title={ready ? `Suggest a ${label.toLowerCase()}` : 'Connect an assistant'} onClick={() => suggest(key, label)}><Spark size={12} />Suggest</button>}
        </div>
        {mine && <div className="w-opts">
          <span className="lbl">Suggestions for {label.toLowerCase()}</span>
          {mine.items.map((p, i) => { const val = String(Object.values(p.set || {})[0] ?? ''); return (
            <button key={i} className={'w-opt' + (mine.pick === i ? ' on' : '')} aria-pressed={mine.pick === i} onClick={() => setOpts({ ...mine, pick: i })}>
              <span className="rad" /><span className="grow"><b>{val}</b>{p.why && <span>{p.why}</span>}</span></button>) })}
          <div className="row">
            <button className="btn sm pri" disabled={mine.pick === undefined} onClick={() => { const v = String(Object.values(mine.items[mine.pick!].set || {})[0] ?? ''); tx(`Set ${label.toLowerCase()}`, () => set(v)); setOpts(undefined) }}>Use this</button>
            <button className="btn sm ghost" onClick={() => setOpts(undefined)}>None of these</button>
          </div>
        </div>}
      </div>,
    ]
  }
  return layout(bar, (
    <div className="w-sheet">
      <div className="w-main">
        <div className="row nowrap" style={{ alignItems: 'flex-start', gap: 16 }}>
          <Picture s={s} about={e.id} fallback={<Av name={e.name} big />} />
          <div className="stack grow" style={{ gap: 6 }}>
            <input className="w-name" value={e.name} aria-label="Name" placeholder="Name" autoFocus={/^New /.test(e.name)} onFocus={ev => { if (/^New /.test(e.name)) ev.target.select() }} onChange={ev => edit(x => { x.name = ev.target.value })} />
            <div className="row small muted" style={{ gap: 8, fontSize: 13 }}>
              <Popover trigger={o => <button className="w-type-pill" title="Change the type" onClick={o}>{def.one}<Icon name="down" size={11} /></button>}>{close => <>
                {typeIds(s).map(t => <button key={t} className={'menu-item' + (t === e.type ? ' on' : '')} onClick={() => { close(); if (t !== e.type) tx('Change type', () => edit(x => { x.type = t })) }}>{typeDef(s, t).one}</button>)}
                <div className="menu-sep" /><button className="menu-item" onClick={() => { close(); openSettings('types') }}>Types and fields…</button>
              </>}</Popover>
              <span>{scenes.length ? `In ${scenes.length} scene${scenes.length === 1 ? '' : 's'}` : 'Not in any scene yet'}
                {povOf.length > 0 && <> · point of view of {povOf.map((st, i) => <span key={st.id}>{i ? ', ' : ''}<a href={'#story/' + st.id}>{st.title}</a></span>)}</>}</span>
            </div>
          </div>
        </div>

        {(blank || idea) && <Idea s={s} e={e} onClose={blank ? undefined : () => setIdea(false)} />}
        <textarea className="inline w-lead" value={e.summary} placeholder={`One or two sentences: who or what this ${one} is to the story`} aria-label="Summary" onChange={ev => edit(x => { x.summary = ev.target.value })} />
        <JobStatus job={job} />

        <div className="w-fields">
          {field('aliases', 'Also known as', 'Other names, comma-separated', e.aliases.join(', '), v => edit(x => { x.aliases = v.split(',').map(a => a.trimStart()).filter((a, i, all) => a || i === all.length - 1) }), false)}
          {def.fields.map(fd => field(fd.key, fd.label, fd.hint || '', e.fields[fd.key] || '', v => edit(x => { x.fields[fd.key] = v }), true))}
          {extra.map(k => field(k, k, '', e.fields[k] || '', v => edit(x => { x.fields[k] = v }), false))}
          {field('notes', 'Notes', 'Anything that doesn’t fit a field', e.notes, v => edit(x => { x.notes = v }), false)}
        </div>
        <ProposedChanges s={s} items={props} onChange={setProps} />
      </div>

      <aside className="w-rail" aria-label="Connections">
        {hist && <section className="w-card"><div className="w-ch"><b>History</b><button className="x" aria-label="Close history" onClick={() => setHist(false)}>×</button></div><History id={e.id} /></section>}
        <Relations s={s} e={e} />
        <Knows s={s} e={e} />
        <section className="w-card">
          <div className="w-ch"><b>Appears in</b><span className="lbl">{scenes.length}</span></div>
          {scenes.map(sc => <a key={sc.id} className="w-rr w-link" href={'#' + hrefOf(s, sc.id)}><span className="mono muted">{shortRef(s, sc.id)}</span><span className="clip">{sc.title || 'Untitled scene'}</span></a>)}
          {!scenes.length && <span className="small muted">No scene lists {first} in its cast yet. Add {person ? 'them' : 'it'} from a scene card.</span>}
        </section>
        <ResearchCard s={s} about={e.id} />
        <Voice s={s} e={e} person={person} />
        <section className="w-card">
          <div className="w-ch"><b>Questions</b><span className="lbl">{questionsAbout(s, e.id).filter(q => !q.answer && !q.dismissed).length} open</span></div>
          {questionsAbout(s, e.id).filter(q => !q.answer && !q.dismissed).map(q => (
            <a key={q.id} className="w-q" href={'#questions/' + q.id}><span className={'tag ' + q.type}>{QKINDS.find(k => k.id === q.type)?.label}</span><span className="w-q-t">{q.text || 'Untitled question'}</span></a>
          ))}
          <button className="btn sm soft" style={{ alignSelf: 'flex-start' }} disabled={!!job.busy} title={ready ? undefined : 'Connect an assistant'} onClick={problems}><Spark size={12} />Find problems</button>
        </section>
      </aside>
    </div>
  ))
}

/** Describe this entity; the assistant drafts its fields as proposed changes, one per field. */
function Idea({ s, e, onClose }: { s: State; e: Entity; onClose?: () => void }) {
  const [text, setText] = useState('')
  const [props, setProps] = useState<Proposal[]>([])
  const job = useJob()
  const ready = aiReady(useAI())
  const one = typeDef(s, e.type).one.toLowerCase()
  const draft = () => job.run('Drafting the sheet…', async sig => {
    const [p] = await completeJSON<Proposal[]>('assist', draftEntity(getState(), one, text), sig)
    const d = (p?.data || {}) as { name?: string; summary?: string; fields?: Record<string, string> }
    const set: Record<string, unknown> = {}
    if (d.name && d.name !== e.name) set.name = d.name
    if (d.summary) set.summary = d.summary
    for (const [k, v] of Object.entries(d.fields || {})) if (v && String(v).trim()) set['fields.' + k] = v
    if (!Object.keys(set).length) throw new Error('The assistant didn’t return a draft. Try a longer description.')
    setProps(perField([{ op: 'update', id: e.id, set, why: p?.why }]))
  })
  return (
    <section className="card tint w-idea" aria-label="Draft with the assistant">
      <div className="row nowrap"><span className="spark-ic"><Spark size={12} /></span><b className="grow">Draft with the assistant</b>{onClose && <button className="x" aria-label="Close" onClick={onClose}>×</button>}</div>
      {!ready && <ConnectPrompt what="draft this sheet" />}
      {!props.length && <>
        <textarea className="f" value={text} autoFocus={!!onClose} placeholder={`A sentence or two about this ${one}. The assistant drafts the sheet; you keep what you like.`} onChange={ev => setText(ev.target.value)} />
        <div className="row"><button className="btn sm ai" disabled={!text.trim() || !!job.busy || !ready} onClick={draft}><Spark size={13} />Draft the sheet</button>
          <span className="small muted">Each field comes back as a proposed change.</span></div>
      </>}
      <JobStatus job={job} />
      <ProposedChanges s={s} items={props} onChange={setProps} onApplied={() => onClose?.()} />
    </section>
  )
}

/** Relations in both directions, in one list: this sheet's label, and the other side's if it has one. */
function Relations({ s, e }: { s: State; e: Entity }) {
  const edit = (fn: (x: Entity) => void) => update<'entity'>(e.id, fn)
  const ids = [...new Set([...e.relations.map(r => r.to), ...entities(s).filter(x => x.id !== e.id && x.relations.some(r => r.to === e.id)).map(x => x.id)])].filter(id => get(s, id, 'entity'))
  const setLabel = (to: string, v: string) => edit(x => { const j = x.relations.findIndex(r => r.to === to); if (j < 0) x.relations.push({ to, label: v }); else x.relations[j].label = v })
  return (
    <section className="w-card">
      <div className="w-ch"><b>Relations</b><span className="lbl">{ids.length}</span></div>
      {ids.map(id => {
        const o = get(s, id, 'entity')!
        const mine = e.relations.find(r => r.to === id), theirs = o.relations.find(r => r.to === e.id)
        return (
          <div key={id} className="w-rr w-rel">
            <Av name={o.name} size={20} />
            <a href={'#world/' + id} className="w-rel-name clip">{o.name}</a>
            <span className="w-rel-how">
              <input className="inline" value={mine?.label || ''} placeholder={mine ? 'how: sister, owes money to…' : 'add this side'} aria-label={`How ${e.name} relates to ${o.name}`} onChange={ev => setLabel(id, ev.target.value)} />
              {theirs && <span className="small muted">{firstName(o)} says {theirs.label ? `“${theirs.label}”` : 'related'}</span>}
            </span>
            <span className="lbl" title={mine && theirs ? 'Both directions' : mine ? 'Only on this sheet' : `Only on ${o.name}’s sheet`}>{mine && theirs ? '↔' : mine ? '→' : '←'}</span>
            {mine && <button className="x" aria-label={`Remove relation to ${o.name}`} onClick={() => tx('Remove relation', () => edit(x => { x.relations = x.relations.filter(r => r.to !== id) }))}>×</button>}
          </div>
        )
      })}
      <RecordPicker s={s} label="+ Relate to…" kinds={['entity']} exclude={[e.id, ...ids]} onPick={id => tx('Add relation', () => edit(x => { x.relations.push({ to: id, label: '' }) }))} />
    </section>
  )
}

/** What this entity knows. Read-only here: knowledge is edited in Timeline › Knowledge. */
function Knows({ s, e }: { s: State; e: Entity }) {
  const facts = list(s, 'fact').filter(x => x.knows[e.id]?.state)
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.text.localeCompare(b.text))
  const code = (x: Fact) => factCode(s, x.id)
  return (
    <section className="w-card">
      <div className="w-ch"><b>What {firstName(e)} knows</b><a className="small muted" href="#knowledge">Knowledge lens</a></div>
      {facts.map(x => {
        const c = x.knows[e.id]
        return (
          <a key={x.id} className="w-rr w-link" href={'#knowledge/' + x.id} title={c.note || undefined}>
            <span className="mono muted">{code(x)}</span><span className="grow clip">{x.text}</span>
            <span className={'w-state k-' + c.state}>{KLABEL[c.state]}{c.from ? ` · ${shortRef(s, c.from)}` : ''}</span>
          </a>
        )
      })}
      {!facts.length && <span className="small muted">Nothing decided yet. Set who knows what in <a href="#knowledge">Timeline › Knowledge</a>.</span>}
    </section>
  )
}

function Voice({ s, e, person }: { s: State; e: Entity; person: boolean }) {
  const scope = 'entity:' + e.id, gs = guidesFor(s, scope)
  const add = (use: GuideKind, title: string) => tx('Add guide', () => { create('guide', { use, scope, title, text: '' }) }, false)
  return (
    <section className="w-card">
      <div className="w-ch"><b>Voice and rules</b>{gs.length > 0 && <span className="lbl">{gs.length}</span>}</div>
      <span className="small muted">{person ? `Sent with drafts where ${firstName(e)} is the point of view or in the scene, and used in interviews.` : `Sent with drafts of scenes that include ${e.name}.`}</span>
      {gs.map(g => <GuideRow key={g.id} g={g} />)}
      <div className="row" style={{ gap: 6 }}>
        {person && <button className="w-dash" onClick={() => add('style', 'Voice')}>+ Voice guide</button>}
        <button className={person ? 'btn sm ghost' : 'w-dash'} onClick={() => add('rule', 'Rule')}>+ Rule</button>
      </div>
    </section>
  )
}

// ---------------- types: the templates entities are built from (shown in Settings › Types and fields) ----------------

export function TypesView({ s }: { s: State }) {
  const types = typesOf(s)
  const set = (label: string, fn: (t: typeof types) => void) => tx(label, () => update<'project'>('project', x => { x.types = structuredClone(x.types || types); fn(x.types) }), false)
  const [name, setName] = useState('')
  return (
    <div className="w-types-view">
      <p className="muted">Rename a kind, change its fields, or add a new kind. Values stay put even if you remove a field.</p>
      {Object.entries(types).map(([id, t]) => {
        const n = entities(s, id).length
        return (
          <div key={id} className="card w-type">
            <div className="row nowrap" style={{ alignItems: 'flex-end' }}>
              <label className="field grow"><span className="lbl">One</span><input className="f" value={t.one} onChange={ev => set('Rename type', x => { x[id].one = ev.target.value })} /></label>
              <label className="field grow"><span className="lbl">Many</span><input className="f" value={t.label} onChange={ev => set('Rename type', x => { x[id].label = ev.target.value })} /></label>
              <span className="small muted" style={{ paddingBottom: 8, whiteSpace: 'nowrap' }}>{n} {n === 1 ? 'entry' : 'entries'}</span>
              <button className="btn sm ghost danger" style={{ marginBottom: 3 }} disabled={n > 0} title={n ? 'Move or delete its entries first' : 'Delete this type'} onClick={() => set(`Delete type ${t.label}`, x => { delete x[id] })}>Delete</button>
            </div>
            <span className="lbl">Fields</span>
            <div className="stack" style={{ gap: 6 }}>
              {t.fields.map((fd, i) => (
                <div key={fd.key} className="row nowrap" style={{ gap: 6 }}>
                  <input className="f" style={{ flex: '1 1 150px' }} value={fd.label} aria-label="Field name" onChange={ev => set('Rename field', x => { x[id].fields[i].label = ev.target.value })} />
                  <input className="f" style={{ flex: '2 1 200px' }} value={fd.hint || ''} placeholder="Hint shown in the empty field" aria-label="Hint" onChange={ev => set('Edit hint', x => { x[id].fields[i].hint = ev.target.value })} />
                  <button className="icon-btn sm" disabled={i === 0} title="Move up" aria-label="Move up" onClick={() => set('Move field', x => { const fs = x[id].fields; [fs[i - 1], fs[i]] = [fs[i], fs[i - 1]] })}>↑</button>
                  <button className="x" aria-label="Remove field" title="Remove field" onClick={() => set('Remove field', x => { x[id].fields.splice(i, 1) })}>×</button>
                </div>
              ))}
            </div>
            <AddField onAdd={label => set('Add field', x => { const key = slug(label).replace(/-/g, '_'); if (!x[id].fields.some(y => y.key === key)) x[id].fields.push(f(key, label)) })} />
          </div>
        )
      })}
      <div className="row nowrap">
        <input className="f" style={{ maxWidth: 260 }} value={name} placeholder="New type, e.g. Vehicle" aria-label="New type" onChange={ev => setName(ev.target.value)} />
        <button className="btn" disabled={!name.trim() || !!types[slug(name)]} onClick={() => { const one = name.trim(); set(`Add type ${one}`, x => { x[slug(one)] = { one, label: one + 's', fields: [f('description', 'Description'), f('significance', 'Story significance', 'Why the story needs it')] } }); setName('') }}>Add type</button>
      </div>
      <p className="small muted">Types belong to the project{project(s).title ? ` “${project(s).title}”` : ''}. A guide can apply to a whole type: Settings › Guides.</p>
    </div>
  )
}

function AddField({ onAdd }: { onAdd: (label: string) => void }) {
  const [v, setV] = useState('')
  const add = () => { if (v.trim()) { onAdd(v.trim()); setV('') } }
  return <div className="row nowrap"><input className="f" style={{ maxWidth: 260 }} value={v} placeholder="+ Field" aria-label="New field" onChange={ev => setV(ev.target.value)} onKeyDown={ev => { if (ev.key === 'Enter') add() }} />
    {v.trim() && <button className="btn sm" onClick={add}>Add</button>}</div>
}
