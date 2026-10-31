import { useEffect, useMemo, useState } from 'react'
import {
  update, create, tx, list, project, stories, scenesOf, allScenes, entities, typeIds, typeDef, words, totalWords, sessionWords, today, guidesFor, nameOf,
  LABELS, GUIDE_KINDS, type State, type Proposal, type MetaField, type FieldKind, type GuideKind, type Project,
} from '../store.ts'
import { slug } from '../schema.ts'
import { loadSettings, saveSettings, completeJSON, JOBS, type Settings, type Provider, type Job } from '../ai.ts'
import { projectFromBackground, normalizeProposal } from '../prompts.ts'
import { compile, FORMATS, type Format } from '../compile.ts'
import { Area, useJob, JobStatus, Proposals, PageHead, savedToast } from '../ui.tsx'
import { GuideRow } from './shared.tsx'

const TABS: [string, string][] = [['project', 'Project'], ['guides', 'Guides'], ['progress', 'Progress'], ['ai', 'AI'], ['export', 'Export & backup']]
const editProject = (fn: (x: Project) => void) => update<'project'>('project', fn)

export function ProjectView({ s, tab = 'project' }: { s: State; tab?: string }) {
  return (
    <>
      <PageHead title={project(s).title || 'Project'} sub="Project settings, guides, progress, AI and export">
        <div className="seg">{TABS.map(([id, l]) => <button key={id} className={tab === id ? 'on' : ''} onClick={() => { location.hash = 'project/' + id }}>{l}</button>)}</div>
      </PageHead>
      <div className="body" style={{ maxWidth: 900, width: '100%', margin: '0 auto' }}>
        {tab === 'project' && <ProjectForm s={s} />}
        {tab === 'guides' && <Guides s={s} />}
        {tab === 'progress' && <Progress s={s} />}
        {tab === 'ai' && <AI />}
        {tab === 'export' && <Export s={s} />}
      </div>
    </>
  )
}

// ---------------- project ----------------

const KINDS: { id: FieldKind; label: string }[] = [{ id: 'text', label: 'Text' }, { id: 'check', label: 'Checkbox' }, { id: 'list', label: 'Choice' }, { id: 'date', label: 'Date' }]

function ProjectForm({ s }: { s: State }) {
  const p = project(s)
  const job = useJob()
  const [props, setProps] = useState<Proposal[]>([])
  const fill = () => job.run('Reading the background…', async sig => setProps((await completeJSON<Proposal[]>('assist', projectFromBackground(s), sig)).map(x => normalizeProposal(s, x))))
  const fields = p.sceneFields || []
  const setField = (i: number, patch: Partial<MetaField>) => editProject(x => { x.sceneFields![i] = { ...x.sceneFields![i], ...patch } })
  return (
    <>
      <div className="card">
        <h3>The project</h3>
        <div className="row" style={{ alignItems: 'start' }}>
          <div style={{ flex: '2 1 280px' }}><Area label="Title" single value={p.title} onChange={v => editProject(x => { x.title = v })} /></div>
          <div style={{ flex: '1 1 180px' }}><Area label="Author (for export)" single value={p.author || ''} onChange={v => editProject(x => { x.author = v })} /></div>
        </div>
        <Area label="Logline" value={p.logline} placeholder="The whole project in one sentence" onChange={v => editProject(x => { x.logline = v })} />
        <Area label="Thesis" value={p.thesis} placeholder="What the work argues, or asks" onChange={v => editProject(x => { x.thesis = v })} />
        <p className="small muted">Tone, motifs and writing conventions are <a href="#project/guides">guides</a>, so they can apply to the whole project, one story or one character.</p>
      </div>
      <div className="card">
        <div className="row"><h3>Background</h3><span className="grow" />
          {p.background.trim() && <button className="btn sm soft" disabled={!!job.busy} onClick={fill}>✦ Fill from background</button>}</div>
        <p className="small muted">Free-form reference sent with builds and checks. Structured canon overrides it where they disagree.</p>
        <JobStatus job={job} />
        <Proposals s={s} items={props} onChange={setProps} />
        <textarea className="f" style={{ minHeight: 260 }} value={p.background} aria-label="Background" onChange={e => editProject(x => { x.background = e.target.value })} />
      </div>
      <div className="card">
        <h3>Scenes</h3>
        <div className="field"><span className="lbl">Label names</span>
          <div className="row">{LABELS.map(l => (
            <label key={l} className="row nowrap" style={{ flex: '1 1 130px' }}><i className="dot" style={{ background: `var(--l-${l})`, width: 12, height: 12 }} />
              <input className="f" value={p.labels?.[l] || ''} placeholder={l} aria-label={`Name for ${l}`} onChange={e => editProject(x => { x.labels = { ...x.labels, [l]: e.target.value } })} /></label>
          ))}</div></div>
        <div className="field"><span className="lbl">Custom fields · shown on every scene’s plan</span>
          {fields.map((f, i) => (
            <div key={i} className="row nowrap">
              <input className="f" value={f.label} placeholder="Field name" aria-label="Field name" onChange={e => setField(i, { label: e.target.value, key: f.key || slug(e.target.value) })} />
              <select className="f" style={{ width: 130 }} value={f.kind} aria-label="Kind" onChange={e => setField(i, { kind: e.target.value as FieldKind })}>{KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
              {f.kind === 'list' && <input className="f" value={(f.options || []).join(', ')} placeholder="Choices, comma-separated" aria-label="Choices" onChange={e => setField(i, { options: e.target.value.split(',').map(o => o.trimStart()) })} />}
              <button className="btn sm ghost danger" aria-label="Remove field" onClick={() => tx('Remove scene field', () => editProject(x => { x.sceneFields!.splice(i, 1) }))}>×</button>
            </div>
          ))}
          <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => tx('Add scene field', () => editProject(x => { x.sceneFields = [...(x.sceneFields || []), { key: 'field-' + ((x.sceneFields || []).length + 1), label: '', kind: 'text' }] }), false)}>Add field</button>
        </div>
        <label className="row nowrap small"><input type="checkbox" checked={!!p.emDashCheck} onChange={e => editProject(x => { x.emDashCheck = e.target.checked })} />Flag em dashes used as prose punctuation</label>
      </div>
    </>
  )
}

// ---------------- guides ----------------

function scopeName(s: State, scope: string) {
  if (scope === 'project') return 'Whole project'
  if (scope === 'form:documents') return 'In-world documents'
  const [k, id] = scope.split(':')
  if (k === 'type') return `Every ${typeDef(s, id).one.toLowerCase()}`
  return nameOf(s, id) || 'Missing'
}

function Guides({ s }: { s: State }) {
  const used = new Set(list(s, 'guide').map(g => g.scope))
  const scopes = ['project', 'form:documents', ...stories(s).map(x => 'story:' + x.id), ...typeIds(s).map(t => 'type:' + t), ...entities(s).map(e => 'entity:' + e.id)]
  const shown = scopes.filter(sc => sc === 'project' || sc === 'form:documents' || sc.startsWith('story:') || used.has(sc))
  const [scope, setScope] = useState('project')
  const [kind, setKind] = useState<GuideKind>('style')
  const add = (sc: string, k: GuideKind) => tx('Add guide', () => { create('guide', { use: k, scope: sc, title: GUIDE_KINDS.find(x => x.id === k)!.label, text: '' }) }, false)
  return (
    <>
      <div className="card">
        <h3>Guides</h3>
        <p className="small muted">Instructions for builds and checks. Each applies within its scope: the whole project, one story, every entity of a type, or one entity (a character’s voice is a style guide scoped to them).</p>
        <div className="stack" style={{ gap: 4 }}>{GUIDE_KINDS.map(k => <span key={k.id} className="small"><b>{k.label}</b> <span className="muted">{k.hint}</span></span>)}</div>
        <div className="row nowrap">
          <select className="f" value={scope} aria-label="Scope" onChange={e => setScope(e.target.value)}>{scopes.map(sc => <option key={sc} value={sc}>{scopeName(s, sc)}</option>)}</select>
          <select className="f" style={{ width: 190 }} value={kind} aria-label="Kind" onChange={e => setKind(e.target.value as GuideKind)}>{GUIDE_KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
          <button className="btn" onClick={() => add(scope, kind)}>Add guide</button>
        </div>
      </div>
      {shown.map(sc => {
        const gs = guidesFor(s, sc)
        return (
          <div key={sc} className="card">
            <div className="row"><h3>{scopeName(s, sc)}</h3><span className="grow" /><button className="btn sm ghost" onClick={() => add(sc, 'rule')}>+ Rule</button><button className="btn sm ghost" onClick={() => add(sc, 'style')}>+ Style</button></div>
            {!gs.length && <p className="small muted">None yet.</p>}
            {gs.map(g => <GuideRow key={g.id} g={g} />)}
          </div>
        )
      })}
    </>
  )
}

// ---------------- progress ----------------

const STOP = new Set('the a an and or but of to in on at for with as by from is was were be been are it its it’s he she they them his her their i you we me my your our that this these those there then than so not no if into out up down over just had has have do did does said says what when where who which while one all about like back him would could will can only now’s don’t didn’t'.split(' '))
const days = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 864e5)

function Progress({ s }: { s: State }) {
  const p = project(s)
  const total = totalWords(s), todayWords = sessionWords(s)
  const left = p.deadline ? days(today(), p.deadline) : undefined
  const perDay = p.target && left && left > 0 ? Math.ceil(Math.max(0, p.target - total) / left) : undefined
  const hist = useMemo(() => {
    const byDate = new Map(list(s, 'day').map(d => [d.date, Math.max(0, d.words - d.start)]))
    return Array.from({ length: 30 }, (_, i) => { const d = new Date(Date.now() - (29 - i) * 864e5).toLocaleDateString('sv'); return { d, n: byDate.get(d) || 0 } })
  }, [s])
  const max = Math.max(1, ...hist.map(h => h.n))
  const freq = useMemo(() => {
    const m = new Map<string, number>()
    for (const sc of allScenes(s)) for (const w of sc.prose.toLowerCase().match(/[a-z’']{3,}/g) || []) if (!STOP.has(w)) m.set(w, (m.get(w) || 0) + 1)
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 30)
  }, [s])
  const num = (v: number | undefined, fn: (n: number | undefined) => void, label: string, step = 1000) =>
    <label className="field"><span className="lbl">{label}</span><input className="f" type="number" min={0} step={step} value={v || ''} onChange={e => fn(Number(e.target.value) || undefined)} /></label>
  return (
    <>
      <div className="card">
        <h3>Targets</h3>
        <div className="grid3">
          {num(p.target, n => editProject(x => { x.target = n }), 'Project target (words)')}
          <label className="field"><span className="lbl">Deadline</span><input className="f" type="date" value={p.deadline || ''} onChange={e => editProject(x => { x.deadline = e.target.value || undefined })} /></label>
          {num(p.sessionTarget, n => editProject(x => { x.sessionTarget = n }), 'Daily target (words)', 100)}
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <div className="row"><b>{total.toLocaleString()}</b><span className="muted">{p.target ? `of ${p.target.toLocaleString()} words` : 'words'}</span></div>
          {p.target ? <div className="bar"><i style={{ width: Math.min(100, (total / p.target) * 100) + '%' }} /></div> : null}
          <div className="row"><b>{todayWords.toLocaleString()}</b><span className="muted">{p.sessionTarget ? `of ${p.sessionTarget.toLocaleString()} today` : 'words today'}</span></div>
          {p.sessionTarget ? <div className="bar"><i style={{ width: Math.min(100, (Math.max(0, todayWords) / p.sessionTarget) * 100) + '%' }} /></div> : null}
          {left !== undefined && <p className="small muted">{left < 0 ? `The deadline passed ${-left} days ago.` : `${left} days left${perDay !== undefined ? `: about ${perDay.toLocaleString()} words a day to reach the target` : ''}.`}</p>}
        </div>
      </div>
      <div className="card">
        <h3>Stories</h3>
        {stories(s).map(st => {
          const w = scenesOf(s, st.id).reduce((n, sc) => n + words(sc.prose), 0)
          return (
            <div key={st.id} className="row nowrap">
              <a className="grow clip" href={'#story/' + st.id}>{st.title}</a>
              <span className="small muted" style={{ minWidth: 110, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{w.toLocaleString()}{st.target ? ` / ${st.target.toLocaleString()}` : ''}</span>
              {stories(s).some(x => x.target) && (st.target ? <div className="bar" style={{ width: 120 }}><i style={{ width: Math.min(100, (w / st.target) * 100) + '%' }} /></div> : <span style={{ width: 120 }} />)}
            </div>
          )
        })}
        {!stories(s).length && <p className="small muted">No stories yet.</p>}
      </div>
      <div className="card">
        <h3>Writing history · last 30 days</h3>
        {hist.every(h => !h.n) ? <p className="small muted">Nothing recorded yet. Every day you write, the words you add show up here.</p> : <div className="hist">{hist.map(h => <i key={h.d} title={`${h.d}: ${h.n.toLocaleString()} words`} style={{ height: Math.max(2, (h.n / max) * 100) + '%', opacity: h.n ? .8 : .15 }} />)}</div>}
        <p className="small muted">Words added per day, counted from saves. Deleting text counts as zero.</p>
      </div>
      <div className="card">
        <h3>Most used words</h3>
        {freq.length ? <div className="row" style={{ gap: 5 }}>{freq.map(([w, n]) => <span key={w} className="chip">{w} <span className="muted">{n}</span></span>)}</div> : <p className="small muted">No prose yet.</p>}
      </div>
    </>
  )
}

// ---------------- AI ----------------

const PROVIDERS: { id: Provider; name: string }[] = [{ id: 'chatgpt', name: 'ChatGPT' }, { id: 'opencode-go', name: 'OpenCode Go' }, { id: 'openrouter', name: 'OpenRouter' }]

function AI() {
  const [status, setStatus] = useState<Record<string, boolean>>({})
  const [cfg, setCfg] = useState<Settings>()
  const [models, setModels] = useState<Record<string, string[]>>({})
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [waiting, setWaiting] = useState('')
  const [err, setErr] = useState('')
  const refresh = () => fetch('/api/auth/status').then(r => r.json()).then(setStatus)
  useEffect(() => { refresh(); loadSettings().then(setCfg) }, [])
  useEffect(() => { const f = () => refresh(); addEventListener('canon:notify', f); return () => removeEventListener('canon:notify', f) }, []) // a browser sign-in finished
  useEffect(() => {
    for (const p of PROVIDERS) if (status[p.id] && !models[p.id])
      fetch('/api/models?provider=' + p.id).then(r => (r.ok ? r.json() : [])).then((ids: string[]) => setModels(m => ({ ...m, [p.id]: ids })))
  }, [status]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // poll while a browser sign-in is open
    if (!waiting) return
    const t = setInterval(async () => { const st = await (await fetch('/api/auth/status')).json(); setStatus(st); if (st[waiting]) setWaiting('') }, 2000)
    const stop = setTimeout(() => setWaiting(''), 5 * 60_000)
    return () => { clearInterval(t); clearTimeout(stop) }
  }, [waiting])
  const signIn = async (p: 'chatgpt' | 'openrouter') => {
    setErr('')
    const r = await fetch('/api/auth/' + p, { method: 'POST' }) // the shell opens the sign-in page in your browser
    if (!r.ok) { setErr(await r.text()); return }
    setWaiting(p)
  }
  const saveKey = async (p: Provider) => {
    setErr('')
    const r = await fetch('/api/auth/key', { method: 'PUT', body: JSON.stringify({ provider: p, key: keys[p] }) })
    if (!r.ok) { setErr(await r.text()); return }
    setKeys(k => ({ ...k, [p]: '' })); refresh()
  }
  const signOut = async (p: Provider) => { await fetch('/api/auth/' + p, { method: 'DELETE' }); setModels(m => ({ ...m, [p]: [] })); refresh() }
  const setJob = (job: Job, patch: Partial<Settings['jobs'][Job]>) => {
    const next = { jobs: { ...cfg!.jobs, [job]: { ...cfg!.jobs[job], ...patch } } }
    setCfg(next); saveSettings(next)
  }
  const keyBox = (p: Provider, placeholder: string) => (
    <div className="row nowrap">
      <input className="f" type="password" autoComplete="off" value={keys[p] || ''} placeholder={placeholder} aria-label="API key" onChange={e => setKeys(k => ({ ...k, [p]: e.target.value }))} />
      <button className="btn" disabled={!keys[p]?.trim()} onClick={() => saveKey(p)}>Save</button>
    </div>
  )
  const Status = ({ p }: { p: Provider }) => <span className="small" style={{ color: status[p] ? 'var(--ok)' : waiting === p ? 'var(--accent)' : 'var(--faint)' }}>{status[p] ? 'Connected' : waiting === p ? 'Waiting for the browser…' : 'Not connected'}</span>
  return (
    <>
      {err && <div className="err">{err}<button className="x" aria-label="Dismiss" onClick={() => setErr('')}>×</button></div>}
      <div className="prov">
        <div className="card">
          <div className="row"><h3>ChatGPT</h3><span className="grow" /><Status p="chatgpt" /></div>
          <p className="small muted">Uses your ChatGPT plan's model allowance. Canon only gets permission to call models: it can't read your chats, memory or account settings. Usage counts against your plan's limits.</p>
          {status.chatgpt ? <button className="btn sm danger" style={{ justifySelf: 'start' }} onClick={() => signOut('chatgpt')}>Sign out</button>
            : <button className="btn pri" style={{ justifySelf: 'start' }} onClick={() => signIn('chatgpt')}>Sign in with ChatGPT</button>}
        </div>
        <div className="card">
          <div className="row"><h3>OpenCode Go</h3><span className="grow" /><Status p="opencode-go" /></div>
          <p className="small muted">Paste your OpenCode Go API key from opencode.ai. It's stored only on this machine.</p>
          {status['opencode-go'] ? <button className="btn ghost danger" style={{ justifySelf: 'start' }} onClick={() => signOut('opencode-go')}>Remove key</button> : keyBox('opencode-go', 'OpenCode Go key')}
        </div>
        <div className="card">
          <div className="row"><h3>OpenRouter</h3><span className="grow" /><Status p="openrouter" /></div>
          <p className="small muted">Connect with your OpenRouter account (Canon gets its own key you can revoke there), or paste a key.</p>
          {status.openrouter ? <button className="btn ghost danger" style={{ justifySelf: 'start' }} onClick={() => signOut('openrouter')}>Disconnect</button>
            : <><button className="btn pri" style={{ justifySelf: 'start' }} onClick={() => signIn('openrouter')}>Connect OpenRouter</button>{keyBox('openrouter', 'or paste sk-or-… key')}</>}
        </div>
      </div>
      <div className="card">
        <h3>Models</h3>
        <p className="small muted">Pick a model per kind of work. Prose builds deserve your best model; assist jobs can use a faster one.</p>
        {cfg && JOBS.map(j => {
          const m = cfg.jobs[j.id]
          return (
            <div key={j.id} className="job">
              <div><b>{j.label}</b><p className="small muted">{j.hint}</p></div>
              <select className="f" value={m.provider} aria-label={`${j.label} provider`} onChange={e => setJob(j.id, { provider: e.target.value as Provider, model: '' })}>
                {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}{status[p.id] ? '' : ' (not connected)'}</option>)}
              </select>
              <input className="f" list={'models-' + m.provider} value={m.model} placeholder={status[m.provider] ? 'Choose or type a model id' : 'Connect the provider first'} aria-label={`${j.label} model`}
                onChange={e => setJob(j.id, { model: e.target.value })} />
              {m.provider === 'chatgpt' ? <select className="f" value={m.effort || 'medium'} aria-label={`${j.label} reasoning effort`} onChange={e => setJob(j.id, { effort: e.target.value })}>
                {['low', 'medium', 'high', 'xhigh'].map(x => <option key={x} value={x}>{x} effort</option>)}</select> : <span />}
            </div>
          )
        })}
        {PROVIDERS.map(p => <datalist key={p.id} id={'models-' + p.id}>{(models[p.id] || []).map(id => <option key={id} value={id} />)}</datalist>)}
      </div>
    </>
  )
}

// ---------------- export ----------------

function Export({ s }: { s: State }) {
  const sts = stories(s)
  const [pick, setPick] = useState<string[]>(() => sts.map(x => x.id))
  const [fmt, setFmt] = useState<Format>('epub')
  const [o, setO] = useState({ sceneTitles: false, storyTitles: true, titlePage: sts.length > 1, separator: '* * *' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const excluded = allScenes(s).filter(sc => pick.includes(sc.story) && sc.exclude && sc.prose.trim()).length
  const [info, setInfo] = useState<{ dataDir: string; backups: string }>()
  useEffect(() => { fetch('/api/info').then(r => r.json()).then(setInfo) }, [])
  const backup = async () => { try { savedToast((await (await fetch('/api/backup', { method: 'POST' })).json()).path) } catch (e) { setErr(String(e)) } }
  const reveal = (path: string) => fetch('/api/reveal', { method: 'POST', body: JSON.stringify({ path }) })
  const check = (k: 'sceneTitles' | 'storyTitles' | 'titlePage', label: string) => <label className="row nowrap small"><input type="checkbox" checked={o[k]} onChange={e => setO({ ...o, [k]: e.target.checked })} />{label}</label>
  return (
    <>
      <div className="card">
        <h3>Export</h3>
        <div className="stack" style={{ gap: 4 }}>{sts.map(st => (
          <label key={st.id} className="row nowrap"><input type="checkbox" checked={pick.includes(st.id)} onChange={() => setPick(p => sts.map(x => x.id).filter(x => (x === st.id ? !p.includes(x) : p.includes(x))))} />{st.title}</label>
        ))}</div>
        {excluded > 0 && <p className="small muted">{excluded} scene{excluded === 1 ? ' is' : 's are'} marked “leave out of export” and will be skipped.</p>}
        <div className="row" style={{ gap: 16 }}>{check('titlePage', 'Title page')}{check('storyTitles', 'Story titles')}{check('sceneTitles', 'Scene titles')}
          <label className="row nowrap small" style={{ gap: 6, marginLeft: 8 }}><span className="muted">Separator</span><input className="f" style={{ width: 72, padding: '3px 8px', textAlign: 'center' }} value={o.separator} aria-label="Scene separator" onChange={e => setO({ ...o, separator: e.target.value })} /></label></div>
        <div className="row">
          <div className="seg">{FORMATS.map(f => <button key={f.id} className={fmt === f.id ? 'on' : ''} onClick={() => setFmt(f.id)}>{f.label}</button>)}</div>
          <button className="btn pri" disabled={!pick.length || busy} onClick={() => { setErr(''); setBusy(true); compile(s, pick, fmt, o).then(p => savedToast(p || ''), e => setErr(String(e).replace(/^Error: /, ''))).finally(() => setBusy(false)) }}>{busy ? 'Exporting…' : 'Export…'}</button>
        </div>
        {fmt === 'epub' && <p className="small muted">EPUB always keeps story titles: readers build the table of contents from them.</p>}
        {err && <div className="err">{err}</div>}
      </div>
      <div className="card">
        <h3>Backup</h3>
        <p className="small muted">Canon keeps everything in one database file and copies it on every start, keeping the last 10 in a backups folder next to it. Every change is also kept in the history, so undo reaches back across restarts.</p>
        <div className="row">
          <button className="btn" onClick={backup}>Save a JSON backup…</button>
          {info && <button className="btn ghost" onClick={() => reveal(info.dataDir + '/canon.db')}>Show the database</button>}
          {info && <button className="btn ghost" onClick={() => reveal(info.backups)}>Show backups</button>}
        </div>
        {info && <p className="small faint mono">{info.dataDir}</p>}
      </div>
    </>
  )
}
