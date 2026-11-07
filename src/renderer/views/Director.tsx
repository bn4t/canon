import { useEffect, useRef, useState } from 'react'
import './assistant.css'
import { create, remove, tx, list, get, getState, update, nameOf, entities, eventCode, stories, scenesOf, type State, type Chat, type Proposal } from '../store.ts'
import { directorSystem, screenContext, interviewSystem, discoveries, normalizeProposal } from '../prompts.ts'
import { useAI, aiReady, modelFor, providerName, completeJSON } from '../ai.ts'
import { Popover, Icon, MOD, ConnectPrompt, ProposedChanges, Spark, useJob, JobStatus, openSettings, ago } from '../ui.tsx'
import { RecordPicker, hrefOf } from './shared.tsx'
import { ChatPane } from './Chat.tsx'

// An ask or an interview can arrive while the panel is closed (it opens on the same event); keep it for the panel to pick up.
let pendingAsk: string | undefined, pendingInterview: string | undefined
addEventListener('canon:ask', e => { pendingAsk = (e as CustomEvent<string>).detail })
addEventListener('canon:interview', e => { pendingInterview = (e as CustomEvent<string>).detail })

const byRecent = (a: Chat, b: Chat) => b.at.localeCompare(a.at)
const first = (name: string) => name.split(' ')[0]
const newChat = () => {
  let id = ''
  tx('New conversation', () => { id = create('chat', { mode: 'assistant', title: 'New conversation', messages: [], at: new Date().toISOString() }) }, false)
  return id
}
/** The latest interview with a character, or a new one. */
function interviewWith(s: State, entityId: string, fresh = false): string | undefined {
  const e = get(s, entityId, 'entity')
  if (!e) return
  const xs = list(s, 'chat').filter(c => c.mode === 'interview' && c.entity === entityId).sort(byRecent)
  if (xs[0] && !fresh) return xs[0].id
  let id = ''
  tx('New interview', () => { id = create('chat', { mode: 'interview', entity: e.id, asOf: xs[0]?.asOf, title: `Interview with ${first(e.name)}${xs.length ? ` (${xs.length + 1})` : ''}`, messages: [], at: new Date().toISOString() }) }, false)
  return id
}
const latestAssistant = (s: State) => list(s, 'chat').filter(c => c.mode === 'assistant').sort(byRecent)[0]?.id

/** Records the current screen is about: they ride along with every message. */
function routeContext(s: State, route: string): string[] {
  const [view, a, b] = route.split('/').map(decodeURIComponent)
  if (view === 'scene') { const sc = get(s, a, 'scene'); return sc ? [sc.id, ...sc.cast.slice(0, 4), ...Object.keys(sc.links).slice(0, 4)] : [] }
  if (view === 'write') { const sc = get(s, b, 'scene'); return sc ? [sc.id, ...sc.cast.slice(0, 4)] : a ? [a] : [] }
  if (['world', 'timeline', 'knowledge', 'story', 'questions', 'collection'].includes(view) && a && s.recs[a]) return [a]
  return []
}
const chipName = (s: State, id: string) => { const code = eventCode(s, id); if (code) return code; const n = nameOf(s, id); return n.length > 28 ? n.slice(0, 26) + '…' : n }
const characters = (s: State) => { const cs = entities(s, 'character'); return cs.length ? cs : entities(s) }

export function Director({ s, route, onClose }: { s: State; route: string; onClose: () => void }) {
  const ai = useAI()
  const chats = list(s, 'chat').sort(byRecent)
  const [cid, setCid] = useState<string | undefined>(() => {
    const st = getState()
    if (pendingInterview) { const id = interviewWith(st, pendingInterview); pendingInterview = undefined; if (id && !pendingAsk) return id }
    return latestAssistant(st)
  })
  const [queued, setQueued] = useState<string | undefined>(() => { const q = pendingAsk; pendingAsk = undefined; return q })
  const [pinned, setPinned] = useState<string[]>([])
  const cidRef = useRef(cid)
  cidRef.current = cid
  const chat = get(s, cid, 'chat')
  const ctx = routeContext(s, route)
  useEffect(() => { if (!cid || !s.recs[cid]) setCid(latestAssistant(getState()) || newChat()) }, [cid, s.recs])
  useEffect(() => {
    const ask = (e: Event) => {
      pendingAsk = undefined
      const cur = get(getState(), cidRef.current, 'chat')
      if (!cur || cur.mode !== 'assistant') setCid(latestAssistant(getState()) || newChat())
      setQueued((e as CustomEvent<string>).detail)
    }
    const interview = (e: Event) => { pendingInterview = undefined; const id = interviewWith(getState(), (e as CustomEvent<string>).detail); if (id) setCid(id) }
    addEventListener('canon:ask', ask); addEventListener('canon:interview', interview)
    return () => { removeEventListener('canon:ask', ask); removeEventListener('canon:interview', interview) }
  }, [])

  const m = modelFor('chat', ai)
  const footer = <button className="as-model" title="The model the assistant uses. Change it in Settings › Assistant." onClick={() => openSettings('assistant')}>{m.model ? `${m.model} · ${providerName(m.provider)}` : 'Choose a model'}</button>
  const above = !aiReady(ai, 'chat') ? <ConnectPrompt compact what="talk to the assistant" /> : undefined
  const isInterview = chat?.mode === 'interview'
  const ent = isInterview ? get(s, chat.entity, 'entity') : undefined
  const sceneRoute = route.split('/')[0] === 'scene'
  const suggest = characters(s).find(e => ctx.includes(e.id)) || characters(s)[0]

  return (
    <aside className="director as" aria-label="Assistant">
      <div className="director-h as-h">
        <div className="row nowrap">
          <Popover className="grow as-convo-anchor" trigger={o => (
            <button className="as-convo" onClick={o} aria-haspopup="menu" title="Conversations and interviews">
              {isInterview && <Icon name="person" size={14} />}<span className="clip grow">{chat?.title || 'New conversation'}</span><Icon name="down" size={12} />
            </button>
          )}>{close => <ConvoMenu s={s} chats={chats} cid={cid} onPick={id => { setCid(id); close() }} />}</Popover>
          <button className="icon-btn" title="New conversation" aria-label="New conversation" onClick={() => setCid(newChat())}><Icon name="plus" /></button>
          <button className="icon-btn" aria-label="Close the assistant" title={`Close (${MOD}J)`} onClick={onClose}><Icon name="close" /></button>
        </div>
        {isInterview ? <InterviewHead s={s} chat={chat} />
          : <div className="as-sees" title="What the assistant sees besides the whole canon">
            <span className="lbl">Sees</span>
            {ctx.map(id => <a key={id} className="chip" href={'#' + hrefOf(s, id)} title={nameOf(s, id)}>{chipName(s, id)}</a>)}
            {pinned.filter(id => s.recs[id] && !ctx.includes(id)).map(id => <span key={id} className="chip on" title={nameOf(s, id)}>{chipName(s, id)}<button className="x" aria-label="Remove from what it sees" onClick={() => setPinned(p => p.filter(x => x !== id))}>×</button></span>)}
            <RecordPicker s={s} label="+ Add" exclude={[...ctx, ...pinned]} onPick={id => setPinned(p => [...p, id])} />
          </div>}
      </div>
      {chat && (isInterview && ent ? <Interview key={chat.id} s={s} chat={chat} name={first(ent.name)} footer={footer} above={above} route={route} onBack={() => setCid(latestAssistant(getState()) || newChat())} />
        : <ChatPane key={chat.id} s={s} chatId={chat.id} proposals queued={queued} onQueued={() => setQueued(undefined)} autoFocus={false} route={route} footer={footer} above={above}
          system={() => { const st = getState(), r = location.hash.slice(1); return directorSystem(st, screenContext(st, r, [...routeContext(st, r).slice(1), ...pinned])) }}
          placeholder="Ask about your canon, or say what to change…"
          tools={suggest && <><span className="lbl">Interview a character:</span>
            <Popover trigger={o => <button className="chip dash" onClick={o}>@{first(suggest.name)}</button>}>{close => <div className="as-pick">
              {characters(s).map(e => <button key={e.id} className="menu-item" onClick={() => { close(); const id = interviewWith(getState(), e.id); if (id) setCid(id) }}>{e.name}</button>)}
            </div>}</Popover></>}
          empty={<div className="as-empty">
            <p>The assistant has read your whole canon and sees the screen you’re on. Ask it anything, think out loud, or tell it what to change.</p>
            <p>Edits to the text come back as suggestions in the editor. Changes to the canon come back as a list you can apply. Nothing changes until you accept it.</p>
            <p>When it spots a plot hole or a contradiction, it raises a question instead of quietly fixing it.</p>
          </div>}
          starters={sceneRoute ? ['What is this scene missing?', 'Tighten the ending', 'Does anyone know something they shouldn’t here?'] : ['What are the weakest points in the story so far?', 'Which questions block the next scene?', 'Who knows what by the end?']} />)}
    </aside>
  )
}

function ConvoMenu({ s, chats, cid, onPick }: { s: State; chats: Chat[]; cid?: string; onPick: (id: string) => void }) {
  const [who, setWho] = useState(false)
  const talks = chats.filter(c => c.mode === 'assistant'), interviews = chats.filter(c => c.mode === 'interview')
  const row = (c: Chat) => <button key={c.id} className={'menu-item as-convo-i' + (c.id === cid ? ' on' : '')} onClick={() => onPick(c.id)}>
    <span className="clip grow">{c.title}</span><span className="lbl">{c.messages.length ? ago(c.at) : 'empty'}</span></button>
  if (who) return <div className="as-pick">
    <span className="lbl as-pick-h">Interview a character</span>
    {characters(s).map(e => <button key={e.id} className="menu-item" onClick={() => { const id = interviewWith(getState(), e.id, true); if (id) onPick(id) }}>{e.name}</button>)}
    {!entities(s).length && <p className="small muted" style={{ padding: 8 }}>Add a character in World first.</p>}
  </div>
  return <div className="as-pick" style={{ width: 320 }}>
    <span className="lbl as-pick-h">Conversations</span>
    {talks.map(row)}
    {interviews.length > 0 && <><span className="lbl as-pick-h">Interviews</span>{interviews.map(row)}</>}
    <div className="menu-sep" />
    <button className="menu-item" onClick={() => onPick(newChat())}><Icon name="plus" size={14} />New conversation</button>
    <button className="menu-item" onClick={() => setWho(true)}><Icon name="person" size={14} />Interview a character…</button>
    {cid && <><div className="menu-sep" /><button className="menu-item danger" onClick={() => { const next = chats.find(c => c.id !== cid && c.mode === 'assistant')?.id; tx('Delete conversation', () => remove(cid)); onPick(next || newChat()) }}>Delete this conversation</button></>}
  </div>
}

function InterviewHead({ s, chat }: { s: State; chat: Chat }) {
  const e = get(s, chat.entity, 'entity')
  if (!e) return <div className="as-sees"><span className="lbl">This character was deleted.</span></div>
  return (
    <div className="as-sees as-iv">
      <span className="lbl">In character as</span><a className="chip" href={'#' + hrefOf(s, e.id)}>{e.name}</a>
      <span className="lbl">knowing</span>
      <select className="f chip-select" value={chat.asOf || ''} aria-label="What they know" onChange={ev => update<'chat'>(chat.id, x => { x.asOf = ev.target.value || undefined })}>
        <option value="">everything</option>
        {stories(s).map(st => <optgroup key={st.id} label={st.title}>
          <option value={st.id}>as of the start of {st.title}</option>
          {scenesOf(s, st.id).map(sc => <option key={sc.id} value={sc.id}>as of “{sc.title}”</option>)}
        </optgroup>)}
      </select>
    </div>
  )
}

/** An interview is a conversation with a persona; afterwards the assistant proposes what it turned up. */
function Interview({ s, chat, name, footer, above, route, onBack }: { s: State; chat: Chat; name: string; footer: React.ReactNode; above?: React.ReactNode; route: string; onBack: () => void }) {
  const job = useJob()
  const [found, setFound] = useState<Proposal[]>([])
  const learn = () => job.run('Looking for what’s new…', async sig => {
    const st = getState(), e = get(st, chat.entity, 'entity')!
    const out = (await completeJSON<Proposal[]>('assist', discoveries(st, e, get(st, chat.id, 'chat')!.messages), sig)).map(p => normalizeProposal(getState(), p))
    setFound(out)
    if (!out.length) job.setErr('Nothing new for the canon in this interview yet.')
  })
  const after = chat.messages.length >= 2 && <div className="as-learn">
    {!found.length && <button className="btn sm soft" disabled={!!job.busy} onClick={learn}><Spark size={12} />Suggest canon changes from this interview</button>}
    <JobStatus job={job} />
    <ProposedChanges s={s} items={found} onChange={setFound} title={`What the interview with ${name} turned up`} />
  </div>
  return <ChatPane s={s} chatId={chat.id} persona={name} autoFocus={false} route={route} footer={footer} above={above} after={after}
    system={() => { const st = getState(); return interviewSystem(st, get(st, chat.entity, 'entity')!, get(st, chat.id, 'chat')?.asOf) }}
    placeholder={`Ask ${name} something…`}
    tools={<button className="chip" onClick={onBack}><Icon name="left" size={12} />Back to the assistant</button>}
    empty={<div className="as-empty"><p>{name} answers in character, in their own voice, knowing only what they would know. Ask about motives, evasions, small details. Afterwards, the assistant turns what’s new into changes you can apply.</p></div>}
    starters={['What do you want more than anything?', 'Who do you trust, really?', 'What are you not telling me?', 'Describe your morning.']} />
}
