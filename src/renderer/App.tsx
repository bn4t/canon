import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useCanon, project, stories, entities, typeIds, typeDef, allScenes, list, get, events, nameOf, undoRedo, create, update, tx, clearError,
  newFact, newQuestion, newEntityData, nextAt, eventCode, removeLegacy, getState, showToast, type State,
} from './store.ts'
import { Toast, go, replaceRoute, Bar, Spark, useChrome, setChrome, MOD, openSettings, openReference, useSettingsSection, store, stored, type SettingsSection } from './ui.tsx'
import { useAI, aiReady } from './ai.ts'
import { newStory, addScene, newChapter } from './scenes.ts'
import { SceneView } from './views/Write.tsx'
import { WorldView } from './views/World.tsx'
import { TimelineView } from './views/Timeline.tsx'
import { QuestionsView } from './views/Questions.tsx'
import { StoryView, CollectionView } from './views/Story.tsx'
import { HomeView } from './views/Home.tsx'
import { SettingsWindow, ProviderRow, useProviderSignIn } from './views/Settings.tsx'
import { FindView } from './views/Find.tsx'
import { Director } from './views/Director.tsx'
import { Sidebar, routeStory } from './views/Sidebar.tsx'
import { Setup } from './views/Setup.tsx'
import { TextView } from './views/Text.tsx'
import { ResearchView } from './views/Research.tsx'
import { ReferencePane } from './views/Reference.tsx'
import { ImportHost } from './views/Import.tsx'
import { ProjectsHost } from './views/Projects.tsx'
import { ExportHost } from './views/Export.tsx'

const VIEWS = ['home', 'scene', 'story', 'text', 'collection', 'world', 'timeline', 'knowledge', 'questions', 'research', 'find']
/** Pass a command to whichever screen handles it; true when nothing did (no listener called preventDefault). */
export const command = (cmd: string) => dispatchEvent(new CustomEvent('canon:command', { detail: cmd, cancelable: true }))
/** Settings used to be a page with tabs. */
const OLD_TABS: Record<string, SettingsSection> = { project: 'details', guides: 'guides', progress: 'goals', ai: 'assistant', export: 'export' }

function useRoute() {
  const [h, setH] = useState(location.hash.slice(1))
  useEffect(() => { const f = () => setH(location.hash.slice(1)); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  return h || 'home'
}

export function App() {
  const s = useCanon()
  const route = useRoute()
  const chrome = useChrome()
  const settings = useSettingsSection()
  const [palette, setPalette] = useState(false)
  const [scratch, setScratch] = useState(false)
  const [setup, setSetup] = useState(() => stored('canon.setup', ''))
  const main = useRef<HTMLElement>(null)
  const [view, a, b] = route.split('/').map(decodeURIComponent)
  const title = s.recs.project ? project(s).title : ''

  useEffect(() => { main.current?.scrollTo(0, 0) }, [view, a])
  useEffect(() => { document.title = title ? `${title} · Canon` : 'Canon' }, [title])
  // Old links (and bookmarks in the menu) still land somewhere sensible.
  useEffect(() => {
    if (!s.loaded || !s.recs.project) return
    if (view === 'write') { const sc = get(s, b, 'scene'); replaceRoute(sc ? 'scene/' + sc.id : get(s, a, 'story') ? 'story/' + a : 'home') }
    else if (view === 'project') { openSettings(OLD_TABS[a] || 'details'); replaceRoute('home') }
    else if (view === 'world' && a === 'types') { openSettings('types'); replaceRoute('world') }
    else if (view === 'story' && !a) { const st = stories(s)[0]; replaceRoute(st ? 'story/' + st.id : 'home') }
    else if (!VIEWS.includes(view)) replaceRoute('home')
  }, [view, a, b, s.loaded, !!s.recs.project]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (view === 'scene' && get(s, a, 'scene')) store('canon.last', JSON.stringify({ id: a, at: Date.now() })) }, [view, a]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const typing = (e.target as Element).closest?.('input, textarea, select, [contenteditable]')
      if (mod && e.key === 'k') { e.preventDefault(); setPalette(p => !p) }
      else if (mod && e.key === 'j') { e.preventDefault(); setChrome(c => ({ assistant: !c.assistant })) }
      else if (mod && e.key === '\\') { e.preventDefault(); setChrome(c => ({ sidebar: !c.sidebar })) }
      else if (mod && e.key === ',') { e.preventDefault(); openSettings('details') }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); go('find') }
      else if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undoRedo(!e.shiftKey) }
    }
    // Menu commands from the desktop shell (see src/main/main.ts).
    const onMenu = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail
      const st = getState()
      const [v, x] = location.hash.slice(1).split('/')
      const story = routeStory(st, v, x)
      if (cmd === 'go:outline') { const to = story || stories(st)[0]; return go(to ? 'story/' + to.id : 'home') }
      if (cmd.startsWith('go:')) return go(cmd.slice(3))
      if (cmd === 'settings' || cmd.startsWith('settings:')) return openSettings((cmd.split(':')[1] || 'details') as SettingsSection)
      switch (cmd) {
        case 'palette': return setPalette(p => !p)
        case 'assistant': return setChrome(c => ({ assistant: !c.assistant }))
        case 'sidebar': return setChrome(c => ({ sidebar: !c.sidebar }))
        case 'undo': case 'redo': return undoRedo(cmd === 'undo')
        case 'new-story': return newStory()
        case 'new-scene': { const to = story || stories(st)[0]; if (!to) return newStory(); addScene(to); if (!story) showToast(`New scene in “${to.title}”`); return }
        case 'new-chapter': { const to = story || stories(st)[0]; if (!to) return newStory(); return newChapter(to) }
        case 'reference': return setChrome(c => ({ reference: c.reference === null ? '' : null }))
        case 'find': if (command('find')) go('find'); return // the editor finds in its text; elsewhere, the whole project
        case 'reveal-data': return fetch('/api/info').then(r => r.json()).then(i => fetch('/api/reveal', { method: 'POST', body: JSON.stringify({ path: i.db }) }))
        case 'back': return history.back()
        case 'forward': return history.forward()
        default: command(cmd) // focus, scene:prev/next, format:*, import, print, projects…: the open view or a host handles them
      }
    }
    const open = () => setChrome({ assistant: true })
    addEventListener('keydown', onKey); addEventListener('canon:menu', onMenu); addEventListener('canon:ask', open); addEventListener('canon:interview', open)
    return () => { removeEventListener('keydown', onKey); removeEventListener('canon:menu', onMenu); removeEventListener('canon:ask', open); removeEventListener('canon:interview', open) }
  }, [])

  if (!s.loaded) return <div className="empty" />
  if (!s.recs.project || setup) return <Setup s={s} step={setup} onStep={st => { store('canon.setup', st); setSetup(st) }} />
  const ask = (q: string) => dispatchEvent(new CustomEvent('canon:ask', { detail: q }))
  const missing = <><Bar /><div className="empty"><h2>Not found</h2><p>It may have been deleted, or undone.</p><a className="btn" href="#home">Go home</a></div></>
  return (
    <div className={'shell' + (chrome.sidebar ? '' : ' no-side') + (chrome.assistant ? ' with-assistant' : '')}>
      {chrome.sidebar && <Sidebar s={s} view={view} a={a} onPalette={() => setPalette(true)} onScratch={() => setScratch(x => !x)} />}
      <main className="main" ref={main}>
        {s.error && <div className="err" style={{ margin: '12px 28px 0' }}>{s.error}<button className="x" aria-label="Dismiss" onClick={clearError}>×</button></div>}
        {!!s.legacy?.length && <div className="notice"><span className="grow"><b>{s.legacy.length} records from an older version of Canon are hidden.</b> They’re left over from an earlier import. Removing them is one step you can undo.</span>
          <button className="btn sm" onClick={removeLegacy}>Remove them</button></div>}
        {view === 'home' && <HomeView s={s} />}
        {view === 'scene' && (get(s, a, 'scene') ? <SceneView key={a} s={s} sceneId={a} /> : missing)}
        {view === 'story' && a && (get(s, a, 'story') ? <StoryView key={a} s={s} storyId={a} /> : missing)}
        {view === 'text' && (get(s, a, 'story') || get(s, a, 'section') ? <TextView key={a} s={s} id={a} /> : missing)}
        {view === 'research' && (!a || get(s, a, 'research') ? <ResearchView key={a || 'index'} s={s} id={a} /> : missing)}
        {view === 'collection' && <CollectionView key={a} s={s} id={a} />}
        {view === 'world' && a !== 'types' && (!a || s.recs[a] ? <WorldView key={a || 'index'} s={s} id={a} /> : missing)}
        {(view === 'timeline' || view === 'knowledge') && <TimelineView s={s} sel={a} lens={view === 'knowledge' ? 'knowledge' : 'stories'} />}
        {view === 'questions' && <QuestionsView s={s} focus={a} />}
        {view === 'find' && <FindView s={s} />}
      </main>
      {chrome.reference !== null && <ReferencePane s={s} id={chrome.reference} />}
      {chrome.assistant && <Director s={s} route={route} onClose={() => setChrome({ assistant: false })} />}
      {palette && <Palette s={s} onClose={() => setPalette(false)} onAsk={q => { setPalette(false); ask(q) }} />}
      {scratch && <Scratch s={s} onClose={() => setScratch(false)} />}
      {settings && <SettingsWindow s={s} section={settings} />}
      <ImportHost s={s} /><ProjectsHost s={s} /><ExportHost s={s} />
      <Toast />
    </div>
  )
}

function Scratch({ s, onClose }: { s: State; onClose: () => void }) {
  return (
    <div className="card scratch" role="dialog" aria-label="Scratchpad" onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
      <div className="row"><b>Scratchpad</b><span className="small muted">Never sent to the assistant</span><span className="grow" /><button className="x" aria-label="Close" onClick={onClose}>×</button></div>
      <textarea className="f" autoFocus style={{ minHeight: 240 }} value={project(s).scratch || ''} placeholder="Loose ideas, lines, reminders…" onChange={e => update<'project'>('project', x => { x.scratch = e.target.value })} />
    </div>
  )
}

// ---------------- ⌘K: search, commands, ask ----------------

/** `id`: the record a hit opens, so ⌥↵ can open it in the reference pane instead. */
interface Hit { kind: string; title: string; detail: string; run: () => void; score: number; id?: string }
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
    if (n || body) hits.push({ kind: typeDef(s, e.type).one, title: e.name, detail: n ? e.summary : snip(body!), run: () => go('world/' + e.id), score: n || 10, id: e.id })
  }
  for (const st of stories(s)) { const n = nameScore(st.title); if (n || has(st.premise)) hits.push({ kind: 'Story', title: st.title, detail: st.premise, run: () => go('story/' + st.id), score: n || 12, id: st.id }) }
  // Chapters and parts open as one continuous text.
  for (const sec of list(s, 'section')) { const n = nameScore(sec.title); if (n || has(sec.synopsis)) hits.push({ kind: sec.type === 'part' ? 'Part' : 'Chapter', title: sec.title || 'Untitled', detail: `${nameOf(s, sec.story)}${sec.synopsis ? ' · ' + (n ? sec.synopsis : snip(sec.synopsis)) : ''}`, run: () => go('text/' + sec.id), score: n ? n - 8 : 9, id: sec.id }) }
  for (const sc of allScenes(s)) {
    const n = nameScore(sc.title)
    const to = () => go('scene/' + sc.id)
    if (n || has(sc.card)) hits.push({ kind: 'Scene', title: sc.title, detail: `${nameOf(s, sc.story)} · ${n ? sc.card : snip(sc.card)}`, run: to, score: n ? n - 10 : 8, id: sc.id })
    else if (has(sc.prose)) hits.push({ kind: 'Text', title: `${sc.title} · ${nameOf(s, sc.story)}`, detail: snip(sc.prose), run: to, score: 5, id: sc.id })
  }
  for (const f of list(s, 'fact')) { const n = nameScore(f.text); if (n || has(f.detail)) hits.push({ kind: f.at !== undefined ? 'Event ' + eventCode(s, f.id) : 'Fact', title: f.text, detail: f.detail, run: () => go('timeline/' + f.id), score: n ? n - 5 : 9, id: f.id }) }
  for (const q2 of list(s, 'question')) if (has(q2.text)) hits.push({ kind: 'Question', title: q2.text, detail: q2.answer, run: () => go('questions/' + q2.id), score: 7, id: q2.id })
  return hits.sort((a, b) => b.score - a.score).slice(0, 30)
}

function commands(s: State, view: string, a?: string): Hit[] {
  const mk = (title: string, detail: string, run: () => void): Hit => ({ kind: 'Command', title, detail, run, score: 0 })
  const story = routeStory(s, view, a) || stories(s)[0]
  return [
    ...(story ? [mk('New scene', `At the end of “${story.title}”`, () => addScene(story))] : []),
    ...(story ? [mk('New chapter', `At the end of “${story.title}”, with a first scene`, () => newChapter(story))] : []),
    mk('New story', 'Add a story to the manuscript', () => newStory()),
    mk('Import…', 'Word, RTF, OpenDocument, Markdown, text, a folder or a Scrivener project', () => command('import')),
    mk('Print…', MOD + 'P', () => command('print')),
    mk('Research', 'Files, web pages and notes beside the manuscript', () => go('research')),
    mk('Open the reference pane', 'A second document beside this one', () => setChrome({ reference: '' })),
    mk('Switch project…', 'Open another project, or start a new one', () => command('switch-project')),
    mk('Book details', 'Front and back matter, cover, metadata', () => openSettings('book')),
    mk('Restore from a backup', 'Earlier copies of this project', () => openSettings('backups')),
    ...typeIds(s).map(t => mk(`New ${typeDef(s, t).one.toLowerCase()}`, 'Add to the world', () => { let id = ''; tx(`New ${typeDef(s, t).one.toLowerCase()}`, () => { id = create('entity', newEntityData(t, `New ${typeDef(s, t).one.toLowerCase()}`)) }, false); go('world/' + id) })),
    mk('New event', 'At the end of the timeline', () => { let id = ''; tx('New event', () => { id = create('fact', newFact({ text: 'New event', at: nextAt(s), causes: events(s).slice(-1).map(e => e.id) })) }); go('timeline/' + id) }),
    mk('New undated fact', 'A secret or a state of the world', () => { let id = ''; tx('New fact', () => { id = create('fact', newFact({ text: 'New fact' })) }); go('knowledge/' + id) }),
    mk('Raise a question', 'An open question, plot hole or contradiction', () => { let id = ''; tx('New question', () => { id = create('question', newQuestion()) }, false); go('questions/' + id) }),
    mk('Go home', 'The project overview', () => go('home')),
    mk('Find and replace', MOD + '⇧F', () => go('find')),
    mk('Settings', MOD + ',', () => openSettings('details')),
    mk('Goals and progress', 'Word targets and writing history', () => openSettings('goals')),
    mk('Guides', 'Style, rules, banned phrases', () => openSettings('guides')),
    mk('Types and fields', 'The kinds of things in your world', () => openSettings('types')),
    mk('Assistant settings', 'Providers and models', () => openSettings('assistant')),
    mk('Export', 'Word, PDF, EPUB, RTF, Markdown or text', () => openSettings('export')),
    mk('Toggle the assistant', MOD + 'J', () => setChrome(c => ({ assistant: !c.assistant }))),
    mk('Toggle the sidebar', MOD + '\\', () => setChrome(c => ({ sidebar: !c.sidebar }))),
  ]
}

function Palette({ s, onClose, onAsk }: { s: State; onClose: () => void; onAsk: (q: string) => void }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const ai = useAI()
  const [view, a] = location.hash.slice(1).split('/')
  const hits = useMemo(() => {
    const cmd = commands(s, view, a)
    const t = q.trim().toLowerCase()
    if (!t) return cmd.slice(0, 8)
    return [...search(s, q), ...cmd.filter(c => c.title.toLowerCase().includes(t.replace(/^[/>]/, '')))]
  }, [s, q, view, a])
  const total = hits.length + (q.trim() ? 1 : 0)
  const pick = (n: number, beside = false) => { if (n < hits.length) { const h = hits[n]; if (beside && h.id) openReference(h.id); else h.run(); onClose() } else if (q.trim()) { if (aiReady(ai)) onAsk(q); else { onClose(); openSettings('assistant') } } }
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={e => e.stopPropagation()} role="dialog" aria-label="Search or ask">
        <input autoFocus value={q} placeholder="Search everything, run a command, or ask the assistant" onChange={e => { setQ(e.target.value); setI(0) }}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') { e.preventDefault(); setI(x => Math.min(x + 1, total - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setI(x => Math.max(x - 1, 0)) }
            else if (e.key === 'Enter') pick(i, e.altKey)
          }} />
        <div className="results">
          {!q.trim() && <div className="lbl" style={{ padding: '6px 10px 2px' }}>Commands</div>}
          {hits.map((h, n) => (
            <button key={n} className={'res' + (n === i ? ' on' : '')} onMouseEnter={() => setI(n)} onClick={e => pick(n, e.altKey)}>
              <span className="lbl">{h.kind}</span><div style={{ minWidth: 0 }}><b>{h.title}</b>{h.detail && <p>{h.detail}</p>}</div>
            </button>
          ))}
          {q.trim() && !hits.length && <p className="small muted" style={{ padding: '10px 12px' }}>Nothing in the project matches.</p>}
        </div>
        {q.trim() && <div className="ask-row"><button className={'res' + (i === hits.length ? ' on' : '')} onMouseEnter={() => setI(hits.length)} onClick={() => pick(hits.length)}>
          <span className="lbl ai"><Spark size={11} /> Ask</span><div style={{ minWidth: 0 }}><b className="clip" style={{ display: 'block' }}>{q}</b><p>{aiReady(ai) ? 'Ask the assistant about your project' : 'Connect an assistant to ask it'}</p></div></button></div>}
        <div className="hint"><span><kbd>↑↓</kbd> move</span><span><kbd>↵</kbd> open</span>{hits[i]?.id && <span><kbd>⌥↵</kbd> open beside</span>}<span><kbd>esc</kbd> close</span><span className="grow" /><span><kbd>{MOD}J</kbd> assistant</span><span><kbd>{MOD}Z</kbd> undo</span></div>
      </div>
    </div>
  )
}
