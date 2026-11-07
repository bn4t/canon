// Find and replace (#find, ⇧⌘F; ⌘F outside the editor). Searches scene text, titles and cards (replaceable), and, read-only,
// margin notes, World sheets, Research and guides. A search can be kept as a smart collection of the scenes it matches.
import { useMemo, useState } from 'react'
import { update, tx, stories, allScenes, sceneRef, pushSnapshot, list, get, entities, typeDef, uid, researchOf, type State, type Scene } from '../store.ts'
import { PageHead, go, openSettings, stored, store } from '../ui.tsx'
import { findMatches, replaceOne, replaceAll, replacement, type FindOpts, type Match } from '../find.ts'
import './find.css'

type Field = 'prose' | 'title' | 'card'
type Scope = Field | 'notes' | 'world' | 'research' | 'guides'
const SCOPES: { id: Scope; label: string }[] = [
  { id: 'prose', label: 'Scene text' }, { id: 'title', label: 'Titles' }, { id: 'card', label: 'Cards' },
  { id: 'notes', label: 'Margin notes' }, { id: 'world', label: 'World sheets' }, { id: 'research', label: 'Research' }, { id: 'guides', label: 'Guides' },
]
const EDITABLE: Scope[] = ['prose', 'title', 'card']
const LABEL: Record<Field, string> = { prose: 'Text', title: 'Title', card: 'Card' }

/** Write one field of a scene; prose changes keep a snapshot first. */
function writeField(id: string, field: Field, fn: (t: string) => string) {
  update<'scene'>(id, x => { const next = fn(x[field]); if (next === x[field]) return; if (field === 'prose') pushSnapshot(x); x[field] = next })
}
/** A read-only hit: where it is, which part matched, the text and its matches. */
interface Hit { key: string; group: string; title: string; where: string; href?: string; open?: () => void; text: string; ms: Match[] }

/** Everything outside the scenes that can be searched (read-only). */
function others(s: State, scopes: Scope[], story: string): Omit<Hit, 'ms'>[] {
  const out: Omit<Hit, 'ms'>[] = []
  if (scopes.includes('notes')) for (const n of list(s, 'note')) {
    const sc = get(s, n.scene, 'scene')
    if (!sc || (story && sc.story !== story)) continue
    out.push({ key: n.id, group: 'Margin notes', title: sc.title || 'Untitled scene', where: sceneRef(s, sc), href: '#scene/' + sc.id, text: n.text })
  }
  if (scopes.includes('world')) for (const e of entities(s)) {
    const def = typeDef(s, e.type), at = { title: e.name, href: '#world/' + e.id, group: 'World sheets' }
    out.push({ ...at, key: e.id + ':name', where: 'Name', text: [e.name, ...e.aliases].join(' · ') }, { ...at, key: e.id + ':summary', where: def.one, text: e.summary })
    for (const [k, v] of Object.entries(e.fields)) if (v) out.push({ ...at, key: e.id + ':' + k, where: def.fields.find(f => f.key === k)?.label || k, text: v })
    if (e.notes) out.push({ ...at, key: e.id + ':notes', where: 'Notes', text: e.notes })
  }
  if (scopes.includes('research')) for (const r of researchOf(s)) {
    const at = { title: r.title || 'Untitled', href: '#research/' + r.id, group: 'Research' }
    out.push({ ...at, key: r.id + ':title', where: 'Title', text: r.title }, { ...at, key: r.id + ':text', where: r.type === 'note' ? 'Note' : 'Your notes', text: r.text })
    if (r.clip) out.push({ ...at, key: r.id + ':clip', where: 'Page text', text: r.clip })
  }
  if (scopes.includes('guides')) for (const g of list(s, 'guide')) out.push({ key: g.id, group: 'Guides', title: g.title || 'Untitled guide', where: 'Guide', open: () => openSettings('guides'), text: g.text })
  return out
}

/** A match in context, on one line: 60 characters either side, with paragraph breaks folded to spaces. */
const flat = (t: string) => t.replace(/\s*\n\s*/g, ' ')
const snip = (t: string, m: Match, inner: React.ReactNode) => <>{m.start > 60 && '…'}{flat(t.slice(Math.max(0, m.start - 60), m.start))}{inner}{flat(t.slice(m.end, m.end + 60))}{m.end + 60 < t.length && '…'}</>

export function FindView({ s }: { s: State }) {
  const [q, setQ] = useState('')
  const [repl, setRepl] = useState('')
  const [o, setO] = useState<FindOpts>({})
  const [scopes, setScopesRaw] = useState<Scope[]>(() => stored('canon.find.scopes', 'prose').split(',').filter(x => SCOPES.some(y => y.id === x)) as Scope[])
  const setScopes = (xs: Scope[]) => { setScopesRaw(xs); store('canon.find.scopes', xs.join(',')) }
  const [story, setStory] = useState('')
  const replacing = repl !== ''
  const fields = scopes.filter((x): x is Field => EDITABLE.includes(x))

  const { results, hits, err } = useMemo(() => {
    try {
      const out: { sc: Scene; field: Field; ms: Match[] }[] = []
      if (q) for (const sc of allScenes(s)) if (!story || sc.story === story) for (const field of fields) {
        const ms = findMatches(sc[field], q, o)
        if (ms.length) out.push({ sc, field, ms })
      }
      const hs: Hit[] = q ? others(s, scopes, story).map(h => ({ ...h, ms: findMatches(h.text, q, o) })).filter(h => h.ms.length) : []
      return { results: out, hits: hs, err: '' }
    } catch (e) { return { results: [], hits: [], err: String(e).replace(/^SyntaxError: /, '') } }
  }, [s, q, o, scopes, story]) // eslint-disable-line react-hooks/exhaustive-deps
  const total = results.reduce((n, r) => n + r.ms.length, 0)
  const elsewhere = hits.reduce((n, r) => n + r.ms.length, 0)
  const groups = [...new Set(hits.map(h => h.group))]

  const one = (id: string, field: Field, m: Match) => tx('Replace', () => writeField(id, field, t => (t.slice(m.start, m.end) === m.text ? replaceOne(t, m, q, repl, o) : t)))
  const all = () => tx(`Replace ${total} match${total === 1 ? '' : 'es'}`, () => { for (const r of results) writeField(r.sc.id, r.field, t => replaceAll(t, q, repl, o)) })
  /** Keep the search as a smart collection: the scenes whose title, card or text contains it, updating as you write. */
  const keep = () => {
    const id = uid('col')
    tx(`New collection “${q.trim()}”`, () => update<'project'>('project', x => { x.collections = [...(x.collections || []), { id, name: `“${q.trim()}”`, filter: { q: q.trim(), ...(story ? { story } : {}) } }] }))
    go('collection/' + id)
  }
  const opt = (k: keyof FindOpts, label: string) => <label className="row nowrap small"><input type="checkbox" checked={!!o[k]} onChange={e => setO({ ...o, [k]: e.target.checked })} />{label}</label>
  const scenesHit = new Set(results.map(r => r.sc.id)).size
  const sub = !q || err ? 'Across the whole project. Replacing changes scene text, titles and cards, and keeps a snapshot of each scene it changes.'
    : [total ? `${total} match${total === 1 ? '' : 'es'} in ${scenesHit} scene${scenesHit === 1 ? '' : 's'}` : '', elsewhere ? `${elsewhere} elsewhere` : ''].filter(Boolean).join(' · ') || 'No matches'

  return (
    <>
      <PageHead title="Find and replace" sub={sub} />
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
            {q.trim() && <button className="btn sm ghost" disabled={!!o.regex} title={o.regex ? 'Collections match plain text, not regular expressions' : 'A collection of the scenes whose title, card or text contains this. It updates as you write.'} onClick={keep}>Save as collection</button>}
          </div>
          <div className="row find-scopes" role="group" aria-label="Search in">
            <span className="lbl">Search in</span>
            {SCOPES.map(f => <button key={f.id} className={'chip' + (scopes.includes(f.id) ? ' on' : '')} aria-pressed={scopes.includes(f.id)}
              onClick={() => setScopes(scopes.includes(f.id) ? scopes.filter(x => x !== f.id) : [...scopes, f.id])}>{f.label}</button>)}
          </div>
          {err && <div className="err">{err}</div>}
          {replacing && total > 0 && <div className="row"><button className="btn pri" onClick={all}>Replace all {total}</button><span className="small muted">One undo step. Each changed scene keeps a snapshot.</span></div>}
          {replacing && elsewhere > 0 && <p className="small muted">Replace changes scene text, titles and cards only. Matches in {groups.join(', ').toLowerCase()} are shown here but stay as they are.</p>}
        </div>
        {results.length > 0 && hits.length > 0 && <div className="lbl find-grp">Scenes</div>}
        {results.map(r => (
          <div key={r.sc.id + r.field} className="card" style={{ gap: 6 }}>
            <div className="row"><a href={'#scene/' + r.sc.id} style={{ textDecoration: 'none' }}><span className="mono muted">{sceneRef(s, r.sc)}</span> <b>{r.sc.title}</b></a>
              {r.field !== 'prose' && <span className="chip">{LABEL[r.field]}</span>}<span className="grow" /><span className="small muted">{r.ms.length}</span></div>
            {r.ms.slice(0, 50).map((m, i) => (
              <div key={i} className="row nowrap" style={{ alignItems: 'start' }}>
                <span className="review grow" style={{ fontSize: 14, lineHeight: 1.55 }}>
                  {snip(r.sc[r.field], m, replacing ? <><del>{m.text}</del><ins>{replacement(m, q, repl, o)}</ins></> : <ins>{m.text}</ins>)}
                </span>
                {replacing && <button className="btn sm" onClick={() => one(r.sc.id, r.field, m)}>Replace</button>}
              </div>
            ))}
            {r.ms.length > 50 && <p className="small muted">{r.ms.length - 50} more in this scene.</p>}
          </div>
        ))}
        {groups.map(g => <div key={g} className="stack" style={{ gap: 8 }}>
          <div className="lbl find-grp">{g}</div>
          {hits.filter(h => h.group === g).map(h => (
            <div key={h.key} className="card find-hit" style={{ gap: 6 }}>
              <div className="row">{h.href ? <a href={h.href} style={{ textDecoration: 'none' }}><b>{h.title}</b></a> : <button className="link" style={{ color: 'inherit', textDecoration: 'none' }} onClick={h.open}><b>{h.title}</b></button>}
                <span className="chip">{h.where}</span><span className="grow" /><span className="small muted">{h.ms.length}</span></div>
              {h.ms.slice(0, 5).map((m, i) => <span key={i} className="review" style={{ fontSize: 14, lineHeight: 1.55 }}>{snip(h.text, m, <ins>{m.text}</ins>)}</span>)}
              {h.ms.length > 5 && <p className="small muted">{h.ms.length - 5} more here.</p>}
            </div>
          ))}
        </div>)}
        {!q && <div className="empty" style={{ paddingTop: 40 }}><p>Search the text of every scene, or add titles and cards to rename a character everywhere at once. Notes, sheets, research and guides can be searched too. Replace one match at a time, or all of them in one step you can undo.</p></div>}
        {q && !err && !total && !elsewhere && <div className="empty"><h2>No matches</h2><p>{scopes.length < SCOPES.length ? 'Search in more places, or try fewer words.' : 'Try fewer words, or turn off Match case and Whole word.'}</p></div>}
      </div>
    </>
  )
}
