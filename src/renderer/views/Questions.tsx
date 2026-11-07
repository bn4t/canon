import { useEffect, useMemo, useState } from 'react'
import {
  create, update, remove, tx, list, get, getState, applyProposal, isApplied, newQuestion, QKINDS,
  type State, type QKind, type Question, type Proposal,
} from '../store.ts'
import { completeJSON } from '../ai.ts'
import { questionOptions, resolveQuestion, normalizeProposal } from '../prompts.ts'
import { Bar, Popover, Icon, Empty, Diff, JobStatus, useJob, changeRows, go, replaceRoute, ago } from '../ui.tsx'
import { diffWords } from '../diff.ts'
import { RecordPicker, AIButton, findProblemsInto, hrefOf, shortName, sourceOf, kindLabel } from './shared.tsx'
import './questions.css'

type Show = 'open' | 'decided' | 'dismissed'
const statusOf = (q: Question): Show => (q.dismissed ? 'dismissed' : q.answer ? 'decided' : 'open')
const SHOW: { id: Show; label: string }[] = [{ id: 'open', label: 'Open' }, { id: 'decided', label: 'Decided' }, { id: 'dismissed', label: 'Dismissed' }]
const optionText = (o: Question['options'][number]) => `${o.title}: ${o.detail}`

function raise(type: QKind) {
  let id = ''
  tx('New question', () => { id = create('question', newQuestion({ type })) }, false)
  go('questions/' + id)
}

export function QuestionsView({ s, focus }: { s: State; focus?: string }) {
  const all = list(s, 'question').sort((a, b) => b.at.localeCompare(a.at))
  const [kind, setKind] = useState<QKind | ''>('')
  const [show, setShow] = useState<Show>('open')
  // Questions decided or dismissed during this visit stay in the list, so deciding one doesn't make it vanish.
  const [seen] = useState(() => new Set(all.filter(q => statusOf(q) === 'open').map(q => q.id)))
  const job = useJob()
  const focused = get(s, focus, 'question')
  useEffect(() => { if (focused && statusOf(focused) !== show && !(show === 'open' && seen.has(focused.id))) setShow(statusOf(focused)) }, [focus]) // eslint-disable-line react-hooks/exhaustive-deps
  const ofKind = all.filter(q => !kind || q.type === kind)
  const shown = ofKind.filter(q => statusOf(q) === show || (show === 'open' && seen.has(q.id)))
  const cur = focused || shown[0]
  useEffect(() => { if (!focus && cur) replaceRoute('questions/' + cur.id) }, [focus, cur?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const count = (v: Show) => ofKind.filter(q => statusOf(q) === v).length
  const next = shown.find(q => q.id !== cur?.id && statusOf(q) === 'open')
  return (
    <>
      <Bar>
        <div className="grow" style={{ fontWeight: 500 }}>Questions</div>
        <AIButton label="Find problems" busy={job.busy} title="Plot holes, contradictions and open questions across the canon" onClick={() => job.run('Looking for problems…', sig => findProblemsInto(undefined, sig).then(() => {}))} />
        <button className="btn sm" onClick={() => raise(kind || 'question')}><Icon name="plus" size={14} />Question</button>
        <span className="bar-sep" />
      </Bar>
      {!all.length ? <Empty title="No questions yet">
        <p>This is where the canon gets refined. Raise what you haven’t decided yet, or let the assistant look for plot holes and contradictions. For each one you pick an answer, see what it changes in the canon, then apply it.</p>
        <div className="row"><button className="btn pri" onClick={() => raise('question')}>Raise a question</button><AIButton label="Find problems" className="btn soft" busy={job.busy} onClick={() => job.run('Looking for problems…', sig => findProblemsInto(undefined, sig).then(() => {}))} /></div>
        <JobStatus job={job} />
      </Empty> : (
        <div className="qs-page">
          <nav className="qs-list" aria-label="Questions">
            <div className="qs-lh">
              <div className="seg">{SHOW.map(v => <button key={v.id} className={show === v.id ? 'on' : ''} onClick={() => { setShow(v.id); replaceRoute('questions') }}>{v.label}{count(v.id) ? ` ${count(v.id)}` : ''}</button>)}</div>
              <span className="grow" />
              <Popover className="right" trigger={o => <button className="chip" onClick={o}>{kind ? QKINDS.find(k => k.id === kind)!.many : 'All kinds'}<Icon name="down" size={12} /></button>}>
                {c => <>{[{ id: '' as const, many: 'All kinds' }, ...QKINDS].map(k => <button key={k.id} className={'menu-item' + (kind === k.id ? ' on' : '')} onClick={() => { setKind(k.id); c() }}>{k.many}</button>)}</>}
              </Popover>
            </div>
            {job.err && <div style={{ padding: '0 16px 10px' }}><JobStatus job={job} /></div>}
            {shown.map(q => (
              <a key={q.id} href={'#questions/' + q.id} className={'qs-item' + (q.id === cur?.id ? ' on' : '') + (statusOf(q) !== show ? ' done' : '')}>
                <span className="row nowrap" style={{ gap: 8 }}><span className={'tag ' + q.type}>{kindLabel(q)}</span>
                  <span className="lbl" style={{ fontWeight: 400 }}>{statusOf(q) !== 'open' ? (statusOf(q) === 'decided' ? 'Decided' : 'Dismissed') : `${sourceOf(q)} · ${ago(q.at)}`}</span></span>
                <p>{q.text || <span className="faint">Untitled question</span>}</p>
                {q.about.length > 0 && <span className="row" style={{ gap: 4 }}>{q.about.slice(0, 4).map(id => <span key={id} className="chip">{shortName(s, id)}</span>)}</span>}
              </a>
            ))}
            {!shown.length && <p className="qs-none">{show === 'open' ? 'Nothing open. The canon holds up for now.' : `Nothing ${show} yet.`}</p>}
          </nav>
          {cur ? <Detail key={cur.id} s={s} q={cur} next={next} /> : <div className="qs-det"><Empty title="Pick a question"><p>Choose one from the list to decide it.</p></Empty></div>}
        </div>
      )}
    </>
  )
}

// ---------------- one question: pick an answer → see what changes → apply ----------------

type Choice = number | 'own' | undefined

function Detail({ s, q, next }: { s: State; q: Question; next?: Question }) {
  const st = statusOf(q)
  const edit = (fn: (x: Question) => void) => update<'question'>(q.id, fn)
  const src = sourceOf(q)
  return (
    <section className="qs-det" aria-label="Question">
      <div className="row nowrap">
        <span className={'tag ' + q.type}>{kindLabel(q)}</span>
        <span className="lbl grow" style={{ fontWeight: 400 }}>Raised by {src === 'you' ? 'you' : 'the ' + src} · {ago(q.at)}</span>
        <Popover className="right" trigger={o => <button className="icon-btn" aria-label="More" title="More" onClick={o}><Icon name="more" /></button>}>
          {c => <>
            <span className="lbl" style={{ padding: '6px 10px 2px' }}>Kind</span>
            {QKINDS.map(k => <button key={k.id} className={'menu-item' + (k.id === q.type ? ' on' : '')} onClick={() => { c(); tx(`Mark as ${k.label.toLowerCase()}`, () => edit(x => { x.type = k.id }), false) }}>{k.label}{k.id === q.type && <><span className="grow" /><Icon name="check" size={14} /></>}</button>)}
            <div className="menu-sep" />
            {st !== 'open' && <button className="menu-item" onClick={() => { c(); tx('Reopen question', () => edit(x => { x.answer = ''; x.dismissed = false })) }}>Reopen</button>}
            <button className="menu-item danger" onClick={() => { c(); tx('Delete question', () => remove(q.id)); go('questions') }}>Delete question</button>
          </>}
        </Popover>
      </div>
      <textarea className="inline qs-q" value={q.text} placeholder="What’s unresolved?" autoFocus={!q.text} aria-label="Question" onChange={e => edit(x => { x.text = e.target.value })} />
      <div className="row" style={{ gap: 4 }}>
        <span className="lbl" style={{ marginRight: 4 }}>About</span>
        {q.about.map(id => <span key={id} className="chip"><a href={'#' + hrefOf(s, id)}>{get(s, id, 'fact') ? `${shortName(s, id)} ${get(s, id, 'fact')!.text}` : shortName(s, id)}</a>
          <button className="x" style={{ fontSize: 13, padding: 0 }} aria-label="Detach" onClick={() => edit(x => { x.about = x.about.filter(y => y !== id) })}>×</button></span>)}
        <RecordPicker s={s} label={q.about.length ? '+' : '+ Link a record'} exclude={q.about} onPick={id => edit(x => { x.about.push(id) })} />
      </div>
      {st === 'open' ? <Decide s={s} q={q} /> : (
        <div className="qs-done">
          <span className="lbl">{st === 'decided' ? 'Decided' : 'Dismissed: not a real problem'}</span>
          {st === 'decided' && <textarea className="inline" value={q.answer} aria-label="Answer" onChange={e => edit(x => { x.answer = e.target.value })} />}
          <div className="row">
            <button className="btn sm" onClick={() => tx('Reopen question', () => edit(x => { x.answer = ''; x.dismissed = false }))}>Reopen</button>
            {next && <a className="btn sm ghost" href={'#questions/' + next.id}>Next open question<Icon name="right" size={12} /></a>}
          </div>
        </div>
      )}
    </section>
  )
}

function Decide({ s, q }: { s: State; q: Question }) {
  const job = useJob()
  const matched = q.options.findIndex(o => optionText(o) === q.answer)
  const [choice, setChoice] = useState<Choice>(matched >= 0 ? matched : q.answer ? 'own' : undefined)
  const [own, setOwn] = useState(matched < 0 ? q.answer : '')
  const [worked, setWorked] = useState<{ for: string; items: Proposal[] }>()
  const [off, setOff] = useState<Set<string>>(new Set())
  const key = (p: Proposal) => JSON.stringify(p)
  const answer = choice === 'own' ? own.trim() : choice !== undefined ? optionText(q.options[choice]) : ''
  const opt = typeof choice === 'number' ? q.options[choice] : undefined
  const items = useMemo(() => [...(opt?.proposal ? [opt.proposal] : []), ...(worked && worked.for === answer ? worked.items : [])], [opt, worked, answer])
  const picked = items.filter(p => !off.has(key(p)) && !isApplied(s, p))
  const pick = (c: Choice) => { setChoice(c); setOff(new Set()) }
  const suggest = () => job.run('Thinking of answers…', async sig => {
    const out = await completeJSON<Question['options']>('assist', questionOptions(getState(), q), sig)
    tx('Suggest answers', () => update<'question'>(q.id, x => { x.options = [...x.options, ...out.map(o => ({ ...o, proposal: o.proposal ? normalizeProposal(getState(), o.proposal) : undefined }))] }), false)
  })
  const workOut = () => job.run('Working out what changes…', async sig => {
    const out = await completeJSON<Proposal[]>('assist', resolveQuestion(getState(), { ...get(getState(), q.id, 'question')!, answer }), sig)
    const ps = out.map(p => normalizeProposal(getState(), p)).filter(p => !opt?.proposal || JSON.stringify(p) !== JSON.stringify(opt.proposal))
    setWorked({ for: answer, items: ps })
    if (!ps.length) job.setErr('Nothing else to change: the canon already says this.')
  })
  const decide = (apply: boolean) => {
    const ps = apply ? picked : []
    tx(ps.length ? `Decide and apply ${ps.length} change${ps.length === 1 ? '' : 's'}` : 'Decide', () => {
      ps.forEach(applyProposal)
      update<'question'>(q.id, x => { x.answer = answer; x.dismissed = false })
    })
  }
  const flip = (p: Proposal) => setOff(o => { const n = new Set(o); if (n.has(key(p))) n.delete(key(p)); else n.add(key(p)); return n })
  return (
    <>
      <div className="qs-step"><span className="qs-n">1</span>Pick an answer<span className="grow" />
        <AIButton className="btn sm ghost qs-more" label={q.options.length ? 'Suggest more answers' : 'Suggest answers'} busy={job.busy && job.busy.startsWith('Thinking') ? job.busy : undefined} disabled={!!job.busy || !q.text.trim()} onClick={suggest} />
      </div>
      <div className="qs-opts" role="radiogroup" aria-label="Answers">
        {q.options.map((o, i) => (
          <button key={i} role="radio" aria-checked={choice === i} className={'qs-opt' + (choice === i ? ' on' : '')} onClick={() => pick(i)}>
            <span className="rad" /><span><b>{o.title}</b><span className="d">{o.detail}</span></span>
          </button>
        ))}
        {choice === 'own' ? (
          <div className="qs-opt on own"><span className="rad" />
            <textarea className="inline" autoFocus value={own} placeholder="Your answer: what’s true, and why" aria-label="Your answer" onChange={e => setOwn(e.target.value)} /></div>
        ) : <button className="qs-opt dashed" role="radio" aria-checked={false} onClick={() => pick('own')}><span className="rad" /><span className="d muted">Write your own answer…</span></button>}
      </div>
      {choice !== undefined && <>
        <div className="qs-step"><span className="qs-n">2</span>What changes in the canon{items.length > 0 && <span className="lbl" style={{ fontWeight: 400, marginLeft: 4 }}>untick anything you don’t want</span>}<span className="grow" />
          {answer && <AIButton className="btn sm ghost qs-more" label={items.length ? 'Find more changes' : 'Work out what changes'} busy={job.busy && job.busy.startsWith('Working') ? job.busy : undefined} disabled={!!job.busy} onClick={workOut} />}
        </div>
        <div className="changes-box">
          {items.map((p, i) => {
            const done = isApplied(s, p)
            return (
              <label key={i} className={'change-row' + (done ? ' done' : '')}>
                {done ? <span className="change-done"><Icon name="check" size={12} /></span> : <input type="checkbox" checked={!off.has(key(p))} onChange={() => flip(p)} aria-label="Include this change" />}
                <span className="change-body">
                  {changeRows(s, p).map((r, j) => <span key={j} className="change-one"><span className="lbl">{r.where}</span>
                    <span className="change-text">{r.before?.trim() ? <Diff parts={diffWords(r.before, r.after)} /> : <ins>{r.after}</ins>}</span></span>)}
                  {p.why && <span className="small muted">{p.why}</span>}
                </span>
                {done && <span className="chip ok">Already applied</span>}
              </label>
            )
          })}
          <div className="change-note">{items.length ? 'The question is marked decided, with your answer kept on it.' : 'No changes to the canon yet. Deciding keeps your answer on the question; the assistant can work out what it changes.'}</div>
        </div>
      </>}
      <JobStatus job={job} />
      <div className="qs-act">
        <span className="qs-n off">3</span>
        <button className="btn pri" disabled={!answer} onClick={() => decide(true)}>{picked.length ? `Decide and apply ${picked.length} change${picked.length === 1 ? '' : 's'}` : 'Decide'}</button>
        {picked.length > 0 && <button className="btn ghost" onClick={() => decide(false)}>Decide without changes</button>}
        <span className="grow" />
        <button className="btn ghost" onClick={() => tx('Dismiss question', () => update<'question'>(q.id, x => { x.dismissed = true }))}>Dismiss: not a real problem</button>
      </div>
    </>
  )
}
