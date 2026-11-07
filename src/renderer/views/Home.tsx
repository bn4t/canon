import { useEffect, useMemo, useState } from 'react'
import {
  project, stories, scenesOf, allScenes, list, get, nameOf, words, totalWords, sessionWords, today, openQuestions, undoRedo, STATUSES, QKINDS,
  type State, type Scene, type SceneStatus,
} from '../store.ts'
import { useAI, aiReady } from '../ai.ts'
import { Bar, Icon, Spark, ago, openSettings, stored } from '../ui.tsx'
import { newStory, addScene } from '../scenes.ts'
import { hrefOf } from './shared.tsx'
import './home.css'

/** The scene last opened in the editor (remembered per machine, display only). */
export const lastScene = (s: State): { sc?: Scene; at?: number } => {
  try {
    const l = JSON.parse(stored('canon.last', '{}')) as { id?: string; at?: number }
    const sc = get(s, l.id, 'scene')
    if (sc) return { sc, at: l.at }
  } catch { /* ignore */ }
  const all = allScenes(s)
  return { sc: all.find(x => x.prose.trim() && x.status !== 'final') || all.find(x => x.prose.trim()) || all[0] }
}

const STATUS_COLOR: Record<SceneStatus, string> = { final: 'var(--l-green)', revised: 'var(--l-blue)', draft: 'var(--l-yellow)', todo: 'var(--line2)' }
const STATUS_WORD: Record<SceneStatus, string> = { final: 'final', revised: 'revised', draft: 'drafted', todo: 'to do' }
const days = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 864e5)

export function HomeView({ s }: { s: State }) {
  const p = project(s)
  return (
    <>
      <Bar><div className="grow bar-title-text">Home</div></Bar>
      <div className="home">
        <div>
          <h1>{p.title || 'Untitled project'}</h1>
          {p.logline ? <p className="home-log">{p.logline}</p> : <button className="link home-log-add" onClick={() => openSettings('details')}>Add a logline: the whole project in one sentence</button>}
        </div>
        <div className="home-g2">
          <PickUp s={s} />
          <Today s={s} />
        </div>
        <div className="home-g2">
          <Stories s={s} />
          <NeedsYou s={s} />
        </div>
        <Recent s={s} />
      </div>
    </>
  )
}

function PickUp({ s }: { s: State }) {
  const { sc, at } = lastScene(s)
  if (!sc) {
    const st = stories(s)[0]
    return (
      <section className="home-card">
        <div className="home-ch"><span className="lbl grow">Start writing</span></div>
        <div className="home-big-title">{st ? 'No scenes yet' : 'No stories yet'}</div>
        <p className="muted">{st ? `“${st.title}” is waiting for its first scene.` : 'A project holds one or more stories; each is an ordered run of scenes.'}</p>
        <div className="row">{st ? <><button className="btn pri" onClick={() => addScene(st)}>Write the first scene</button><a className="btn" href={'#story/' + st.id}>Open the outline</a></>
          : <button className="btn pri" onClick={newStory}>New story</button>}</div>
      </section>
    )
  }
  const st = get(s, sc.story, 'story')
  const scs = scenesOf(s, sc.story)
  const w = words(sc.prose)
  const tail = sc.prose.trim().replace(/\s+/g, ' ')
  const excerpt = tail.length > 240 ? '…' + tail.slice(tail.indexOf(' ', tail.length - 240) + 1) : tail
  return (
    <section className="home-card">
      <div className="home-ch"><span className="lbl grow">Pick up where you left off</span>{at && <span className="lbl light">opened {ago(at)}</span>}</div>
      <div>
        <div className="home-big-title">{sc.title || 'Untitled scene'}</div>
        <div className="small muted">{st?.title} · scene {scs.indexOf(sc) + 1} of {scs.length} · {STATUSES.find(x => x.id === (sc.status || 'todo'))?.label} · {w.toLocaleString()}{sc.target ? ` of ${sc.target.toLocaleString()}` : ''} words</div>
      </div>
      {excerpt ? <p className="home-ex">{excerpt}</p> : sc.card ? <p className="home-ex muted">{sc.card}</p> : null}
      <div className="row"><a className="btn pri" href={'#scene/' + sc.id}>{w ? 'Continue writing' : 'Start writing'}</a>{st && <a className="btn" href={'#story/' + st.id}>Open the outline</a>}</div>
    </section>
  )
}

function Today({ s }: { s: State }) {
  const p = project(s)
  const n = Math.max(0, sessionWords(s)), total = totalWords(s)
  const hist = useMemo(() => {
    const byDate = new Map(list(s, 'day').map(d => [d.date, Math.max(0, d.words - d.start)]))
    return Array.from({ length: 14 }, (_, i) => { const d = new Date(Date.now() - (13 - i) * 864e5).toLocaleDateString('sv'); return { d, n: byDate.get(d) || 0 } })
  }, [s])
  const max = Math.max(1, ...hist.map(h => h.n))
  const left = p.deadline ? days(today(), p.deadline) : undefined
  return (
    <section className="home-card">
      <div className="home-ch"><h2 className="grow">Today</h2>{p.sessionTarget ? <span className="lbl light">goal {p.sessionTarget.toLocaleString()} words</span> : <button className="btn sm ghost" onClick={() => openSettings('goals')}>Set a daily goal</button>}</div>
      <div className="row" style={{ alignItems: 'baseline', gap: 8 }}><span className="home-num">{n.toLocaleString()}</span><span className="muted">{p.sessionTarget ? `/ ${p.sessionTarget.toLocaleString()} words` : n === 1 ? 'word' : 'words'}</span></div>
      {p.sessionTarget ? <div className="home-pb"><i style={{ width: Math.min(100, (n / p.sessionTarget) * 100) + '%' }} /></div> : null}
      <div className="home-spark" aria-label="Words per day, last 14 days">{hist.map((h, i) => <i key={h.d} title={`${h.d}: ${h.n.toLocaleString()} words`} className={i === hist.length - 1 ? 'today' : ''} style={{ height: h.n ? Math.max(6, (h.n / max) * 100) + '%' : '0%' }} />)}</div>
      <div className="row small muted"><span className="grow">Project {total.toLocaleString()}{p.target ? ` / ${p.target.toLocaleString()}` : ''} words</span>
        {left !== undefined && <span>{left < 0 ? `Due date passed ${-left} days ago` : `Due ${new Date(p.deadline!).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${left} days`}</span>}</div>
    </section>
  )
}

function Stories({ s }: { s: State }) {
  const sts = stories(s)
  return (
    <section className="home-card flush">
      <div className="home-ch"><h2 className="grow">Stories</h2><button className="btn sm ghost" onClick={newStory}><Icon name="plus" size={13} />New story</button></div>
      {sts.map(st => {
        const scs = scenesOf(s, st.id)
        const w = scs.reduce((n, sc) => n + words(sc.prose), 0)
        const by = (['final', 'revised', 'draft', 'todo'] as SceneStatus[]).map(k => ({ k, n: scs.filter(x => (x.status || 'todo') === k).length })).filter(x => x.n)
        const cards = scs.filter(x => x.card.trim()).length
        return (
          <a key={st.id} className="home-srow" href={'#story/' + st.id}>
            <div style={{ minWidth: 0 }}>
              <div className="home-stitle clip">{st.title || 'Untitled story'}</div>
              <div className="small muted clip">{st.form === 'documents' ? 'In-world documents' : st.pov ? `POV ${nameOf(s, st.pov)}` : 'No POV set'} · {scs.length ? `${scs.length} scene${scs.length === 1 ? '' : 's'}` : 'no scenes yet'}</div>
            </div>
            <div className="stack" style={{ gap: 5 }}>
              <div className="home-seg">{by.map(x => <span key={x.k} style={{ flex: x.n, background: STATUS_COLOR[x.k] }} />)}</div>
              <span className="small muted home-sline">{!scs.length ? (st.premise.trim() ? 'Premise only' : 'Empty') : by.map(x => `${x.n} ${STATUS_WORD[x.k]}`).join(' · ') + (by.length === 1 && by[0].k === 'todo' && cards === scs.length ? ' · cards written' : '')}</span>
            </div>
            <div className="home-w">{w.toLocaleString()}{st.target ? ` / ${st.target.toLocaleString()}` : ''}</div>
          </a>
        )
      })}
      {!sts.length && <p className="small muted" style={{ paddingTop: 8 }}>No stories yet.</p>}
    </section>
  )
}

const KORDER = { contradiction: 0, hole: 1, question: 2 }
function NeedsYou({ s }: { s: State }) {
  const ai = useAI()
  const qs = openQuestions(s).sort((a, b) => KORDER[a.type] - KORDER[b.type] || b.at.localeCompare(a.at))
  const notes = list(s, 'note').filter(n => !n.done && get(s, n.scene, 'scene'))
  const byScene = [...new Set(notes.map(n => n.scene))].map(id => ({ sc: get(s, id, 'scene')!, ns: notes.filter(n => n.scene === id) }))
  const noCard = allScenes(s).find(sc => !sc.card.trim() && !sc.prose.trim())
  const rows: { href?: string; run?: () => void; ic: string; tone: string; body: React.ReactNode }[] = []
  qs.slice(0, 2).forEach((q, i) => rows.push({ href: '#questions/' + q.id, ic: 'questions', tone: q.type, body: <>
    <span className={'tag ' + q.type}>{QKINDS.find(k => k.id === q.type)?.label}</span>
    <span className="home-need-t">{q.text || 'Untitled question'}{i === 1 && qs.length > 2 && <span className="muted"> +{qs.length - 2} more</span>}</span></> }))
  for (const { sc, ns } of byScene.slice(0, 2)) {
    const kind = ns.every(n => n.by === 'check') ? 'Continuity note' : ns.every(n => n.by === 'ai') ? 'Feedback' : 'Note'
    rows.push({ href: '#scene/' + sc.id, ic: 'comment', tone: '', body: <span>{ns.length > 1 ? `${ns.length} ${kind === 'Feedback' ? 'feedback notes' : kind.toLowerCase() + 's'}` : kind} on <b>{sc.title}</b></span> })
  }
  if (noCard) rows.push({ href: '#story/' + noCard.story, ic: 'card', tone: '', body: <span><b>{noCard.title || 'Untitled scene'}</b> has no scene card</span> })
  if (ai.known && !aiReady(ai)) rows.push({ run: () => openSettings('assistant'), ic: 'spark', tone: 'ai', body: <span>No assistant connected. <span className="ai-text" style={{ fontWeight: 500 }}>Connect one</span></span> })
  return (
    <section className="home-card flush">
      <div className="home-ch"><h2 className="grow">Needs you</h2>{rows.length > 0 && <span className="lbl light">{rows.length}</span>}</div>
      {rows.map((r, i) => {
        const inner = <><span className={'home-ic ' + r.tone}>{r.ic === 'spark' ? <Spark size={13} /> : <Icon name={r.ic} size={14} />}</span><span className="grow" style={{ minWidth: 0 }}>{r.body}</span></>
        return r.href ? <a key={i} className="home-need" href={r.href}>{inner}</a> : <button key={i} className="home-need" onClick={r.run}>{inner}</button>
      })}
      {!rows.length && <p className="small muted" style={{ padding: '10px 0 4px' }}>Nothing needs you right now. Questions, notes and empty cards show up here.</p>}
    </section>
  )
}

interface Step { group: string; label: string; at: number; ids: string[] }
function Recent({ s }: { s: State }) {
  const [steps, setSteps] = useState<Step[]>()
  const [more, setMore] = useState(false)
  useEffect(() => {
    if (s.save !== 'saved') return
    let live = true
    fetch('/api/history?limit=' + (more ? 30 : 5)).then(r => r.json()).then((x: Step[]) => { if (live) setSteps(x) }).catch(() => {})
    return () => { live = false }
  }, [s.save, more, s.recs])
  if (!steps?.length) return null
  const what = (st: Step) => {
    const id = st.ids.find(x => s.recs[x]) || st.ids[0], name = nameOf(s, id)
    const link = id && hrefOf(s, id) ? <a href={'#' + hrefOf(s, id)}><b>{name}</b></a> : name ? <b>{name}</b> : null
    if (!st.label || st.label === 'Edit') return <>Edited {link || 'a record'}{st.ids.length > 1 ? ` and ${st.ids.length - 1} more` : ''}</>
    return <>{st.label}{link && !st.label.includes(name) && <> · {link}</>}</>
  }
  return (
    <section className="home-card flush" style={{ paddingBottom: 10 }}>
      <div className="home-ch"><h2 className="grow">Recent changes</h2><button className="btn sm ghost" onClick={() => setMore(m => !m)}>{more ? 'Show fewer' : 'All history'}</button></div>
      {steps.map((st, i) => (
        <div key={st.group} className="home-rec">
          <span className="grow clip">{what(st)}</span>
          <span className="lbl light">{ago(st.at)}</span>
          {i === 0 ? <button className="btn sm ghost" onClick={() => undoRedo(true)}>Undo</button> : <span className="home-undo-gap" />}
        </div>
      ))}
    </section>
  )
}

