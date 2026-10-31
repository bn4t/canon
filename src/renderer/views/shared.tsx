import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  update, remove, tx, applyProposal, isApplied, create, get, getState, list, nameOf, entities, events, plainFacts, stories, allScenes, newQuestion, QKINDS, GUIDE_KINDS,
  type State, type Question, type Proposal, type Guide, type GuideKind,
} from '../store.ts'
import { complete, completeJSON } from '../ai.ts'
import { questionOptions, resolveQuestion, findProblems, normalizeProposal, parseProposals, stripProposals, type FoundQ } from '../prompts.ts'
import { useJob, JobStatus, Area, Md, Proposals, Popover } from '../ui.tsx'

/** Where a record lives in the app. */
export function hrefOf(s: State, id: string): string {
  const r = s.recs[id]
  if (!r) return ''
  if (r.kind === 'entity') return 'world/' + id
  if (r.kind === 'fact') return 'timeline/' + id
  if (r.kind === 'story') return 'story/' + id
  if (r.kind === 'scene') return `write/${r.story}/${id}`
  if (r.kind === 'question') return 'questions/' + id
  return ''
}
export const RecLink = ({ s, id }: { s: State; id: string }) => <a className="chip" href={'#' + hrefOf(s, id)}>{nameOf(s, id) || 'Missing'}</a>

/** Pick any record (entities, events, facts, stories, scenes) with a filter box. */
export function RecordPicker({ s, label, exclude = [], onPick, kinds = ['entity', 'fact', 'story', 'scene'] }: { s: State; label: ReactNode; exclude?: string[]; onPick: (id: string) => void; kinds?: string[] }) {
  return <Popover trigger={open => <button className="chip dash" onClick={open}>{label}</button>}>{close => <PickList s={s} exclude={exclude} kinds={kinds} onPick={id => { onPick(id); close() }} />}</Popover>
}
function PickList({ s, exclude, kinds, onPick }: { s: State; exclude: string[]; kinds: string[]; onPick: (id: string) => void }) {
  const [q, setQ] = useState('')
  const all = useMemo(() => [
    ...(kinds.includes('entity') ? entities(s).map(e => ({ id: e.id, g: 'World', n: e.name })) : []),
    ...(kinds.includes('fact') ? [...events(s), ...plainFacts(s)].map(f => ({ id: f.id, g: f.at !== undefined ? 'Events' : 'Facts', n: nameOf(s, f.id) })) : []),
    ...(kinds.includes('story') ? stories(s).map(x => ({ id: x.id, g: 'Stories', n: x.title })) : []),
    ...(kinds.includes('scene') ? allScenes(s).map(x => ({ id: x.id, g: 'Scenes', n: x.title })) : []),
  ].filter(x => !exclude.includes(x.id)), [s, exclude, kinds])
  const hits = all.filter(x => x.n.toLowerCase().includes(q.toLowerCase())).slice(0, 60)
  return <div className="stack" style={{ gap: 4, width: 300 }}>
    <input className="f" autoFocus placeholder="Filter" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && hits[0]) onPick(hits[0].id) }} />
    {hits.map((h, i) => <button key={h.id} className="menu-item" onClick={() => onPick(h.id)}>{(i === 0 || hits[i - 1].g !== h.g) && <span className="lbl" style={{ width: 52 }}>{h.g}</span>}{!(i === 0 || hits[i - 1].g !== h.g) && <span style={{ width: 52 }} />}<span className="clip">{h.n}</span></button>)}
    {!hits.length && <p className="muted small" style={{ padding: 8 }}>Nothing matches.</p>}
  </div>
}

// ---------------- the feedback loop ----------------


/** One question: raise it, get options, decide, and write the decision into the canon. */
export function QuestionCard({ s, q, compact }: { s: State; q: Question; compact?: boolean }) {
  const job = useJob()
  const [props, setProps] = useState<Proposal[]>([])
  const edit = (fn: (x: Question) => void) => update<'question'>(q.id, fn)
  const suggest = () => job.run('Thinking of ways to resolve it…', async sig => {
    const opts = await completeJSON<Question['options']>('assist', questionOptions(getState(), q), sig)
    edit(x => { x.options = opts.map(o => ({ ...o, proposal: o.proposal ? normalizeProposal(getState(), o.proposal) : undefined })) })
  })
  const choose = (i: number) => {
    const o = q.options[i], val = `${o.title}: ${o.detail}`
    if (q.answer === val) return edit(x => { x.answer = '' })
    tx('Decide', () => { edit(x => { x.answer = val }); if (o.proposal && !isApplied(getState(), o.proposal)) applyProposal(o.proposal) })
  }
  const writeIn = () => job.run('Working out what changes…', async sig => {
    const out = await completeJSON<Proposal[]>('assist', resolveQuestion(getState(), get(getState(), q.id, 'question')!), sig)
    setProps(out.map(p => normalizeProposal(getState(), p)))
    if (!out.length) job.setErr('Nothing to change: the canon already says this.')
  })
  const kind = QKINDS.find(k => k.id === q.type)!
  const resolved = !!q.answer
  return (
    <div className={'card q-card ' + q.type + (q.dismissed ? ' done' : resolved ? ' decided' : '')}>
      <div className="row">
        <Popover trigger={o => <button className="kicker" style={{ border: 0, background: 'none', padding: 0 }} title="Change the kind" onClick={o}>{resolved ? `${kind.label} · decided` : kind.label}{q.by !== 'you' ? ` · from ${q.by === 'ai' ? 'the assistant' : 'a check'}` : ''}</button>}>
          {close => <>{QKINDS.map(k => <button key={k.id} className={'menu-item' + (k.id === q.type ? ' on' : '')} onClick={() => { edit(x => { x.type = k.id }); close() }}>{k.label}</button>)}</>}
        </Popover>
        <span className="grow" />
        {q.dismissed ? <button className="btn sm ghost" onClick={() => edit(x => { x.dismissed = false })}>Reopen</button>
          : !resolved && <button className="btn sm ghost" title="Not a real problem" onClick={() => tx('Dismiss question', () => edit(x => { x.dismissed = true }))}>Dismiss</button>}
        <button className="x hover-only" aria-label="Delete" title="Delete" onClick={() => tx('Delete question', () => remove(q.id))}>×</button>
      </div>
      <textarea className="inline" value={q.text} placeholder="What's unresolved?" autoFocus={!q.text} aria-label="Question"
        onChange={e => edit(x => { x.text = e.target.value })} />
      {!compact && <div className="row" style={{ gap: 4 }}>
        {q.about.map(id => <span key={id} className="chip"><a href={'#' + hrefOf(s, id)} style={{ textDecoration: 'none' }}>{nameOf(s, id) || 'Missing'}</a>
          <button className="x" style={{ fontSize: 13, padding: 0 }} aria-label="Detach" onClick={() => edit(x => { x.about = x.about.filter(y => y !== id) })}>×</button></span>)}
        <RecordPicker s={s} label={q.about.length ? '+' : '+ About…'} exclude={q.about} onPick={id => edit(x => { x.about.push(id) })} />
      </div>}
      {q.options.map((o, i) => (
        <button key={i} className={'opt' + (q.answer === `${o.title}: ${o.detail}` ? ' on' : '')} onClick={() => choose(i)}>
          <b>{o.title}</b><span>{o.detail}</span>{o.proposal && <span className="ai-text small">Writes it into the canon</span>}
        </button>
      ))}
      {!q.dismissed && <Area value={q.answer} placeholder="Your decision: pick an option or write your own" onChange={v => edit(x => { x.answer = v })} />}
      <JobStatus job={job} />
      <Proposals s={s} items={props} onChange={setProps} label="Write it into the canon" />
      {!q.dismissed && <div className="row">
        <button className="btn sm soft" disabled={!!job.busy || !q.text.trim()} onClick={suggest}>✦ {q.options.length ? 'Other options' : 'Suggest options'}</button>
        {resolved && <button className="btn sm soft" disabled={!!job.busy} title="Propose the canon changes this decision implies" onClick={writeIn}>✦ Write into the canon</button>}
      </div>}
    </div>
  )
}

/** Ask the assistant for plot holes, contradictions and open questions; they land in the Questions inbox. */
export function FindProblems({ s, focus, label = 'Find problems' }: { s: State; focus?: string; label?: string }) {
  const job = useJob()
  const [found, setFound] = useState<string[]>([])
  const run = () => job.run('Looking for holes and contradictions…', async sig => {
    const out = await completeJSON<FoundQ[]>('assist', findProblems(getState(), focus), sig)
    const ids: string[] = []
    tx(`Raise ${out.length} question${out.length === 1 ? '' : 's'}`, () => {
      for (const f of out) ids.push(create('question', newQuestion({
        type: (['question', 'hole', 'contradiction'] as const).includes(f.kind) ? f.kind : 'question', text: f.text, by: 'ai',
        about: [...new Set([...(f.about || []).filter(id => getState().recs[id]), ...(focus ? [focus] : [])])],
        options: (f.options || []).map(o => ({ title: o.title, detail: o.detail, proposal: o.proposal ? normalizeProposal(getState(), o.proposal) : undefined })),
      })))
    }, false)
    setFound(ids)
    if (!out.length) job.setErr('Nothing found. The canon holds up here.')
  })
  const qs = found.map(id => get(s, id, 'question')).filter(Boolean) as Question[]
  return (
    <div className="stack">
      <div className="row"><button className="btn soft" disabled={!!job.busy} onClick={run}>✦ {found.length ? 'Look again' : label}</button>
        {qs.length > 0 && <a className="small muted" href="#questions">All questions</a>}</div>
      <JobStatus job={job} />
      {qs.map(q => <QuestionCard key={q.id} s={s} q={q} compact />)}
    </div>
  )
}

/** Versions of one record from the server history, with restore. */
export function History({ id, render }: { id: string; render?: (prev: Record<string, unknown>) => ReactNode }) {
  const [vs, setVs] = useState<{ seq: number; label: string; at: number; prev: Record<string, unknown> | null }[]>()
  const [open, setOpen] = useState<number>()
  useEffect(() => { fetch('/api/history?record=' + encodeURIComponent(id)).then(r => r.json()).then(setVs) }, [id])
  if (!vs) return <p className="muted small">Loading…</p>
  if (!vs.length) return <p className="muted small">No history yet. Every change is kept from now on.</p>
  const restore = (prev: Record<string, unknown>) => tx('Restore version', () => update(id, d => {
    const rec = d as unknown as Record<string, unknown>
    for (const k of Object.keys(rec)) if (k !== 'id' && k !== 'kind') delete rec[k]
    Object.assign(rec, prev)
  }))
  return (
    <div className="stack" style={{ gap: 6 }}>
      {vs.map(v => (
        <div key={v.seq} className="card" style={{ padding: 10, gap: 6 }}>
          <div className="row"><b>{v.label || 'Edit'}</b><span className="grow" /><span className="small muted">{new Date(v.at).toLocaleString()}</span></div>
          {v.prev ? <div className="row">
            <button className="btn sm ghost" onClick={() => setOpen(open === v.seq ? undefined : v.seq)}>{open === v.seq ? 'Hide' : 'Show before'}</button>
            <button className="btn sm" onClick={() => restore(v.prev!)}>Restore the version before this</button>
          </div> : <span className="small muted">Created</span>}
          {open === v.seq && v.prev && (render ? render(v.prev) : <pre className="pre small mono" style={{ margin: 0, maxHeight: 240, overflow: 'auto' }}>{JSON.stringify(v.prev, null, 2)}</pre>)}
        </div>
      ))}
    </div>
  )
}

/** A persisted conversation (chat record): log, streaming reply, composer. */
export function ChatPane({ s, chatId, system, proposals, placeholder, empty, persona, queued, onQueued, starters, autoFocus = true, footer }: {
  s: State; chatId: string; system: () => string; proposals?: boolean; placeholder: string; empty?: ReactNode; persona?: string; queued?: string; onQueued?: () => void; starters?: string[]; autoFocus?: boolean; footer?: ReactNode
}) {
  const chat = get(s, chatId, 'chat')
  const job = useJob()
  const [draft, setDraft] = useState('')
  const [live, setLive] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [chat?.messages.length, live])
  const send = (text: string) => {
    if (!text.trim() || job.busy) return
    update<'chat'>(chatId, x => { x.messages.push({ role: 'user', text }); x.at = new Date().toISOString(); if (x.messages.length === 1 && proposals) x.title = text.slice(0, 60) })
    setDraft('')
    job.run(persona ? `${persona} is thinking…` : 'Thinking…', async sig => {
      const msgs = get(getState(), chatId, 'chat')!.messages
      const out = await complete('chat', system(), msgs.map(m => ({ role: m.role, content: m.text })), t => setLive(proposals ? stripProposals(t) : t), sig)
      update<'chat'>(chatId, x => { x.messages.push({ role: 'assistant', text: proposals ? stripProposals(out) : out, proposals: proposals ? parseProposals(getState(), out) : undefined }) })
    }).finally(() => setLive(''))
  }
  useEffect(() => { if (queued) { onQueued?.(); send(queued) } }, [queued]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!chat) return null
  const setProps = (i: number, ps: Proposal[]) => update<'chat'>(chatId, x => { x.messages[i].proposals = ps })
  const reply = (text: string) => (persona ? <div className="msg persona">{text}</div> : <div className="msg"><Md text={text} /></div>)
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="chat">
        {!chat.messages.length && empty}
        {!chat.messages.length && starters && <div className="row" style={{ gap: 6 }}>{starters.map(t => <button key={t} className="chip" onClick={() => send(t)}>{t}</button>)}</div>}
        {chat.messages.map((m, i) => (
          <div key={i} className="stack" style={{ gap: 6 }}>
            {m.role === 'user' ? <div className="msg user">{m.text}</div> : reply(m.text)}
            {m.proposals && <Proposals s={s} items={m.proposals} onChange={ps => setProps(i, ps)} label="Proposed" />}
          </div>
        ))}
        {live && reply(live)}
        <div ref={end} />
      </div>
      <JobStatus job={job} />
      <div className="composer">
        <textarea value={draft} placeholder={placeholder} aria-label="Message" autoFocus={autoFocus} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft) } }} />
        <button className="btn pri sm" disabled={!draft.trim() || !!job.busy} onClick={() => send(draft)}>Send</button>
      </div>
      {footer && <div className="composer-foot">{footer}<span>↵ send · ⇧↵ new line</span></div>}
    </div>
  )
}

export const openCount = (s: State) => list(s, 'question').filter(q => !q.answer && !q.dismissed).length

/** One guide: kind, title, and its text (long texts start collapsed). */
export function GuideRow({ g }: { g: Guide }) {
  const long = g.text.length > 600
  const [open, setOpen] = useState(!long)
  return (
    <div className="guide">
      <div className="row nowrap">
        <select className="f chip-select" value={g.use} aria-label="Kind" onChange={e => update<'guide'>(g.id, x => { x.use = e.target.value as GuideKind })}>{GUIDE_KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
        <input className="inline" style={{ fontWeight: 600 }} value={g.title} aria-label="Guide title" onChange={e => update<'guide'>(g.id, x => { x.title = e.target.value })} />
        {long && <button className="btn sm ghost" onClick={() => setOpen(o => !o)}>{open ? 'Collapse' : `Show · ${g.text.length.toLocaleString()} characters`}</button>}
        <button className="x" aria-label="Delete guide" title="Delete guide" onClick={() => tx(`Delete guide “${g.title}”`, () => remove(g.id))}>×</button>
      </div>
      {open && <textarea className={'f' + (long ? ' mono-area' : '')} value={g.text} aria-label="Guide text"
        placeholder={g.use === 'banned' ? 'One phrase per line' : g.use === 'rule' ? 'One short instruction' : 'How to write within this scope'} onChange={e => update<'guide'>(g.id, x => { x.text = e.target.value })} />}
    </div>
  )
}
