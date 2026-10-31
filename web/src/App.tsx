import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useCanon, project, stories, entities, typeIds, typeDef, allScenes, list, events, nameOf, undoRedo, create, update, tx, clearError, baseline, emptyProject,
  newFact, newQuestion, newEntityData, nextAt, eventCode, removeLegacy, type State,
} from './store.ts'
import { Toast, go, Icon } from './ui.tsx'
import { importCanonFolder, importFiles } from './importer.ts'
import { WriteView, newStory } from './views/Write.tsx'
import { WorldView, TypesView } from './views/World.tsx'
import { TimelineView, KnowledgeView } from './views/Timeline.tsx'
import { QuestionsView } from './views/Questions.tsx'
import { StoryView, CollectionView } from './views/Story.tsx'
import { ProjectView } from './views/Project.tsx'
import { FindView } from './views/Find.tsx'
import { Director } from './views/Director.tsx'
import { openCount } from './views/shared.tsx'

function useRoute() {
  const [h, setH] = useState(location.hash.slice(1))
  useEffect(() => { const f = () => setH(location.hash.slice(1)); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  return h || 'write'
}
const stored = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
const store = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } }

export function App() {
  const s = useCanon()
  const route = useRoute()
  const [palette, setPalette] = useState(false)
  const [director, setDirector] = useState(() => stored('canon.director', '1') === '1')
  const [scratch, setScratch] = useState(false)
  const main = useRef<HTMLElement>(null)
  const [view, a, b] = route.split('/').map(decodeURIComponent)

  useEffect(() => { store('canon.director', director ? '1' : '0') }, [director])
  useEffect(() => { main.current?.scrollTo(0, 0) }, [view, a, b])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const typing = (e.target as Element).closest?.('input, textarea, select, [contenteditable]')
      if (mod && e.key === 'k') { e.preventDefault(); setPalette(p => !p) }
      else if (mod && e.key === 'j') { e.preventDefault(); setDirector(x => !x) }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); go('find') }
      else if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undoRedo(!e.shiftKey) }
    }
    const ask = () => setDirector(true)
    addEventListener('keydown', onKey); addEventListener('canon:ask', ask)
    return () => { removeEventListener('keydown', onKey); removeEventListener('canon:ask', ask) }
  }, [])

  if (!s.loaded) return <div className="empty">Loading…</div>
  if (!s.recs.project) return <Welcome />
  const ask = (q: string) => { setDirector(true); setTimeout(() => dispatchEvent(new CustomEvent('canon:ask', { detail: q })), 50) }
  const missing = <div className="empty"><h2>Not found</h2><p>It may have been deleted, or undone.</p><a className="btn" href="#write">Back to writing</a></div>
  return (
    <div className="shell" style={director ? undefined : { gridTemplateColumns: '56px minmax(0, 1fr)' }}>
      <Rail s={s} view={view} director={director} toggleDirector={() => setDirector(x => !x)} openScratch={() => setScratch(x => !x)} />
      <main className="main" ref={main}>
        {s.error && <div className="err" style={{ margin: '12px 28px 0' }}>{s.error}<button className="x" aria-label="Dismiss" onClick={clearError}>×</button></div>}
        {!!s.legacy?.length && <div className="notice"><span className="grow"><b>{s.legacy.length} records from an older version of Canon are hidden.</b> They're left over from an earlier import. Removing them is one step you can undo.</span>
          <button className="btn sm" onClick={removeLegacy}>Remove them</button></div>}
        {view === 'write' && <WriteView key={a || 'first'} s={s} storyId={a} sceneId={b} />}
        {view === 'story' && (s.recs[a || stories(s)[0]?.id] ? <StoryView key={a} s={s} storyId={a || stories(s)[0].id} /> : missing)}
        {view === 'collection' && <CollectionView key={a} s={s} id={a} />}
        {view === 'world' && (a === 'types' ? <TypesView s={s} /> : !a || s.recs[a] ? <WorldView key={a} s={s} id={a} /> : missing)}
        {view === 'timeline' && <TimelineView s={s} sel={a} />}
        {view === 'knowledge' && <KnowledgeView s={s} />}
        {view === 'questions' && <QuestionsView s={s} focus={a} />}
        {view === 'find' && <FindView s={s} />}
        {view === 'project' && <ProjectView s={s} tab={a} />}
      </main>
      {director && <Director s={s} route={route} onClose={() => setDirector(false)} />}
      {palette && <Palette s={s} route={route} onClose={() => setPalette(false)} onAsk={q => { setPalette(false); ask(q) }} toggleDirector={() => setDirector(x => !x)} />}
      {scratch && <Scratch s={s} onClose={() => setScratch(false)} />}
      <Toast />
    </div>
  )
}

function Rail({ s, view, director, toggleDirector, openScratch }: { s: State; view: string; director: boolean; toggleDirector: () => void; openScratch: () => void }) {
  const open = openCount(s)
  const btn = (to: string, icon: string, label: string, on: boolean, badge?: number) =>
    <a className={'rail-btn' + (on ? ' on' : '')} href={'#' + to} title={label} aria-label={label}><Icon name={icon} />{badge ? <span className="badge">{badge}</span> : null}</a>
  return (
    <nav className="rail" aria-label="Main">
      <a className="logo" href="#write" title={project(s).title}>C</a>
      {btn('write', 'write', 'Write', ['write', 'story', 'collection'].includes(view))}
      {btn('world', 'world', 'World', view === 'world')}
      {btn('timeline', 'timeline', 'Timeline and knowledge', view === 'timeline' || view === 'knowledge')}
      {btn('questions', 'questions', 'Questions', view === 'questions', open)}
      {btn('find', 'find', 'Find and replace (⌘⇧F)', view === 'find')}
      <span className="sp" />
      <button className="rail-btn" title="Scratchpad" aria-label="Scratchpad" onClick={openScratch}><Icon name="scratch" /></button>
      {btn('project', 'settings', 'Project and settings', view === 'project')}
      <button className={'rail-btn' + (director ? ' on' : '')} title="Assistant (⌘J)" aria-label="Assistant" aria-pressed={director} onClick={toggleDirector}><Icon name="director" /></button>
      <span className={'save ' + s.save} title={s.save === 'saved' ? 'Saved' : s.save === 'saving' ? 'Saving…' : 'Save failed'} />
    </nav>
  )
}

function Scratch({ s, onClose }: { s: State; onClose: () => void }) {
  return (
    <div className="card" style={{ position: 'fixed', left: 68, bottom: 16, width: 360, zIndex: 30, boxShadow: 'var(--shadow)' }}>
      <div className="row"><b>Scratchpad</b><span className="small muted">Never sent to the AI</span><span className="grow" /><button className="x" aria-label="Close" onClick={onClose}>×</button></div>
      <textarea className="f" autoFocus style={{ minHeight: 220 }} value={project(s).scratch || ''} placeholder="Loose ideas, lines, reminders…" onChange={e => update<'project'>('project', x => { x.scratch = e.target.value })} />
    </div>
  )
}

// ---------------- ⌘K: search, commands, ask ----------------

interface Hit { kind: string; title: string; detail: string; run: () => void; score: number }
function search(s: State, q: string): Hit[] {
  const needle = q.toLowerCase().trim()
  if (!needle) return []
  const has = (t?: string) => !!t && t.toLowerCase().includes(needle)
  const word = new RegExp('\\b' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const nameScore = (t: string) => { const l = t.toLowerCase(); return l === needle ? 100 : l.startsWith(needle) ? 80 : word.test(l) ? 60 : l.includes(needle) ? 40 : 0 }
  const snip = (t: string) => { const i = t.toLowerCase().indexOf(needle); return i < 0 ? t.slice(0, 120) : (i > 40 ? '…' : '') + t.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, ' ') + '…' }
  const hits: Hit[] = []
  for (const e of entities(s)) {
    const n = Math.max(nameScore(e.name), ...e.aliases.map(a => nameScore(a) - 5))
    const body = [e.summary, ...Object.values(e.fields), e.notes].find(has)
    if (n || body) hits.push({ kind: typeDef(s, e.type).one, title: e.name, detail: n ? e.summary : snip(body!), run: () => go('world/' + e.id), score: n || 10 })
  }
  for (const st of stories(s)) { const n = nameScore(st.title); if (n || has(st.premise)) hits.push({ kind: 'Story', title: st.title, detail: st.premise, run: () => go('story/' + st.id), score: n || 12 }) }
  for (const sc of allScenes(s)) {
    const n = nameScore(sc.title)
    const to = () => go(`write/${sc.story}/${sc.id}`)
    if (n || has(sc.card)) hits.push({ kind: 'Scene', title: sc.title, detail: `${nameOf(s, sc.story)} · ${n ? sc.card : snip(sc.card)}`, run: to, score: n ? n - 10 : 8 })
    else if (has(sc.prose)) hits.push({ kind: 'Text', title: `${sc.title} · ${nameOf(s, sc.story)}`, detail: snip(sc.prose), run: to, score: 5 })
  }
  for (const f of list(s, 'fact')) { const n = nameScore(f.text); if (n || has(f.detail)) hits.push({ kind: f.at !== undefined ? 'Event ' + eventCode(s, f.id) : 'Fact', title: f.text, detail: f.detail, run: () => go('timeline/' + f.id), score: n ? n - 5 : 9 }) }
  for (const q2 of list(s, 'question')) if (has(q2.text)) hits.push({ kind: 'Question', title: q2.text, detail: q2.answer, run: () => go('questions/' + q2.id), score: 7 })
  return hits.sort((a, b) => b.score - a.score).slice(0, 30)
}

function commands(s: State, toggleDirector: () => void): Hit[] {
  const mk = (title: string, detail: string, run: () => void): Hit => ({ kind: 'Command', title, detail, run, score: 0 })
  return [
    mk('New story', 'Add a story to the project', () => newStory()),
    ...typeIds(s).map(t => mk(`New ${typeDef(s, t).one.toLowerCase()}`, 'Add to the world', () => { let id = ''; tx(`New ${typeDef(s, t).one.toLowerCase()}`, () => { id = create('entity', newEntityData(t, `New ${typeDef(s, t).one.toLowerCase()}`)) }, false); go('world/' + id) })),
    mk('New event', 'Add an event at the end of the timeline', () => { let id = ''; tx('New event', () => { id = create('fact', newFact({ text: 'New event', at: nextAt(s), causes: events(s).slice(-1).map(e => e.id) })) }); go('timeline/' + id) }),
    mk('New fact', 'A secret or state of the world', () => { tx('New fact', () => { create('fact', newFact({ text: 'New fact' })) }); go('knowledge') }),
    mk('Raise a question', 'An open question, plot hole or contradiction', () => { let id = ''; tx('New question', () => { id = create('question', newQuestion()) }, false); go('questions/' + id) }),
    mk('Find and replace', '⌘⇧F', () => go('find')),
    mk('Entity types', 'Rename, add or change the templates', () => go('world/types')),
    mk('Guides', 'Style, rules, banned phrases', () => go('project/guides')),
    mk('Progress', 'Targets and writing history', () => go('project/progress')),
    mk('Export', 'Compile to EPUB, print, Markdown or text', () => go('project/export')),
    mk('AI settings', 'Providers and models', () => go('project/ai')),
    mk('Toggle the assistant', '⌘J', toggleDirector),
  ]
}

function Palette({ s, route, onClose, onAsk, toggleDirector }: { s: State; route: string; onClose: () => void; onAsk: (q: string) => void; toggleDirector: () => void }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const hits = useMemo(() => {
    const cmd = commands(s, toggleDirector)
    const t = q.trim().toLowerCase()
    if (!t) return cmd.slice(0, 8)
    return [...search(s, q), ...cmd.filter(c => c.title.toLowerCase().includes(t.replace(/^[/>]/, '')))]
  }, [s, q, toggleDirector])
  const total = hits.length + (q.trim() ? 1 : 0)
  const pick = (n: number) => { if (n < hits.length) { hits[n].run(); onClose() } else if (q.trim()) onAsk(q) }
  void route
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={e => e.stopPropagation()} role="dialog" aria-label="Search and commands">
        <input autoFocus value={q} placeholder="Search everything, run a command, or ask the assistant" onChange={e => { setQ(e.target.value); setI(0) }}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') { e.preventDefault(); setI(x => Math.min(x + 1, total - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setI(x => Math.max(x - 1, 0)) }
            else if (e.key === 'Enter') pick(i)
          }} />
        <div className="results">
          {hits.map((h, n) => (
            <button key={n} className={'res' + (n === i ? ' on' : '')} onMouseEnter={() => setI(n)} onClick={() => pick(n)}>
              <span className="lbl">{h.kind}</span><div style={{ minWidth: 0 }}><b>{h.title}</b>{h.detail && <p>{h.detail}</p>}</div>
            </button>
          ))}
          {q.trim() && <button className={'res' + (i === hits.length ? ' on' : '')} onMouseEnter={() => setI(hits.length)} onClick={() => pick(hits.length)}>
            <span className="lbl ai">✦ Ask</span><div><b>{q}</b><p>Ask the assistant about your canon</p></div></button>}
        </div>
        <div className="hint"><span>↑↓ move</span><span>↵ open</span><span>esc close</span><span>⌘J Assistant</span><span>⌘Z undo</span></div>
      </div>
    </div>
  )
}

// ---------------- first run ----------------

function Welcome() {
  const [root, setRoot] = useState<string>()
  const [log, setLog] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { fetch('/api/info').then(r => r.json()).then(i => setRoot(i.root)) }, [])
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('')
    try { await fn(); location.hash = 'write' } catch (e) { setErr(String(e).replace(/^Error: /, '')) }
    setBusy(false)
  }
  const pickFiles = (fs: FileList | null) => { const xs = [...(fs || [])]; if (xs.length) run(() => importFiles(xs, m => setLog(l => [...l, m]))) }
  return (
    <div className="welcome">
      <span className="kicker">Canon</span>
      <h1>Start a project</h1>
      <p className="muted">Canon keeps a novel, a story collection or a series in one local database: the people and places, what happens and who knows it, and the scenes. An AI assistant works alongside you; nothing changes until you accept it, and everything can be undone.</p>
      <div className="card">
        <h3>Bring your writing</h3>
        <p className="muted small">Pick .txt or .md files, or a whole folder. Each manuscript becomes a story, split into scenes at <code>---</code> lines or headings. Files with frontmatter (<code>name:</code>, <code>type:</code>) become sheets for characters, places and so on, and their <code>## headings</code> become fields.</p>
        <div className="row">
          <label className="btn pri">{busy ? 'Importing…' : 'Choose files'}<input type="file" multiple accept=".txt,.md,.markdown" hidden disabled={busy} onChange={e => pickFiles(e.target.files)} /></label>
          <label className="btn">Choose a folder<input type="file" hidden disabled={busy} {...{ webkitdirectory: '' }} onChange={e => pickFiles(e.target.files)} /></label>
          <button className="btn ghost" disabled={busy} onClick={() => run(() => baseline([{ kind: 'project', id: 'project', data: emptyProject() }]))}>Start empty</button>
        </div>
      </div>
      {root && <div className="card">
        <h3>Canon folder</h3>
        <p className="muted small">Import the folder Canon was started with (<code>{root}</code>): <code>canon/*.json</code>, <code>characters/</code> and <code>worldbuilding/</code> sheets, and writer-skill guides. The folder is only read.</p>
        <div className="row"><button className="btn" disabled={busy} onClick={() => run(() => importCanonFolder(m => setLog(l => [...l, m])))}>Import Canon folder</button></div>
      </div>}
      {log.map((l, i) => <p key={i} className="muted small">✓ {l}</p>)}
      {err && <div className="err">{err}</div>}
    </div>
  )
}

