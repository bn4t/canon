import { useEffect, useState } from 'react'
import {
  update, create, remove, tx, get, list, getState, stories, allScenes, entities, typeIds, typeDef, typesOf, project, nameOf, sceneRef, guidesFor, questionsAbout,
  newEntityData, applyProposal, type State, type Entity, type Proposal, type KState, type GuideKind,
} from '../store.ts'
import { f, slug } from '../schema.ts'
import { completeJSON } from '../ai.ts'
import { fillGaps, draftEntity, discoveries, interviewSystem, normalizeProposal } from '../prompts.ts'
import { Area, Proposals, useJob, JobStatus, Popover, go, replaceRoute } from '../ui.tsx'
import { QuestionCard, FindProblems, History, ChatPane, GuideRow } from './shared.tsx'

const AVATAR = ['var(--l-blue)', 'var(--l-purple)', 'var(--l-green)', 'var(--l-orange)', 'var(--l-red)', 'var(--l-yellow)']
const avatarColor = (name: string) => AVATAR[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR.length]
const KWORD: Record<KState, string> = { '': 'undecided', knows: 'knows', almost: 'almost knows', believes: 'believes otherwise', never: 'never knows' }

export function newEntity(type: string, name?: string) {
  let id = ''
  const one = typeDef(getState(), type).one.toLowerCase()
  tx(`New ${one}`, () => { id = create('entity', newEntityData(type, name || `New ${one}`)) }, false)
  go('world/' + id)
  return id
}

export function WorldView({ s, id }: { s: State; id?: string }) {
  const e = get(s, id, 'entity') || (id ? undefined : entities(s)[0])
  useEffect(() => { if (e && !id) replaceRoute('world/' + e.id) }, [e, id])
  return (
    <div className="cols">
      <Index s={s} cur={e?.id} />
      {e ? <Sheet key={e.id} s={s} e={e} /> : <div className="empty"><h2>The world</h2><p>People, places, groups, objects: anything that exists in your stories. Each kind has its own sheet, and you can change the kinds under Types.</p>
        <div className="row">{typeIds(s).slice(0, 3).map(t => <button key={t} className="btn" onClick={() => newEntity(t)}>New {typeDef(s, t).one.toLowerCase()}</button>)}<a className="btn ghost" href="#world/types">Types</a></div></div>}
    </div>
  )
}

function Index({ s, cur }: { s: State; cur?: string }) {
  const [q, setQ] = useState('')
  const job = useJob()
  const [idea, setIdea] = useState<{ type: string; text: string }>()
  const hit = (e: Entity) => !q || (e.name + ' ' + e.aliases.join(' ')).toLowerCase().includes(q.toLowerCase())
  const draft = () => job.run('Drafting…', async sig => {
    const [p] = await completeJSON<Proposal[]>('assist', draftEntity(getState(), typeDef(getState(), idea!.type).one.toLowerCase(), idea!.text), sig)
    if (!p?.data) throw new Error('The assistant didn’t return a draft. Try a longer description.')
    let id = ''
    tx('Draft from description', () => { id = applyProposal(normalizeProposal(getState(), { ...p, data: { ...p.data, type: idea!.type } }))! })
    setIdea(undefined); go('world/' + id)
  })
  return (
    <nav className="index" aria-label="World">
      <input className="f" placeholder="Find in the world" aria-label="Find in the world" value={q} onChange={e => setQ(e.target.value)} style={{ marginBottom: 6 }} />
      {typeIds(s).map(t => {
        const es = entities(s, t).filter(hit)
        if (q && !es.length) return null
        return <div key={t} style={{ display: 'contents' }}>
          <div className="grp"><span>{typeDef(s, t).label} · {entities(s, t).length}</span><button className="x" title={`New ${typeDef(s, t).one.toLowerCase()}`} onClick={() => newEntity(t)}>+</button></div>
          {es.map(e => <a key={e.id} href={'#world/' + e.id} className={e.id === cur ? 'on' : ''}><span className="clip">{e.name}</span></a>)}
        </div>
      })}
      {idea ? <div className="card" style={{ marginTop: 10, padding: 10 }}>
        <select className="f" value={idea.type} aria-label="Kind" onChange={e => setIdea({ ...idea, type: e.target.value })}>{typeIds(s).map(t => <option key={t} value={t}>{typeDef(s, t).one}</option>)}</select>
        <textarea className="f" autoFocus value={idea.text} placeholder="Describe it in a sentence or two" onChange={e => setIdea({ ...idea, text: e.target.value })} />
        <JobStatus job={job} />
        <div className="row"><button className="btn sm ai" disabled={!idea.text.trim() || !!job.busy} onClick={draft}>✦ Draft it</button><button className="btn sm ghost" onClick={() => setIdea(undefined)}>Cancel</button></div>
      </div> : <button className="item add" onClick={() => setIdea({ type: typeIds(s)[0] || 'character', text: '' })}>+ Describe something new</button>}
      <a href="#world/types" style={{ marginTop: 8 }}><span className="muted">Types and their fields</span></a>
    </nav>
  )
}

function Sheet({ s, e }: { s: State; e: Entity }) {
  const def = typeDef(s, e.type)
  const edit = (fn: (x: Entity) => void) => update<'entity'>(e.id, fn)
  const job = useJob()
  const [props, setProps] = useState<Proposal[]>([])
  const [opts, setOpts] = useState<{ key: string; items: Proposal[] }>()
  const scenes = allScenes(s).filter(sc => sc.cast.includes(e.id))
  const blank = !e.summary && !Object.values(e.fields).some(v => v?.trim()) && !e.notes.trim()
  const extra = Object.keys(e.fields).filter(k => !def.fields.some(x => x.key === k) && e.fields[k]?.trim())
  const fill = () => job.run('Filling gaps from the canon…', async sig => setProps((await completeJSON<Proposal[]>('assist', fillGaps(getState(), e), sig)).map(p => normalizeProposal(getState(), p))))
  const suggest = (key: string) => job.run('Thinking of options…', async sig => setOpts({ key, items: await completeJSON<Proposal[]>('assist', fillGaps(getState(), e, key), sig) }))
  const qs = questionsAbout(s, e.id).filter(q => !q.dismissed)
  return (
    <div style={{ minWidth: 0 }}>
      <div className="body" style={{ maxWidth: 820, margin: '0 auto', paddingTop: 36 }}>
        <div className="row nowrap" style={{ alignItems: 'flex-start', gap: 14 }}>
          <div className="avatar" style={{ background: avatarColor(e.name), marginTop: 4 }}>{e.name.trim()[0]?.toUpperCase() || '?'}</div>
          <div className="grow">
            <input className="doc-title" value={e.name} aria-label="Name" autoFocus={/^New /.test(e.name)} onFocus={ev => { if (/^New /.test(e.name)) ev.target.select() }} onChange={ev => edit(x => { x.name = ev.target.value })} />
            <div className="row small muted" style={{ gap: 6 }}>
              <select className="f plain" style={{ width: 'auto', color: 'var(--muted)' }} value={e.type} aria-label="Type" onChange={ev => tx('Change type', () => edit(x => { x.type = ev.target.value }))}>{typeIds(s).map(t => <option key={t} value={t}>{typeDef(s, t).one}</option>)}</select>
              <span>· {scenes.length ? `appears in ${scenes.length} scene${scenes.length === 1 ? '' : 's'}` : 'not in any scene yet'}</span>
            </div>
          </div>
          <Popover className="right" trigger={o => <button className="btn sm ghost" aria-label="More" title="More" onClick={o}>⋯</button>}>{close => <>
            <button className="menu-item" onClick={() => { close(); dispatchEvent(new CustomEvent('canon:ask', { detail: `Pressure-test ${e.name}: what doesn't hold up?` })) }}>Ask the assistant about {e.name.split(' ')[0]}</button>
            <button className="menu-item danger" onClick={() => { tx(`Delete ${e.name}`, () => remove(e.id)); go('world') }}>Delete</button>
          </>}</Popover>
        </div>

        {blank && <Idea s={s} e={e} />}
        <textarea className="inline lead" value={e.summary} placeholder={`One or two sentences: who or what this ${def.one.toLowerCase()} is to the story`} aria-label="Summary" onChange={ev => edit(x => { x.summary = ev.target.value })} />

        <div className="sheet-fields">
          <span className="k">Also known as</span>
          <div className="v"><input className="inline" value={e.aliases.join(', ')} placeholder="Comma-separated" onChange={ev => edit(x => { x.aliases = ev.target.value.split(',').map(a => a.trimStart()) })} /></div>
          {def.fields.map(fd => {
            const v = e.fields[fd.key] || ''
            const mine = opts?.key === fd.key ? opts.items : []
            return [
              <span key={fd.key + 'k'} className="k" title={fd.hint}>{fd.label}</span>,
              <div key={fd.key + 'v'} className="v">
                <div className="row nowrap" style={{ alignItems: 'start', gap: 4 }}>
                  <textarea className="inline" rows={1} value={v} placeholder={fd.hint || '—'} aria-label={fd.label} onChange={ev => edit(x => { x.fields[fd.key] = ev.target.value })} />
                  {!v.trim() && !blank && <button className="btn sm ghost hover-only ai-text" title="Suggest options" disabled={!!job.busy} onClick={() => suggest(fd.key)}>✦</button>}
                </div>
                {mine.length > 0 && <div className="card gap" style={{ padding: 10, marginTop: 4 }}>
                  <span className="kicker ai">Options for {fd.label.toLowerCase()}</span>
                  {mine.map((p, i) => { const val = String(Object.values(p.set || {})[0] ?? ''); return <button key={i} className="opt" onClick={() => { tx(`Set ${fd.label.toLowerCase()}`, () => edit(x => { x.fields[fd.key] = val })); setOpts(undefined) }}><b>{val}</b>{p.why && <span>{p.why}</span>}</button> })}
                  <div className="row"><button className="btn sm ghost" onClick={() => setOpts(undefined)}>None of these</button></div>
                </div>}
              </div>,
            ]
          })}
          {extra.map(k => [<span key={k + 'k'} className="k">{k}</span>, <div key={k + 'v'} className="v"><textarea className="inline" rows={1} value={e.fields[k]} onChange={ev => edit(x => { x.fields[k] = ev.target.value })} /></div>])}
          <span className="k">Notes</span>
          <div className="v"><textarea className="inline" rows={1} value={e.notes} placeholder="Anything that doesn't fit a field" onChange={ev => edit(x => { x.notes = ev.target.value })} /></div>
        </div>
        {!blank && <div className="row"><button className="btn sm soft" disabled={!!job.busy} onClick={fill}>✦ Fill the gaps from the canon</button></div>}
        <JobStatus job={job} />
        <Proposals s={s} items={props} onChange={setProps} />

        <Relations s={s} e={e} />
        <Knows s={s} e={e} />
        <EntityGuides s={s} e={e} />

        <section className="stack">
          <h3>Questions about {e.name.split(' ')[0]}</h3>
          {qs.map(q => <QuestionCard key={q.id} s={s} q={q} compact />)}
          {!blank && <FindProblems s={s} focus={e.id} label={`Find what doesn't hold up`} />}
        </section>

        {e.type === 'character' || list(s, 'chat').some(c => c.mode === 'interview' && c.entity === e.id) || /person|character|people/i.test(def.label) ? <Interview s={s} e={e} /> : null}

        <section className="stack">
          <h3>Appears in</h3>
          {!scenes.length && <p className="muted small">No scene lists {e.name} in its cast yet.</p>}
          <div className="row" style={{ gap: 4 }}>{scenes.map(sc => <a key={sc.id} className="chip" href={`#write/${sc.story}/${sc.id}`}><span className="mono faint">{sceneRef(s, sc)}</span>{sc.title}</a>)}</div>
          {stories(s).filter(st => st.pov === e.id).map(st => <span key={st.id} className="small muted">Point of view of <a href={'#story/' + st.id}>{st.title}</a></span>)}
        </section>

        <details><summary className="lbl" style={{ cursor: 'pointer' }}>Change history</summary><div style={{ marginTop: 10 }}><History id={e.id} /></div></details>
      </div>
    </div>
  )
}

function Idea({ s, e }: { s: State; e: Entity }) {
  const [idea, setIdea] = useState('')
  const [props, setProps] = useState<Proposal[]>([])
  const job = useJob()
  const def = typeDef(s, e.type)
  const draft = () => job.run('Drafting…', async sig => {
    const [p] = await completeJSON<Proposal[]>('assist', draftEntity(getState(), def.one.toLowerCase(), idea), sig)
    const d = (p?.data || {}) as { name?: string; summary?: string; fields?: Record<string, string> }
    const set: Record<string, unknown> = {}
    if (d.name) set.name = d.name
    if (d.summary) set.summary = d.summary
    for (const [k, v] of Object.entries(d.fields || {})) set['fields.' + k] = v
    setProps([{ op: 'update', id: e.id, set, why: p?.why }])
  })
  return (
    <div className="card gap">
      <span className="kicker ai">Start from an idea</span>
      <Area value={idea} placeholder={`A sentence or two about this ${def.one.toLowerCase()}. The assistant drafts the sheet; you keep what you like.`} onChange={setIdea} />
      <div className="row"><button className="btn sm ai" disabled={!idea.trim() || !!job.busy} onClick={draft}>✦ Draft the sheet</button></div>
      <JobStatus job={job} />
      <Proposals s={s} items={props} onChange={setProps} />
    </div>
  )
}

function Relations({ s, e }: { s: State; e: Entity }) {
  const edit = (fn: (x: Entity) => void) => update<'entity'>(e.id, fn)
  const others = entities(s).filter(x => x.id !== e.id && !e.relations.some(r => r.to === x.id))
  const back = entities(s).filter(x => x.relations.some(r => r.to === e.id) && !e.relations.some(r => r.to === x.id))
  return (
    <section className="stack">
      <h3>Relations</h3>
      {e.relations.map((r, i) => (
        <div key={r.to + i} className="row nowrap">
          <a className="chip on" href={'#world/' + r.to}>{nameOf(s, r.to) || 'Missing'}</a>
          <input className="f" style={{ padding: '3px 8px' }} value={r.label} placeholder="how: sister, owes money to, works for…" aria-label="Relation" onChange={ev => edit(x => { x.relations[i].label = ev.target.value })} />
          <button className="x" aria-label="Remove relation" onClick={() => tx('Remove relation', () => edit(x => { x.relations.splice(i, 1) }))}>×</button>
        </div>
      ))}
      {back.length > 0 && <p className="small muted">Also linked from: {back.map((x, i) => <span key={x.id}>{i ? ', ' : ''}<a href={'#world/' + x.id}>{x.name}</a> ({x.relations.find(r => r.to === e.id)?.label || 'related'})</span>)}</p>}
      <select className="f" style={{ maxWidth: 280 }} value="" aria-label="Add relation" onChange={ev => tx('Add relation', () => edit(x => { x.relations.push({ to: ev.target.value, label: '' }) }))}>
        <option value="">+ Relate to…</option>
        {typeIds(s).map(t => { const xs = others.filter(o => o.type === t); return xs.length ? <optgroup key={t} label={typeDef(s, t).label}>{xs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</optgroup> : null })}
      </select>
    </section>
  )
}

function Knows({ s, e }: { s: State; e: Entity }) {
  const rows = list(s, 'fact').filter(x => x.knows[e.id]?.state)
  return (
    <section className="stack">
      <div className="row"><h3>What {e.name.split(' ')[0]} knows</h3><span className="grow" /><a className="small muted" href="#knowledge">Who knows what</a></div>
      {!rows.length && <p className="muted small">Nothing decided yet. Set it on any event or fact, or in the knowledge grid.</p>}
      <div className="row" style={{ gap: 6 }}>{rows.map(x => { const c = x.knows[e.id]; return (
        <a key={x.id} className={'chip k-' + c.state} href={'#timeline/' + x.id} title={c.note}>{nameOf(s, x.id)} · {KWORD[c.state]}{c.from ? ` from ${nameOf(s, c.from)}` : ''}</a>) })}</div>
    </section>
  )
}

function EntityGuides({ s, e }: { s: State; e: Entity }) {
  const scope = 'entity:' + e.id
  const gs = guidesFor(s, scope)
  const add = (use: GuideKind, title: string) => tx('Add guide', () => { create('guide', { use, scope, title, text: '' }) }, false)
  return (
    <section className="stack">
      <h3>Voice and rules</h3>
      <p className="small muted">Sent with builds when {e.name.split(' ')[0]} is the point of view or in the scene, and used in interviews.</p>
      {gs.map(g => <GuideRow key={g.id} g={g} />)}
      <div className="row"><button className="btn sm" onClick={() => add('style', 'Voice')}>+ Voice guide</button><button className="btn sm ghost" onClick={() => add('rule', 'Rule')}>+ Rule</button></div>
    </section>
  )
}

function Interview({ s, e }: { s: State; e: Entity }) {
  const chats = list(s, 'chat').filter(c => c.mode === 'interview' && c.entity === e.id).sort((a, b) => b.at.localeCompare(a.at))
  const [cid, setCid] = useState<string | undefined>(chats[0]?.id)
  const chat = get(s, cid, 'chat')
  const job = useJob()
  const [props, setProps] = useState<Proposal[]>([])
  const first = e.name.split(' ')[0]
  const start = () => {
    let id = ''
    tx('New interview', () => { id = create('chat', { mode: 'interview', entity: e.id, asOf: chat?.asOf, title: `Interview ${chats.length + 1}`, messages: [], at: new Date().toISOString() }) }, false)
    setCid(id); setProps([])
  }
  const learn = () => job.run('Looking for what’s new…', async sig => setProps((await completeJSON<Proposal[]>('assist', discoveries(getState(), e, chat!.messages), sig)).map(p => normalizeProposal(getState(), p))))
  return (
    <section className="card">
      <div className="row"><h3>Interview</h3><span className="muted small">in character{chat?.asOf ? `, knowing only what they know as of ${nameOf(s, chat.asOf)}` : ''}</span><span className="grow" />
        {chat && <>
          <select className="f" style={{ width: 'auto', padding: '2px 24px 2px 8px' }} value={chat.asOf || ''} aria-label="Knowledge as of" onChange={ev => update<'chat'>(chat.id, x => { x.asOf = ev.target.value || undefined })}>
            <option value="">Knows everything</option>{stories(s).map(st => <option key={st.id} value={st.id}>As of {st.title}</option>)}</select>
          {chats.length > 1 && <select className="f" style={{ width: 'auto', padding: '2px 24px 2px 8px' }} value={chat.id} aria-label="Interview" onChange={ev => { setCid(ev.target.value); setProps([]) }}>{chats.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select>}
          <button className="btn sm ghost" onClick={start}>New</button>
        </>}
      </div>
      {!chat ? <div className="row"><p className="muted small grow">Talk to {first} to discover motives, evasions and details. Afterwards, the assistant turns what's new into proposals for the canon.</p><button className="btn sm pri" onClick={start}>Start an interview</button></div> : <>
        <ChatPane key={chat.id} s={s} chatId={chat.id} persona={first} autoFocus={false}
          system={() => interviewSystem(getState(), get(getState(), e.id, 'entity')!, get(getState(), chat.id, 'chat')?.asOf)} placeholder={`Ask ${first} something…`}
          starters={['What do you want more than anything?', 'Who do you trust, really?', 'What are you not telling me?', 'Describe your morning.']} />
        <JobStatus job={job} />
        <Proposals s={s} items={props} onChange={setProps} label="New for the canon" />
        <div className="row"><button className="btn sm soft" disabled={chat.messages.length < 2 || !!job.busy} onClick={learn}>✦ What did we learn?</button>
          <span className="grow" /><button className="btn sm ghost danger" onClick={() => { tx('Delete interview', () => remove(chat.id)); setCid(chats.find(c => c.id !== chat.id)?.id) }}>Delete interview</button></div>
      </>}
    </section>
  )
}

// ---------------- types: the templates entities are built from ----------------

export function TypesView({ s }: { s: State }) {
  const types = typesOf(s)
  const set = (label: string, fn: (t: typeof types) => void) => tx(label, () => update<'project'>('project', x => { x.types = structuredClone(x.types || types); fn(x.types) }), false)
  const [name, setName] = useState('')
  return (
    <div className="cols">
      <Index s={s} />
      <div className="body" style={{ maxWidth: 860 }}>
        <div><h1>Types</h1><p className="muted">The kinds of things in your world, and the fields each one's sheet has. Rename them, add fields, or add new kinds. Field values are kept even if you remove a field.</p></div>
        {Object.entries(types).map(([id, t]) => {
          const n = entities(s, id).length
          return (
            <div key={id} className="card">
              <div className="row nowrap">
                <label className="field grow"><span className="lbl">One</span><input className="f" value={t.one} onChange={e => set('Rename type', x => { x[id].one = e.target.value })} /></label>
                <label className="field grow"><span className="lbl">Many</span><input className="f" value={t.label} onChange={e => set('Rename type', x => { x[id].label = e.target.value })} /></label>
                <span className="small muted" style={{ alignSelf: 'end', paddingBottom: 8 }}>{n} {n === 1 ? 'entry' : 'entries'}</span>
                <button className="btn sm ghost danger" style={{ alignSelf: 'end' }} disabled={n > 0} title={n ? 'Move or delete its entries first' : 'Delete this type'} onClick={() => set(`Delete type ${t.label}`, x => { delete x[id] })}>Delete</button>
              </div>
              <span className="lbl">Fields</span>
              {t.fields.map((fd, i) => (
                <div key={fd.key} className="row nowrap">
                  <input className="f" style={{ flex: '1 1 160px' }} value={fd.label} aria-label="Field name" onChange={e => set('Rename field', x => { x[id].fields[i].label = e.target.value })} />
                  <input className="f" style={{ flex: '2 1 240px' }} value={fd.hint || ''} placeholder="Hint shown in the empty field" aria-label="Hint" onChange={e => set('Edit hint', x => { x[id].fields[i].hint = e.target.value })} />
                  <button className="btn sm ghost" disabled={i === 0} title="Move up" onClick={() => set('Move field', x => { const fs = x[id].fields; [fs[i - 1], fs[i]] = [fs[i], fs[i - 1]] })}>↑</button>
                  <button className="x" aria-label="Remove field" onClick={() => set('Remove field', x => { x[id].fields.splice(i, 1) })}>×</button>
                </div>
              ))}
              <AddField onAdd={label => set('Add field', x => { const key = slug(label).replace(/-/g, '_'); if (!x[id].fields.some(y => y.key === key)) x[id].fields.push(f(key, label)) })} />
            </div>
          )
        })}
        <div className="row"><input className="f" style={{ maxWidth: 260 }} value={name} placeholder="New type, e.g. Vehicle" onChange={e => setName(e.target.value)} />
          <button className="btn" disabled={!name.trim() || !!types[slug(name)]} onClick={() => { const one = name.trim(); set(`Add type ${one}`, x => { x[slug(one)] = { one, label: one + 's', fields: [f('description', 'Description'), f('significance', 'Story significance', 'Why the story needs it')] } }); setName('') }}>Add type</button></div>
        <p className="small muted">Types live in the project{project(s).title ? ` “${project(s).title}”` : ''}; guides can target a whole type under Project › Guides.</p>
      </div>
    </div>
  )
}

function AddField({ onAdd }: { onAdd: (label: string) => void }) {
  const [v, setV] = useState('')
  return <div className="row nowrap"><input className="f" style={{ maxWidth: 260 }} value={v} placeholder="+ Field" onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && v.trim()) { onAdd(v.trim()); setV('') } }} />
    {v.trim() && <button className="btn sm" onClick={() => { onAdd(v.trim()); setV('') }}>Add</button>}</div>
}
