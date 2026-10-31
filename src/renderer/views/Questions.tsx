import { useEffect, useState } from 'react'
import { create, tx, list, newQuestion, QKINDS, type State, type QKind, type Question } from '../store.ts'
import { PageHead } from '../ui.tsx'
import { QuestionCard, FindProblems } from './shared.tsx'

type Show = 'open' | 'decided' | 'dismissed'
const statusOf = (q: Question): Show => (q.dismissed ? 'dismissed' : q.answer ? 'decided' : 'open')

export function QuestionsView({ s, focus }: { s: State; focus?: string }) {
  const qs = list(s, 'question').sort((a, b) => b.at.localeCompare(a.at))
  const [kind, setKind] = useState<QKind | ''>('')
  const [show, setShow] = useState<Show>('open')
  // Cards decided or dismissed during this visit stay put, so answering one doesn't make it vanish.
  const [seen] = useState(() => new Set(qs.filter(q => statusOf(q) === 'open').map(q => q.id)))
  useEffect(() => { if (focus) document.getElementById('q-' + focus)?.scrollIntoView({ block: 'center' }) }, [focus])
  const ofKind = qs.filter(q => !kind || q.type === kind)
  const shown = ofKind.filter(q => statusOf(q) === show || q.id === focus || (show === 'open' && seen.has(q.id)))
  const count = (k: QKind | '') => qs.filter(q => (!k || q.type === k) && statusOf(q) === 'open').length
  const raise = () => tx('Raise a question', () => { seen.add(create('question', newQuestion({ type: kind || 'question' }))) }, false)
  return (
    <>
      <PageHead title="Questions" sub="Open questions, plot holes and contradictions. Decide one and the assistant writes it into the canon.">
        <button className="btn" onClick={raise}>+ Raise a question</button>
      </PageHead>
      <div className="body">
        <div className="row">
          <div className="seg">
            <button className={kind === '' ? 'on' : ''} onClick={() => setKind('')}>All · {count('')}</button>
            {QKINDS.map(k => <button key={k.id} className={kind === k.id ? 'on' : ''} onClick={() => setKind(k.id)}>{k.many} · {count(k.id)}</button>)}
          </div>
          <div className="seg">
            {(['open', 'decided', 'dismissed'] as Show[]).map(v => <button key={v} className={show === v ? 'on' : ''} onClick={() => setShow(v)}>{v[0].toUpperCase() + v.slice(1)} · {ofKind.filter(q => statusOf(q) === v).length}</button>)}
          </div>
        </div>
        {show === 'open' && <FindProblems s={s} label="Find plot holes and contradictions" />}
        {shown.length ? <div className="qgrid">
          {[...shown].sort((a, b) => Number(statusOf(a) !== 'open') - Number(statusOf(b) !== 'open')).map(q => (
            <div key={q.id} id={'q-' + q.id} style={q.id === focus ? { outline: '2px solid var(--accent)', outlineOffset: 3, borderRadius: 12 } : undefined}><QuestionCard s={s} q={q} /></div>
          ))}
        </div> : <div className="empty">
          <h2>{qs.length ? `Nothing ${show}` : 'No questions yet'}</h2>
          <p>This is where the canon gets refined. Raise what you haven’t decided, or let the assistant look for plot holes and contradictions. Each one gets options; pick one, and the assistant proposes the changes that write it into the canon.</p>
          <button className="btn" onClick={raise}>Raise a question</button>
        </div>}
      </div>
    </>
  )
}
