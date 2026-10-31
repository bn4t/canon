import { useMemo, useState } from 'react'
import { update, tx, stories, allScenes, sceneRef, pushSnapshot, type State, type Scene } from '../store.ts'
import { PageHead } from '../ui.tsx'
import { findMatches, replaceOne, replaceAll, replacement, type FindOpts, type Match } from '../find.ts'

type Field = 'prose' | 'title' | 'card'
const FIELDS: { id: Field; label: string }[] = [{ id: 'prose', label: 'Text' }, { id: 'title', label: 'Titles' }, { id: 'card', label: 'Synopses' }]

/** Write one field of a scene; prose changes keep a snapshot first. */
function writeField(id: string, field: Field, fn: (t: string) => string) {
  update<'scene'>(id, x => { const next = fn(x[field]); if (next === x[field]) return; if (field === 'prose') pushSnapshot(x); x[field] = next })
}

export function FindView({ s }: { s: State }) {
  const [q, setQ] = useState('')
  const [repl, setRepl] = useState('')
  const [o, setO] = useState<FindOpts>({})
  const [fields, setFields] = useState<Field[]>(['prose'])
  const [story, setStory] = useState('')
  const replacing = repl !== ''

  const { results, err } = useMemo(() => {
    try {
      const out: { sc: Scene; field: Field; ms: Match[] }[] = []
      if (q) for (const sc of allScenes(s)) if (!story || sc.story === story) for (const field of fields) {
        const ms = findMatches(sc[field], q, o)
        if (ms.length) out.push({ sc, field, ms })
      }
      return { results: out, err: '' }
    } catch (e) { return { results: [], err: String(e).replace(/^SyntaxError: /, '') } }
  }, [s, q, o, fields, story])
  const total = results.reduce((n, r) => n + r.ms.length, 0)

  const one = (id: string, field: Field, m: Match) => tx('Replace', () => writeField(id, field, t => (t.slice(m.start, m.end) === m.text ? replaceOne(t, m, q, repl, o) : t)))
  const all = () => tx(`Replace ${total} match${total === 1 ? '' : 'es'}`, () => { for (const r of results) writeField(r.sc.id, r.field, t => replaceAll(t, q, repl, o)) })
  const opt = (k: keyof FindOpts, label: string) => <label className="row nowrap small"><input type="checkbox" checked={!!o[k]} onChange={e => setO({ ...o, [k]: e.target.checked })} />{label}</label>

  return (
    <>
      <PageHead title="Find and replace" sub={q && !err ? `${total} match${total === 1 ? '' : 'es'} in ${new Set(results.map(r => r.sc.id)).size} scenes` : 'Across every scene in the project. Replacing keeps a snapshot of each scene it changes.'} />
      <div className="body narrow">
        <div className="card">
          <div className="grid3">
            <label className="field"><span className="lbl">Find</span><input className="f" autoFocus value={q} onChange={e => setQ(e.target.value)} /></label>
            <label className="field"><span className="lbl">Replace with</span><input className="f" value={repl} placeholder={o.regex ? 'Use $1 for groups' : ''} onChange={e => setRepl(e.target.value)} /></label>
            <label className="field"><span className="lbl">In</span>
              <select className="f" value={story} onChange={e => setStory(e.target.value)}><option value="">The whole project</option>{stories(s).map(st => <option key={st.id} value={st.id}>{st.title}</option>)}</select></label>
          </div>
          <div className="row">
            {opt('matchCase', 'Match case')}{opt('wholeWord', 'Whole word')}{opt('regex', 'Regex')}
            <span className="grow" />
            {FIELDS.map(f => <label key={f.id} className="row nowrap small"><input type="checkbox" checked={fields.includes(f.id)} onChange={() => setFields(fields.includes(f.id) ? fields.filter(x => x !== f.id) : [...fields, f.id])} />{f.label}</label>)}
          </div>
          {err && <div className="err">{err}</div>}
          {replacing && total > 0 && <div className="row"><button className="btn pri" onClick={all}>Replace all {total}</button><span className="small muted">One undo step. Each changed scene keeps a snapshot.</span></div>}
        </div>
        {results.map(r => (
          <div key={r.sc.id + r.field} className="card" style={{ gap: 6 }}>
            <div className="row"><a href={`#write/${r.sc.story}/${r.sc.id}`} style={{ textDecoration: 'none' }}><span className="mono muted">{sceneRef(s, r.sc)}</span> <b>{r.sc.title}</b></a>
              {r.field !== 'prose' && <span className="chip">{FIELDS.find(f => f.id === r.field)!.label}</span>}<span className="grow" /><span className="small muted">{r.ms.length}</span></div>
            {r.ms.slice(0, 50).map((m, i) => {
              const t = r.sc[r.field]
              return (
                <div key={i} className="row nowrap" style={{ alignItems: 'start' }}>
                  <span className="review grow" style={{ fontSize: 14, lineHeight: 1.55 }}>
                    {m.start > 60 && '…'}{t.slice(Math.max(0, m.start - 60), m.start)}
                    {replacing ? <><del>{m.text}</del><ins>{replacement(m, q, repl, o)}</ins></> : <ins>{m.text}</ins>}
                    {t.slice(m.end, m.end + 60)}{m.end + 60 < t.length && '…'}
                  </span>
                  {replacing && <button className="btn sm" onClick={() => one(r.sc.id, r.field, m)}>Replace</button>}
                </div>
              )
            })}
            {r.ms.length > 50 && <p className="small muted">{r.ms.length - 50} more in this scene.</p>}
          </div>
        ))}
        {!q && <div className="empty" style={{ paddingTop: 40 }}><p>Search the text of every scene, or turn on Titles and Synopses to rename a character everywhere at once. Replace one match at a time, or all of them in one step you can undo.</p></div>}
        {q && !err && !total && <div className="empty"><h2>No matches</h2><p>Try fewer words, or turn off Match case and Whole word.</p></div>}
      </div>
    </>
  )
}
