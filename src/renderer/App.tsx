import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useCanon, project, stories, entities, typeIds, typeDef, allScenes, list, events, nameOf, undoRedo, create, update, tx, clearError, baseline, emptyProject,
  newFact, newQuestion, newEntityData, nextAt, eventCode, removeLegacy, getState, showToast, type State,
} from './store.ts'
import { Toast, go, Icon, Bar, useChrome, setChrome, MOD } from './ui.tsx'
import { importCanonFolder, importFiles } from './importer.ts'
import { WriteView, newStory, addScene } from './views/Write.tsx'
import { WorldView, TypesView } from './views/World.tsx'
import { TimelineView, KnowledgeView } from './views/Timeline.tsx'
import { QuestionsView } from './views/Questions.tsx'
import { StoryView, CollectionView } from './views/Story.tsx'
import { ProjectView } from './views/Project.tsx'
import { FindView } from './views/Find.tsx'
import { Director } from './views/Director.tsx'
import { Sidebar, currentStory } from './views/Sidebar.tsx'

function useRoute() {
  const [h, setH] = useState(location.hash.slice(1))
  useEffect(() => { const f = () => setH(location.hash.slice(1)); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  return h || 'write'
}

export function App() {
  const s = useCanon()
  const route = useRoute()
  const chrome = useChrome()
  const [palette, setPalette] = useState(false)
  const [scratch, setScratch] = useState(false)
  const main = useRef<HTMLElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const [view, a, b] = route.split('/').map(decodeURIComponent)
  const title = s.recs.project ? project(s).title : ''

  useEffect(() => { main.current?.scrollTo(0, 0) }, [view, a, b])
  useEffect(() => { document.title = title ? `${title} · Canon` : 'Canon' }, [title])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const typing = (e.target as Element).closest?.('input, textarea, select, [contenteditable]')
      if (mod && e.key === 'k') { e.preventDefault(); setPalette(p => !p) }
      else if (mod && e.key === 'j') { e.preventDefault(); setChrome(c => ({ assistant: !c.assistant })) }
      else if (mod && e.key === '\\') { e.preventDefault(); setChrome(c => ({ sidebar: !c.sidebar })) }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); go('find') }
      else if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undoRedo(!e.shiftKey) }
    }
    // Menu commands from the desktop shell (see src/main/main.ts).
    const onMenu = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail
      const st = getState()
      const [v, x] = location.hash.slice(1).split('/')
      const story = currentStory(st, v, x)
      if (cmd.startsWith('go:')) {
        const to = cmd.slice(3)
        return go(to === 'write' || to === 'story' ? (story ? `${to}/${story.id}` : 'write') : to)
      }
      switch (cmd) {
        case 'palette': return setPalette(p => !p)
        case 'assistant': return setChrome(c => ({ assistant: !c.assistant }))
        case 'sidebar': return setChrome(c => ({ sidebar: !c.sidebar }))
        case 'undo': case 'redo': return undoRedo(cmd === 'undo')
        case 'new-story': return newStory()
        case 'new-scene': return story ? addScene(story) : newStory()
        case 'import': return files.current?.click()
        case 'reveal-data': return fetch('/api/info').then(r => r.json()).then(i => fetch('/api/reveal', { method: 'POST', body: JSON.stringify({ path: i.dataDir + '/canon.db' }) }))
        case 'back': return history.back()
        case 'forward': return history.forward()
        default: dispatchEvent(new CustomEvent('canon:command', { detail: cmd })) // focus, scene:prev, scene:next: the open view handles them
      }
    }
    const ask = () => setChrome({ assistant: true })
    addEventListener('keydown', onKey); addEventListener('canon:menu', onMenu); addEventListener('canon:ask', ask)
    return () => { removeEventListener('keydown', onKey); removeEventListener('canon:menu', onMenu); removeEventListener('canon:ask', ask) }
  }, [])

  if (!s.loaded) return <div className="empty" />
  if (!s.recs.project) return <Welcome />
  const ask = (q: string) => dispatchEvent(new CustomEvent('canon:ask', { detail: q }))
  const missing = <><Bar /><div className="empty"><h2>Not found</h2><p>It may have been deleted, or undone.</p><a className="btn" href="#write">Back to writing</a></div></>
  return (
    <div className={'shell' + (chrome.sidebar ? '' : ' no-side') + (chrome.assistant ? ' with-assistant' : '')}>
      {chrome.sidebar && <Sidebar s={s} view={view} a={a} b={b} onPalette={() => setPalette(true)} onScratch={() => setScratch(x => !x)} />}
      <main className="main" ref={main}>
        {s.error && <div className="err" style={{ margin: '12px 28px 0' }}>{s.error}<button className="x" aria-label="Dismiss" onClick={clearError}>×</button></div>}
        {!!s.legacy?.length && <div className="notice"><span className="grow"><b>{s.legacy.length} records from an older version of Canon are hidden.</b> They're left over from an earlier import. Removing them is one step you can undo.</span>
          <button className="btn sm" onClick={removeLegacy}>Remove them</button></div>}
        {view === 'write' && <WriteView key={a || 'first'} s={s} storyId={a || currentStory(s, view)?.id} sceneId={b} />}
        {view === 'story' && (s.recs[a || stories(s)[0]?.id] ? <StoryView key={a} s={s} storyId={a || stories(s)[0].id} /> : missing)}
        {view === 'collection' && <CollectionView key={a} s={s} id={a} />}
        {view === 'world' && (a === 'types' ? <TypesView s={s} /> : !a || s.recs[a] ? <WorldView key={a} s={s} id={a} /> : missing)}
        {view === 'timeline' && <TimelineView s={s} sel={a} />}
        {view === 'knowledge' && <KnowledgeView s={s} />}
        {view === 'questions' && <QuestionsView s={s} focus={a} />}
        {view === 'find' && <FindView s={s} />}
        {view === 'project' && <ProjectView s={s} tab={a} />}
      </main>
      {chrome.assistant && <Director s={s} route={route} onClose={() => setChrome({ assistant: false })} />}
      {palette && <Palette s={s} onClose={() => setPalette(false)} onAsk={q => { setPalette(false); ask(q) }} />}
      {scratch && <Scratch s={s} onClose={() => setScratch(false)} />}
      <input ref={files} type="file" multiple accept=".txt,.md,.markdown" hidden onChange={e => { const xs = [...(e.target.files || [])]; e.target.value = ''; if (xs.length) importFiles(xs, m => showToast('Imported ' + m)).catch(err => showToast(String(err).replace(/^Error: /, ''))) }} />
      <Toast />
    </div>
  )
}

function Scratch({ s, onClose }: { s: State; onClose: () => void }) {
  return (
    <div className="card scratch" role="dialog" aria-label="Scratchpad" onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
      <div className="row"><b>Scratchpad</b><span className="small muted">Never sent to the AI</span><span className="grow" /><button className="x" aria-label="Close" onClick={onClose}>×</button></div>
      <textarea className="f" autoFocus style={{ minHeight: 240 }} value={project(s).scratch || ''} placeholder="Loose ideas, lines, reminders…" onChange={e => update<'project'>('project', x => { x.scratch = e.target.value })} />
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

function commands(s: State): Hit[] {
  const mk = (title: string, detail: string, run: () => void): Hit => ({ kind: 'Command', title, detail, run, score: 0 })
  return [
    mk('New story', 'Add a story to the project', () => newStory()),
    ...typeIds(s).map(t => mk(`New ${typeDef(s, t).one.toLowerCase()}`, 'Add to the world', () => { let id = ''; tx(`New ${typeDef(s, t).one.toLowerCase()}`, () => { id = create('entity', newEntityData(t, `New ${typeDef(s, t).one.toLowerCase()}`)) }, false); go('world/' + id) })),
    mk('New event', 'Add an event at the end of the timeline', () => { let id = ''; tx('New event', () => { id = create('fact', newFact({ text: 'New event', at: nextAt(s), causes: events(s).slice(-1).map(e => e.id) })) }); go('timeline/' + id) }),
    mk('New fact', 'A secret or state of the world', () => { tx('New fact', () => { create('fact', newFact({ text: 'New fact' })) }); go('knowledge') }),
    mk('Raise a question', 'An open question, plot hole or contradiction', () => { let id = ''; tx('New question', () => { id = create('question', newQuestion()) }, false); go('questions/' + id) }),
    mk('Find and replace', MOD + '⇧F', () => go('find')),
    mk('Entity types', 'Rename, add or change the templates', () => go('world/types')),
    mk('Guides', 'Style, rules, banned phrases', () => go('project/guides')),
    mk('Progress', 'Targets and writing history', () => go('project/progress')),
    mk('Export', 'Compile to EPUB, print, Markdown or text', () => go('project/export')),
    mk('AI settings', 'Providers and models', () => go('project/ai')),
    mk('Toggle the assistant', MOD + 'J', () => setChrome(c => ({ assistant: !c.assistant }))),
    mk('Toggle the sidebar', MOD + '\\', () => setChrome(c => ({ sidebar: !c.sidebar }))),
  ]
}

function Palette({ s, onClose, onAsk }: { s: State; onClose: () => void; onAsk: (q: string) => void }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const hits = useMemo(() => {
    const cmd = commands(s)
    const t = q.trim().toLowerCase()
    if (!t) return cmd.slice(0, 8)
    return [...search(s, q), ...cmd.filter(c => c.title.toLowerCase().includes(t.replace(/^[/>]/, '')))]
  }, [s, q])
  const total = hits.length + (q.trim() ? 1 : 0)
  const pick = (n: number) => { if (n < hits.length) { hits[n].run(); onClose() } else if (q.trim()) onAsk(q) }
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
        </div>
        {q.trim() && <div className="ask-row"><button className={'res' + (i === hits.length ? ' on' : '')} onMouseEnter={() => setI(hits.length)} onClick={() => pick(hits.length)}>
          <span className="lbl ai">✦ Ask</span><div style={{ minWidth: 0 }}><b className="clip" style={{ display: 'block' }}>{q}</b><p>Ask the assistant about your canon</p></div></button></div>}
        <div className="hint"><span><kbd>↑↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span><span className="grow" /><span><kbd>{MOD}J</kbd> assistant</span><span><kbd>{MOD}Z</kbd> undo</span></div>
      </div>
    </div>
  )
}

// ---------------- first run ----------------

function Welcome() {
  const [log, setLog] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what); setErr('')
    try { await fn(); location.hash = 'write' } catch (e) { setErr(String(e).replace(/^Error: /, '')) }
    setBusy('')
  }
  const pickFiles = (fs: FileList | null) => { const xs = [...(fs || [])]; if (xs.length) run('files', () => importFiles(xs, m => setLog(l => [...l, m]))) }
  const canonFolder = () => run('canon', async () => {
    const { picked } = await (await fetch('/api/root', { method: 'POST' })).json()
    if (!picked) throw new Error('')
    await importCanonFolder(m => setLog(l => [...l, m]))
  })
  return (
    <div className="welcome-wrap">
      <div className="welcome-drag" />
      <div className="welcome">
        <div className="logo-mark">C</div>
        <h1>Welcome to Canon</h1>
        <p className="lead muted">A studio for a novel, a story collection or a series. The people and places, what happens and who knows it, and the scenes, in one local file. An assistant works alongside you; nothing changes until you accept it, and everything can be undone.</p>
        <div className="choices">
          <button className="choice" disabled={!!busy} onClick={() => run('empty', () => baseline([{ kind: 'project', id: 'project', data: emptyProject() }]))}>
            <Icon name="plus" size={20} /><b>Start a new project</b><span>An empty project with characters, places, groups, objects and lore ready to fill in.</span>
          </button>
          <label className={'choice' + (busy ? ' disabled' : '')}>
            <Icon name="import" size={20} /><b>{busy === 'files' ? 'Importing…' : 'Import your writing'}</b><span>Pick .txt or .md files. Each manuscript becomes a story, split into scenes at <code>---</code> or headings; files with <code>name:</code> / <code>type:</code> frontmatter become sheets.</span>
            <input type="file" multiple accept=".txt,.md,.markdown" hidden disabled={!!busy} onChange={e => pickFiles(e.target.files)} />
          </label>
        </div>
        <p className="small muted">Have a whole folder? <label className="link">Import a folder of files<input type="file" hidden disabled={!!busy} {...{ webkitdirectory: '' }} onChange={e => pickFiles(e.target.files)} /></label>
          {' '}or <button className="link" disabled={!!busy} onClick={canonFolder}>{busy === 'canon' ? 'importing…' : 'a Canon story folder'}</button> (<code>canon/*.json</code>, <code>characters/</code>, <code>worldbuilding/</code>; only read, never changed).</p>
        {log.map((l, i) => <p key={i} className="small ok-text">✓ {l}</p>)}
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  )
}
