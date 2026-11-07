import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useCanon, project, stories, entities, typeIds, typeDef, allScenes, list, get, events, nameOf, undoRedo, create, update, tx, clearError, baseline, emptyProject,
  newFact, newQuestion, newEntityData, newScene, nextAt, eventCode, removeLegacy, getState, showToast, type State, type Kind,
} from './store.ts'
import { Toast, go, replaceRoute, Icon, Bar, Spark, useChrome, setChrome, MOD, openSettings, useSettingsSection, store, stored, type SettingsSection } from './ui.tsx'
import { useAI, aiReady } from './ai.ts'
import { importCanonFolder, importFiles } from './importer.ts'
import { newStory, addScene } from './scenes.ts'
import { sampleRecords } from './sample.ts'
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

const VIEWS = ['home', 'scene', 'story', 'collection', 'world', 'timeline', 'knowledge', 'questions', 'find']
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
  const files = useRef<HTMLInputElement>(null)
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
        case 'import': return files.current?.click()
        case 'reveal-data': return fetch('/api/info').then(r => r.json()).then(i => fetch('/api/reveal', { method: 'POST', body: JSON.stringify({ path: i.dataDir + '/canon.db' }) }))
        case 'back': return history.back()
        case 'forward': return history.forward()
        default: dispatchEvent(new CustomEvent('canon:command', { detail: cmd })) // focus, scene:prev, scene:next: the open view handles them
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
        {view === 'collection' && <CollectionView key={a} s={s} id={a} />}
        {view === 'world' && a !== 'types' && (!a || s.recs[a] ? <WorldView key={a || 'index'} s={s} id={a} /> : missing)}
        {(view === 'timeline' || view === 'knowledge') && <TimelineView s={s} sel={a} lens={view === 'knowledge' ? 'knowledge' : 'stories'} />}
        {view === 'questions' && <QuestionsView s={s} focus={a} />}
        {view === 'find' && <FindView s={s} />}
      </main>
      {chrome.assistant && <Director s={s} route={route} onClose={() => setChrome({ assistant: false })} />}
      {palette && <Palette s={s} onClose={() => setPalette(false)} onAsk={q => { setPalette(false); ask(q) }} />}
      {scratch && <Scratch s={s} onClose={() => setScratch(false)} />}
      {settings && <SettingsWindow s={s} section={settings} />}
      <input ref={files} type="file" multiple accept=".txt,.md,.markdown" hidden onChange={e => { const xs = [...(e.target.files || [])]; e.target.value = ''; if (xs.length) importFiles(xs, m => showToast('Imported ' + m)).catch(err => showToast(String(err).replace(/^Error: /, ''))) }} />
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
    const to = () => go('scene/' + sc.id)
    if (n || has(sc.card)) hits.push({ kind: 'Scene', title: sc.title, detail: `${nameOf(s, sc.story)} · ${n ? sc.card : snip(sc.card)}`, run: to, score: n ? n - 10 : 8 })
    else if (has(sc.prose)) hits.push({ kind: 'Text', title: `${sc.title} · ${nameOf(s, sc.story)}`, detail: snip(sc.prose), run: to, score: 5 })
  }
  for (const f of list(s, 'fact')) { const n = nameScore(f.text); if (n || has(f.detail)) hits.push({ kind: f.at !== undefined ? 'Event ' + eventCode(s, f.id) : 'Fact', title: f.text, detail: f.detail, run: () => go('timeline/' + f.id), score: n ? n - 5 : 9 }) }
  for (const q2 of list(s, 'question')) if (has(q2.text)) hits.push({ kind: 'Question', title: q2.text, detail: q2.answer, run: () => go('questions/' + q2.id), score: 7 })
  return hits.sort((a, b) => b.score - a.score).slice(0, 30)
}

function commands(s: State, view: string, a?: string): Hit[] {
  const mk = (title: string, detail: string, run: () => void): Hit => ({ kind: 'Command', title, detail, run, score: 0 })
  const story = routeStory(s, view, a) || stories(s)[0]
  return [
    ...(story ? [mk('New scene', `At the end of “${story.title}”`, () => addScene(story))] : []),
    mk('New story', 'Add a story to the manuscript', () => newStory()),
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
    mk('Export', 'EPUB, print, Markdown or text', () => openSettings('export')),
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
  const pick = (n: number) => { if (n < hits.length) { hits[n].run(); onClose() } else if (q.trim()) { if (aiReady(ai)) onAsk(q); else { onClose(); openSettings('assistant') } } }
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={e => e.stopPropagation()} role="dialog" aria-label="Search or ask">
        <input autoFocus value={q} placeholder="Search everything, run a command, or ask the assistant" onChange={e => { setQ(e.target.value); setI(0) }}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') { e.preventDefault(); setI(x => Math.min(x + 1, total - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setI(x => Math.max(x - 1, 0)) }
            else if (e.key === 'Enter') pick(i)
          }} />
        <div className="results">
          {!q.trim() && <div className="lbl" style={{ padding: '6px 10px 2px' }}>Commands</div>}
          {hits.map((h, n) => (
            <button key={n} className={'res' + (n === i ? ' on' : '')} onMouseEnter={() => setI(n)} onClick={() => pick(n)}>
              <span className="lbl">{h.kind}</span><div style={{ minWidth: 0 }}><b>{h.title}</b>{h.detail && <p>{h.detail}</p>}</div>
            </button>
          ))}
          {q.trim() && !hits.length && <p className="small muted" style={{ padding: '10px 12px' }}>Nothing in the project matches.</p>}
        </div>
        {q.trim() && <div className="ask-row"><button className={'res' + (i === hits.length ? ' on' : '')} onMouseEnter={() => setI(hits.length)} onClick={() => pick(hits.length)}>
          <span className="lbl ai"><Spark size={11} /> Ask</span><div style={{ minWidth: 0 }}><b className="clip" style={{ display: 'block' }}>{q}</b><p>{aiReady(ai) ? 'Ask the assistant about your project' : 'Connect an assistant to ask it'}</p></div></button></div>}
        <div className="hint"><span><kbd>↑↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span><span className="grow" /><span><kbd>{MOD}J</kbd> assistant</span><span><kbd>{MOD}Z</kbd> undo</span></div>
      </div>
    </div>
  )
}

// ---------------- first run: welcome, name, assistant, where to start ----------------

const STEPS = ['Welcome', 'Name the project', 'Connect an assistant', 'Where to start']

function Setup({ s, step, onStep }: { s: State; step: string; onStep: (st: string) => void }) {
  const [log, setLog] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [name, setName] = useState({ title: '', logline: '', author: '' })
  const ai = useAI()
  const auth = useProviderSignIn()
  const cur = s.recs.project ? Math.max(1, STEPS.indexOf(step)) : step === STEPS[1] ? 1 : 0
  const run = async (what: string, fn: () => Promise<unknown>, after = '') => {
    setBusy(what); setErr('')
    try { await fn(); onStep(after); if (!after) location.hash = 'home' } catch (e) { setErr(String(e).replace(/^Error: /, '')) }
    setBusy('')
  }
  const pickFiles = (fs: FileList | null) => { const xs = [...(fs || [])]; if (xs.length) run('files', () => importFiles(xs, m => setLog(l => [...l, m]))) }
  const canonFolder = () => run('canon', async () => {
    const { picked } = await (await fetch('/api/root', { method: 'POST' })).json()
    if (!picked) throw new Error('')
    await importCanonFolder(m => setLog(l => [...l, m]))
  })
  const sample = () => run('sample', () => baseline(sampleRecords() as { kind: Kind; id: string; data: Record<string, unknown> }[]))
  const create1 = () => run('new', () => baseline([{ kind: 'project', id: 'project', data: { ...emptyProject(), title: name.title.trim() || 'Untitled project', logline: name.logline.trim(), author: name.author.trim() || undefined } }]), STEPS[2])
  const finish = (to: () => void) => { onStep(''); to() }
  const firstScene = () => finish(() => {
    let id = ''
    tx('First scene', () => { const st = create('story', { title: 'Untitled story', order: 1, form: 'prose', premise: '', beats: [] }); id = create('scene', newScene(st, 1, { title: 'Untitled scene' })) }, false)
    go('scene/' + id)
  })
  const sketch = () => finish(() => { const t = typeIds(getState()).includes('character') ? 'character' : typeIds(getState())[0]; let id = ''; tx('New character', () => { id = create('entity', newEntityData(t, 'New ' + typeDef(getState(), t).one.toLowerCase())) }, false); go('world/' + id) })
  const outline = () => finish(() => newStory())
  return (
    <div className="welcome-wrap">
      <div className="welcome-drag" />
      <div className="setup">
        <ol className="setup-steps" aria-label="Setup steps">
          {STEPS.map((l, i) => <li key={l} className={i < cur ? 'done' : i === cur ? 'cur' : ''}><span className="n">{i < cur ? <Icon name="check" size={11} /> : i + 1}</span>{l}{i < STEPS.length - 1 && <span className="line" />}</li>)}
        </ol>

        {cur === 0 && <div className="setup-card">
          <div className="logo-mark">C</div>
          <div><div className="setup-kick">STEP 1 OF 4</div><h1>Welcome to Canon</h1></div>
          <p className="lead muted">A studio for a novel, a story collection or a series: the people and places, what happens and who knows it, and the scenes, in one file on this Mac. An assistant can work alongside you; nothing it suggests changes your work until you accept it, and everything can be undone.</p>
          <div className="choices">
            <button className="choice" disabled={!!busy} onClick={() => onStep(STEPS[1])}><Icon name="plus" size={20} /><b>Start a new project</b><span>Name it, and Canon sets up characters, places, groups, objects and lore to fill in.</span></button>
            <button className="choice" disabled={!!busy} onClick={sample}><Icon name="stories" size={20} /><b>{busy === 'sample' ? 'Opening…' : 'Open the sample project'}</b><span>“Low Tide at Merrow”: three stories, a small cast, a timeline and some open questions to explore.</span></button>
            <label className={'choice' + (busy ? ' disabled' : '')} style={{ gridColumn: '1 / -1' }}>
              <Icon name="import" size={20} /><b>{busy === 'files' ? 'Importing…' : 'Import your writing'}</b><span>Pick .txt or .md files. Each manuscript becomes a story, split into scenes at <code>---</code> or headings; files with <code>name:</code> / <code>type:</code> frontmatter become sheets.</span>
              <input type="file" multiple accept=".txt,.md,.markdown" hidden disabled={!!busy} onChange={e => pickFiles(e.target.files)} />
            </label>
          </div>
          <p className="small muted">Have a whole folder? <label className="link">Import a folder of files<input type="file" hidden disabled={!!busy} {...{ webkitdirectory: '' }} onChange={e => pickFiles(e.target.files)} /></label>
            {' '}or <button className="link" disabled={!!busy} onClick={canonFolder}>{busy === 'canon' ? 'importing…' : 'a Canon story folder'}</button> (only read, never changed).</p>
        </div>}

        {cur === 1 && <div className="setup-card">
          <div><div className="setup-kick">STEP 2 OF 4</div><h1>Name the project</h1></div>
          <p className="lead muted">You can change all of this later in Settings.</p>
          <label className="field"><span className="lbl">Title</span><input className="f setup-title" autoFocus value={name.title} placeholder="Untitled project" onChange={e => setName({ ...name, title: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') create1() }} /></label>
          <label className="field"><span className="lbl">Logline</span><textarea className="f" value={name.logline} placeholder="The whole project in one sentence (optional)" onChange={e => setName({ ...name, logline: e.target.value })} /></label>
          <label className="field"><span className="lbl">Author</span><input className="f" value={name.author} placeholder="For the title page when you export (optional)" onChange={e => setName({ ...name, author: e.target.value })} /></label>
          <div className="setup-foot"><button className="btn ghost" onClick={() => onStep('')}>Back</button><span className="grow" /><button className="btn pri" disabled={!!busy} onClick={create1}>{busy === 'new' ? 'Creating…' : 'Continue'}</button></div>
        </div>}

        {cur === 2 && <div className="setup-card">
          <div><div className="setup-kick">STEP 3 OF 4 · OPTIONAL</div><h1>Connect an assistant</h1></div>
          <p className="lead muted">Canon works without one. With one, it can draft scenes from their cards, give feedback, check continuity against your canon and answer questions about it. Nothing it suggests changes your work until you accept it.</p>
          <div className="setup-prov">{(['chatgpt', 'openrouter', 'opencode-go'] as const).map(p => <ProviderRow key={p} p={p} auth={auth} big />)}</div>
          {auth.err && <div className="err">{auth.err}</div>}
          <div className="setup-what">
            {['Text edits arrive as suggestions in the text', 'Changes to the canon arrive as a list to apply', 'Feedback lands as notes in the margin', 'Problems it finds go to Questions'].map(t => <span key={t}><Spark size={14} />{t}</span>)}
          </div>
          <div className="setup-foot">
            <span className="grow small muted">{aiReady(ai) ? 'Connected. Pick other models any time in Settings › Assistant.' : 'Skip, and assistant buttons show a Connect prompt until you do. You can change this any time in Settings.'}</span>
            {!aiReady(ai) && <button className="btn" onClick={() => onStep(STEPS[3])}>Skip for now</button>}
            <button className="btn pri" onClick={() => onStep(STEPS[3])}>Continue</button>
          </div>
        </div>}

        {cur === 3 && <div className="setup-card">
          <div><div className="setup-kick">STEP 4 OF 4</div><h1>Where to start</h1></div>
          <p className="lead muted">Pick one; everything else stays a click away in the sidebar.</p>
          <div className="choices">
            <button className="choice" onClick={firstScene}><Icon name="write" size={20} /><b>Write a first scene</b><span>Open a blank page and write. The card, cast and canon can come later.</span></button>
            <button className="choice" onClick={sketch}><Icon name="person" size={20} /><b>Sketch the main characters</b><span>Start a character sheet: who they are, what they want, what they hide.</span></button>
            <button className="choice" onClick={outline}><Icon name="board" size={20} /><b>Outline a story</b><span>A premise, beats and scene cards before any prose.</span></button>
            <label className="choice"><Icon name="import" size={20} /><b>Import writing</b><span>Bring in .txt or .md files as stories and scenes.</span>
              <input type="file" multiple accept=".txt,.md,.markdown" hidden onChange={e => { const xs = [...(e.target.files || [])]; if (xs.length) finish(() => { importFiles(xs, m => showToast('Imported ' + m)).catch(er => showToast(String(er))); go('home') }) }} /></label>
          </div>
          <div className="setup-foot"><button className="btn ghost" onClick={() => onStep(STEPS[2])}>Back</button><span className="grow" /><button className="btn" onClick={() => finish(() => go('home'))}>Go to Home</button></div>
        </div>}

        {log.map((l, i) => <p key={i} className="small ok-text">✓ {l}</p>)}
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  )
}

