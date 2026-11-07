// First run: welcome, name the project, connect an assistant, where to start.
import { useState } from 'react'
import { create, tx, baseline, newScene, newEntityData, typeIds, typeDef, getState, list, stories, type State, type Kind } from '../store.ts'
import { Icon, Spark, go } from '../ui.tsx'
import { useAI, aiReady } from '../ai.ts'
import { importCanonFolder } from '../importer.ts'
import { newStory } from '../scenes.ts'
import { sampleRecords } from '../sample.ts'
import { ProviderRow, useProviderSignIn } from './Settings.tsx'
import { ImportDialog } from './Import.tsx'
import { TemplatePicker, templateById } from './Projects.tsx'

const STEPS = ['Welcome', 'Name the project', 'Connect an assistant', 'Where to start']

export function Setup({ s, step, onStep }: { s: State; step: string; onStep: (st: string) => void }) {
  const [log, setLog] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [name, setName] = useState({ title: '', logline: '', author: '' })
  const [tpl, setTpl] = useState('novel')
  const [importing, setImporting] = useState(false)
  const ai = useAI()
  const auth = useProviderSignIn()
  const cur = s.recs.project ? Math.max(1, STEPS.indexOf(step)) : step === STEPS[1] ? 1 : 0
  const run = async (what: string, fn: () => Promise<unknown>, after = '') => {
    setBusy(what); setErr('')
    try { await fn(); onStep(after); if (!after) location.hash = 'home' } catch (e) { setErr(String(e).replace(/^Error: /, '')) }
    setBusy('')
  }
  const canonFolder = () => run('canon', async () => {
    const { picked } = await (await fetch('/api/root', { method: 'POST' })).json()
    if (!picked) throw new Error('')
    await importCanonFolder(m => setLog(l => [...l, m]))
  })
  const sample = () => run('sample', () => baseline(sampleRecords() as { kind: Kind; id: string; data: Record<string, unknown> }[]))
  // The template lays out the first stories and chapters; with an existing project (Back from a later step) only the details change.
  const create1 = () => run('new', () => {
    if (!s.recs.project) return baseline(templateById(tpl).build(name))
    const { id: _i, kind: _k, ...p } = s.recs.project
    return baseline([{ kind: 'project', id: 'project', data: { ...p, title: name.title.trim() || 'Untitled project', logline: name.logline.trim(), author: name.author.trim() || undefined } }])
  }, STEPS[2])
  const finish = (to: () => void) => { onStep(''); to() }
  const firstScene = () => finish(() => {
    const st = getState(), sc = stories(st).map(x => list(st, 'scene').filter(y => y.story === x.id).sort((a, b) => a.order - b.order)[0]).find(Boolean)
    if (sc) return go('scene/' + sc.id) // the template made one
    let id = ''
    tx('First scene', () => { const st = create('story', { title: 'Untitled story', order: 1, form: 'prose', premise: '', beats: [] }); id = create('scene', newScene(st, 1, { title: 'Untitled scene' })) }, false)
    go('scene/' + id)
  })
  const sketch = () => finish(() => { const t = typeIds(getState()).includes('character') ? 'character' : typeIds(getState())[0]; let id = ''; tx('New character', () => { id = create('entity', newEntityData(t, 'New ' + typeDef(getState(), t).one.toLowerCase())) }, false); go('world/' + id) })
  const outline = () => finish(() => { const st = stories(getState())[0]; if (st) go('story/' + st.id); else newStory() })
  const imported = (route: string) => { setImporting(false); finish(() => go(route)) }
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
            <button className="choice" disabled={!!busy} style={{ gridColumn: '1 / -1' }} onClick={() => setImporting(true)}>
              <Icon name="import" size={20} /><b>Import your writing</b><span>Word, RTF, OpenDocument, Markdown or text files, a folder of them, or a whole Scrivener project with its synopses, notes, labels and research. You see what it becomes before anything is added.</span>
            </button>
          </div>
          <p className="small muted">Have a Canon story folder from the command-line version? <button className="link" disabled={!!busy} onClick={canonFolder}>{busy === 'canon' ? 'Importing…' : 'Import it'}</button> (only read, never changed).</p>
        </div>}

        {cur === 1 && <div className="setup-card">
          <div><div className="setup-kick">STEP 2 OF 4</div><h1>Name the project</h1></div>
          <p className="lead muted">You can change all of this later in Settings.</p>
          <label className="field"><span className="lbl">Title</span><input className="f setup-title" autoFocus value={name.title} placeholder="Untitled project" onChange={e => setName({ ...name, title: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') create1() }} /></label>
          <label className="field"><span className="lbl">Logline</span><textarea className="f" value={name.logline} placeholder="The whole project in one sentence (optional)" onChange={e => setName({ ...name, logline: e.target.value })} /></label>
          <label className="field"><span className="lbl">Author</span><input className="f" value={name.author} placeholder="For the title page when you export (optional)" onChange={e => setName({ ...name, author: e.target.value })} /></label>
          {!s.recs.project && <div className="field"><span className="lbl">Start from</span><TemplatePicker value={tpl} onChange={setTpl} /></div>}
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
            <button className="choice" onClick={() => setImporting(true)}><Icon name="import" size={20} /><b>Import writing</b><span>Word, Scrivener, Markdown and more, as stories, chapters and scenes.</span></button>
          </div>
          <div className="setup-foot"><button className="btn ghost" onClick={() => onStep(STEPS[2])}>Back</button><span className="grow" /><button className="btn" onClick={() => finish(() => go('home'))}>Go to Home</button></div>
        </div>}

        {log.map((l, i) => <p key={i} className="small ok-text">✓ {l}</p>)}
        {importing && <ImportDialog s={s} onClose={() => setImporting(false)} onDone={imported} />}
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  )
}

