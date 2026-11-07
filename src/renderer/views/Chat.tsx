import { useEffect, useRef, useState, type ReactNode } from 'react'
import { update, get, getState, isApplied, nameOf, type State, type Proposal } from '../store.ts'
import { complete } from '../ai.ts'
import { parseProposals, stripProposals } from '../prompts.ts'
import { useJob, JobStatus, Md, ProposedChanges, Spark } from '../ui.tsx'

/** A persisted conversation (chat record): the log with its proposals, the streaming reply, and the composer. */
export function ChatPane({ s, chatId, system, proposals, placeholder, empty, persona, queued, onQueued, starters, autoFocus = true, footer, tools, above, after, route }: {
  s: State; chatId: string; system: () => string; proposals?: boolean; placeholder: string; empty?: ReactNode; persona?: string; queued?: string; onQueued?: () => void; starters?: string[]; autoFocus?: boolean; footer?: ReactNode
  /** Extra controls in the composer, left of Send. */ tools?: ReactNode
  /** Shown above the composer (e.g. a Connect prompt). */ above?: ReactNode
  /** Shown after the last message (e.g. what an interview turned up). */ after?: ReactNode
  /** The screen the author is on, to say whether suggested text edits are visible there. */ route?: string
}) {
  const chat = get(s, chatId, 'chat')
  const job = useJob()
  const [draft, setDraft] = useState('')
  const [live, setLive] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [chat?.messages.length, live])
  const send = (text: string) => {
    if (!text.trim() || job.busy) return
    update<'chat'>(chatId, x => { x.messages.push({ role: 'user', text }); x.at = new Date().toISOString(); if (x.messages.length === 1 && proposals) x.title = text.replace(/\s+/g, ' ').slice(0, 60) })
    setDraft('')
    job.run(persona ? `${persona} is thinking…` : 'Thinking…', async sig => {
      const msgs = get(getState(), chatId, 'chat')!.messages
      const out = await complete('chat', system(), msgs.map(m => ({ role: m.role, content: m.text })), t => setLive(proposals ? stripProposals(t) : t), sig)
      update<'chat'>(chatId, x => { x.messages.push({ role: 'assistant', text: proposals ? stripProposals(out) : out, proposals: proposals ? parseProposals(getState(), out) : undefined }) })
    }).finally(() => setLive(''))
  }
  useEffect(() => { if (queued) { onQueued?.(); send(queued) } }, [queued]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!chat) return null
  const setProps = (i: number, ps: Proposal[]) => update<'chat'>(chatId, x => { x.messages[i].proposals = ps })
  const reply = (text: string) => (persona ? <div className="msg persona">{text}</div> : <div className="msg"><Md text={text} /></div>)
  return (
    <div className="chatpane">
      <div className="as-scroll">
        <div className="chat">
          {!chat.messages.length && empty}
          {!chat.messages.length && starters && <div className="as-starters">{starters.map(t => <button key={t} className="chip" onClick={() => send(t)}>{t}</button>)}</div>}
          {chat.messages.map((m, i) => (
            <div key={i} className="stack" style={{ gap: 8 }}>
              {m.role === 'user' ? <div className="msg user">{m.text}</div> : reply(m.text)}
              {m.proposals && m.proposals.length > 0 && <MessageChanges s={s} items={m.proposals} route={route} onChange={ps => setProps(i, ps)} />}
            </div>
          ))}
          {live && reply(live)}
          {after}
          <div ref={end} />
        </div>
        <JobStatus job={job} />
      </div>
      <div className="as-comp">
        {above}
        <div className="as-box">
          <textarea value={draft} placeholder={placeholder} aria-label="Message" autoFocus={autoFocus} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft) } }} />
          <div className="as-tools">{tools}<span className="grow" /><button className="btn pri sm" disabled={!draft.trim() || !!job.busy} onClick={() => send(draft)}>Send</button></div>
        </div>
        <div className="as-foot">{footer}<span className="grow" /><span>↵ send · ⇧↵ new line</span></div>
      </div>
    </div>
  )
}

/** What a reply proposes: text edits show in the editor as suggestions; changes to the canon as a list to apply. */
function MessageChanges({ s, items, route, onChange }: { s: State; items: Proposal[]; route?: string; onChange: (ps: Proposal[]) => void }) {
  const edits = items.filter(p => p.op === 'edit'), other = items.filter(p => p.op !== 'edit')
  const scenes = [...new Set(edits.map(p => p.id!).filter(id => s.recs[id]))]
  const open = edits.filter(p => !isApplied(s, p)).length
  const here = (route || '').split('/')[0] === 'scene' && scenes.includes(decodeURIComponent((route || '').split('/')[1] || ''))
  return <>
    {edits.length > 0 && <div className={'as-res' + (open ? '' : ' done')}>
      <Spark size={13} />
      <span className="grow"><b>{edits.length} suggested edit{edits.length === 1 ? '' : 's'}</b> in {scenes.map(id => nameOf(s, id)).join(', ') || 'a scene that is gone'}</span>
      {!open ? <span>Accepted</span> : here ? <span>Shown in the text</span> : scenes[0] && <a href={'#scene/' + scenes[0]}>Open the scene</a>}
    </div>}
    {other.length > 0 && <ProposedChanges s={s} items={other} title="Proposed changes to the canon" onChange={ps => onChange([...edits, ...ps])} />}
  </>
}
