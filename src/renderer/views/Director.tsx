import { useEffect, useState } from 'react'
import { create, remove, tx, list, get, getState, update, nameOf, notesFor, newNote, type State, type Note } from '../store.ts'
import { directorSystem, screenContext } from '../prompts.ts'
import { loadSettings, modelFor } from '../ai.ts'
import { useJob, JobStatus, Popover, Icon, MOD } from '../ui.tsx'
import { ChatPane, RecordPicker, hrefOf } from './shared.tsx'
import { direct, locate, critique } from './Write.tsx'

// An ask can arrive while the pane is closed (it opens on the same event); keep it for the pane to pick up.
let pendingAsk: string | undefined
addEventListener('canon:ask', e => { pendingAsk = (e as CustomEvent<string>).detail })

const newChat = () => {
  let id = ''
  tx('New conversation', () => { id = create('chat', { mode: 'assistant', title: 'New conversation', messages: [], at: new Date().toISOString() }) }, false)
  return id
}

/** Records the current screen is about: they ride along with every message. */
function routeContext(s: State, route: string): string[] {
  const [view, a, b] = route.split('/')
  if (view === 'write') { const sc = get(s, b, 'scene'); return sc ? [sc.id, ...sc.cast.slice(0, 4), ...Object.keys(sc.links).slice(0, 4)] : a ? [a] : [] }
  if (['world', 'timeline', 'story', 'questions'].includes(view) && a && s.recs[a]) return [a]
  return []
}

export function Director({ s, route, onClose }: { s: State; route: string; onClose: () => void }) {
  const chats = list(s, 'chat').filter(c => c.mode === 'assistant').sort((a, b) => b.at.localeCompare(a.at))
  const [cid, setCid] = useState<string | undefined>(chats[0]?.id)
  const [queued, setQueued] = useState<string | undefined>(() => { const q = pendingAsk; pendingAsk = undefined; return q })
  const [pinned, setPinned] = useState<string[]>([])
  const [tab, setTab] = useState<'director' | 'notes'>('director')
  const [view, , sceneId] = route.split('/')
  const scene = view === 'write' ? get(s, sceneId, 'scene') : undefined
  const notes = scene ? notesFor(s, scene.id) : []
  const open = notes.filter(n => !n.done).length
  const ctx = routeContext(s, route)
  const [model, setModel] = useState(modelFor('chat').model)
  useEffect(() => { loadSettings().then(c => setModel(c.jobs.chat.model)) }, [route])
  useEffect(() => { if (!cid || !s.recs[cid]) setCid(chats[0]?.id || newChat()) }, [cid, s.recs, chats])
  useEffect(() => {
    const ask = (e: Event) => { setTab('director'); setQueued((e as CustomEvent<string>).detail); pendingAsk = undefined }
    const showNotes = () => setTab('notes')
    addEventListener('canon:ask', ask); addEventListener('canon:notes', showNotes)
    return () => { removeEventListener('canon:ask', ask); removeEventListener('canon:notes', showNotes) }
  }, [])
  useEffect(() => { if (!scene && tab === 'notes') setTab('director') }, [scene, tab])
  return (
    <aside className="director" aria-label="Assistant">
      <div className="director-h">
        <div className="row nowrap">
          {scene ? <div className="seg">
            <button className={tab === 'director' ? 'on' : ''} onClick={() => setTab('director')}>Assistant</button>
            <button className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>Notes{open ? ` · ${open}` : ''}</button>
          </div> : <b>Assistant</b>}
          <span className="grow" />
          <button className="icon-btn" aria-label="Close the assistant" title={`Close (${MOD}J)`} onClick={onClose}><Icon name="close" /></button>
        </div>
        {tab === 'director' && <>
          <div className="row nowrap" style={{ gap: 4 }}>
            <select className="f chip-select grow" style={{ maxWidth: 'none' }} value={cid || ''} aria-label="Conversation" onChange={e => setCid(e.target.value)}>
              {chats.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
            <button className="btn sm ghost" title="New conversation" onClick={() => setCid(newChat())}><Icon name="plus" size={14} />New</button>
            {chats.length > 1 && cid && <Popover className="right" trigger={o => <button className="icon-btn sm" aria-label="More" onClick={o}><Icon name="more" size={14} /></button>}>{close => <button className="menu-item danger" onClick={() => { close(); tx('Delete conversation', () => remove(cid)); setCid(chats.find(c => c.id !== cid)?.id) }}>Delete this conversation</button>}</Popover>}
          </div>
          <div className="context" title="What the assistant sees besides the whole canon">
            <span className="lbl">Sees</span>
            {ctx.map(id => <a key={id} className="chip" href={'#' + hrefOf(s, id)} title="From the screen you're on">{nameOf(s, id)}</a>)}
            {pinned.filter(id => s.recs[id] && !ctx.includes(id)).map(id => <span key={id} className="chip on">{nameOf(s, id)}<button className="x" style={{ fontSize: 13, padding: 0, color: 'inherit' }} aria-label="Remove from context" onClick={() => setPinned(p => p.filter(x => x !== id))}>×</button></span>)}
            <RecordPicker s={s} label="+ Add" exclude={[...ctx, ...pinned]} onPick={id => setPinned(p => [...p, id])} />
          </div>
        </>}
      </div>
      <div className="director-body">
        {tab === 'notes' && scene ? <Notes s={s} sceneId={scene.id} notes={notes} />
          : cid && s.recs[cid] && <ChatPane key={cid} s={s} chatId={cid} proposals queued={queued} onQueued={() => setQueued(undefined)} autoFocus={false}
            system={() => { const st = getState(); return directorSystem(st, screenContext(st, location.hash.slice(1), [...routeContext(st, location.hash.slice(1)).slice(1), ...pinned])) }}
            placeholder="Ask about your canon, or say what to change…"
            empty={<div className="stack muted small">
              <p>An AI that has read your whole canon and sees the screen you're on. Ask it anything, brainstorm, or tell it what to change.</p>
              <p>Changes come back as proposals: text edits appear in the document as tracked changes, and nothing changes until you accept it.</p>
              <p>When it spots a plot hole or a contradiction it raises a question instead of quietly fixing it.</p>
            </div>}
            footer={<a className="model" href="#project/ai" title="The model the assistant uses. Change it in Settings › AI, under Conversations.">{model || 'Choose a model'}</a>}
            starters={scene ? ['What is this scene missing?', 'Tighten the ending', 'Does anyone know something they shouldn’t here?'] : ['What are the weakest points in the story so far?', 'Which questions block the next scene?', 'Who knows what by the end?']} />}
      </div>
    </aside>
  )
}

const SEV: Record<string, string> = { critical: 'bad', error: 'bad', warning: 'warn', note: '' }

function Notes({ s, sceneId, notes }: { s: State; sceneId: string; notes: Note[] }) {
  const job = useJob()
  const [draft, setDraft] = useState('')
  const sc = get(s, sceneId, 'scene')!
  const done = (n: Note, v = true) => update<'note'>(n.id, x => { x.done = v })
  const fix = (n: Note) => {
    const at = locate(sc.prose, n.quote)
    if (!at) return job.setErr('That passage is no longer in the text. Select it by hand and direct it from the command bar.')
    job.run('Rewriting the passage…', sig => direct(sceneId, at[0], at[1], `Fix this: ${n.text}${n.fix ? `\nSuggested fix: ${n.fix}` : ''}`, sig)).then(() => done(n))
  }
  return (
    <div className="stack">
      <div className="row">
        <button className="btn sm soft" disabled={!!job.busy || !sc.prose.trim()} onClick={() => job.run('Reading the scene as an editor…', sig => critique(sceneId, sig).then(() => undefined))}>✦ Critique</button>
        <span className="grow" /><span className="small muted">{notes.filter(n => !n.done).length} open</span>
      </div>
      <JobStatus job={job} />
      <div className="composer">
        <textarea value={draft} placeholder="A note on this scene (select text and use /comment to anchor one)" aria-label="New note" onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && draft.trim()) { e.preventDefault(); tx('Add note', () => { create('note', newNote(sceneId, { text: draft.trim() })) }, false); setDraft('') } }} />
      </div>
      {!notes.length && <p className="muted small">Notes collect here: yours, the assistant's critique, and continuity checks. Click a quote to find it in the text; Fix proposes a rewrite as a tracked change.</p>}
      {notes.map(n => (
        <div key={n.id} className={'card' + (n.done ? ' done' : n.by === 'check' ? ' ' + (SEV[n.severity || 'warning'] || '') : '')} style={{ padding: 12, gap: 6 }}>
          <div className="row"><span className={'kicker ' + (n.by === 'ai' ? 'ai' : SEV[n.severity || ''] || '')}>{n.by === 'you' ? 'You' : n.by === 'ai' ? `Assistant${n.topic ? ` · ${n.topic}` : ''}` : `Check · ${n.severity || 'warning'}`}</span>
            <span className="grow" /><button className="x hover-only" aria-label="Delete note" onClick={() => tx('Delete note', () => remove(n.id))}>×</button></div>
          {n.quote && <button className="opt" style={{ fontFamily: 'var(--f-prose)', fontSize: 14 }} title="Find in the text" onClick={() => dispatchEvent(new CustomEvent('canon:select', { detail: n.quote }))}>“{n.quote}”</button>}
          <span>{n.text}</span>
          {n.fix && <span className="muted small">Fix: {n.fix}</span>}
          <div className="row">
            {!n.done && n.quote && n.by !== 'you' && <button className="btn sm soft" disabled={!!job.busy} onClick={() => fix(n)}>✦ Fix</button>}
            <button className="btn sm ghost" onClick={() => done(n, !n.done)}>{n.done ? 'Reopen' : 'Done'}</button>
          </div>
        </div>
      ))}
    </div>
  )
}
