// Pinned: bookmarks in the sidebar (project.pins). Anything with a place in the app can be pinned: scenes, chapters,
// stories, sheets, events, research. The group only shows once something is pinned; drag a sidebar link onto it to pin that too.
import { useRef, useState } from 'react'
import { project, update, tx, getState, nameOf, type State } from '../store.ts'
import { Icon } from '../ui.tsx'
import { hrefOf } from './shared.tsx'
import './research.css'

export const isPinned = (s: State, id: string) => (project(s).pins || []).includes(id)
/** Pin a record to the sidebar, or unpin it. One undo step. */
export function togglePin(id: string) {
  const on = isPinned(getState(), id)
  tx(on ? `Unpin “${nameOf(getState(), id)}”` : `Pin “${nameOf(getState(), id)}”`, () => update<'project'>('project', x => { x.pins = on ? (x.pins || []).filter(p => p !== id) : [...(x.pins || []), id] }), false)
}
/** A Pin / Pinned toggle for a record's header. */
export function PinButton({ s, id, small = true }: { s: State; id: string; small?: boolean }) {
  const on = isPinned(s, id)
  return <button className={'btn ghost' + (small ? ' sm' : '') + (on ? ' on' : '')} aria-pressed={on} title={on ? 'Unpin from the sidebar' : 'Pin to the sidebar, to come back to it quickly'} onClick={() => togglePin(id)}>
    <Icon name="pin" size={13} />{on ? 'Pinned' : 'Pin'}</button>
}

const ICON: Record<string, string> = { scene: 'write', section: 'list', story: 'stories', entity: 'world', fact: 'timeline', research: 'research', question: 'questions' }
/** The icon for a record's kind (characters get a person), so two things with the same name can be told apart. */
export const kindIcon = (s: State, id: string) => { const r = s.recs[id]; return !r ? 'pin' : r.kind === 'entity' && r.type === 'character' ? 'person' : ICON[r.kind] || 'pin' }
/** The record a dragged app link points at: "canon://app/index.html#scene/sc1" → "sc1". */
const idFromLink = (s: State, url: string) => { const [, id] = (url.split('#')[1] || '').split('/'); return id && s.recs[id] && hrefOf(s, id) ? decodeURIComponent(id) : '' }

export function Pinned({ s, view, a }: { s: State; view: string; a?: string }) {
  const pins = (project(s).pins || []).filter(id => s.recs[id] && hrefOf(s, id))
  const drag = useRef<string>(undefined)
  const [over, setOver] = useState<string>()
  if (!pins.length) return null
  const here = `${view}/${a}`
  /** Move a pin before another (or to the end); a link dragged in from elsewhere in the sidebar is pinned there. */
  const place = (id: string, before?: string) => {
    const cur = project(getState()).pins || [], next = cur.filter(x => x !== id)
    const at = before ? next.indexOf(before) : -1
    next.splice(at < 0 ? next.length : at, 0, id)
    tx(cur.includes(id) ? 'Reorder pins' : `Pin “${nameOf(getState(), id)}”`, () => update<'project'>('project', x => { x.pins = next }), false)
  }
  const drop = (e: React.DragEvent, before?: string) => {
    e.preventDefault()
    const id = drag.current || idFromLink(getState(), e.dataTransfer.getData('text/uri-list'))
    drag.current = undefined; setOver(undefined)
    if (id && id !== before) place(id, before)
  }
  const accept = (e: React.DragEvent, key: string) => { if (drag.current || e.dataTransfer.types.includes('text/uri-list')) { e.preventDefault(); setOver(key) } }
  return (
    <div className="pins" onDragOver={e => accept(e, '')} onDragLeave={() => setOver(undefined)} onDrop={e => drop(e)}>
      <div className="grp"><span>Pinned</span></div>
      {pins.map(id => {
        const on = hrefOf(s, id) === here
        return (
          <a key={id} href={'#' + hrefOf(s, id)} className={'tree-scene pin' + (on ? ' on' : '') + (over === id ? ' drag-over' : '')} aria-current={on ? 'page' : undefined} draggable
            onDragStart={() => { drag.current = id }} onDragEnd={() => { drag.current = undefined; setOver(undefined) }}
            onDragOver={e => { e.stopPropagation(); accept(e, id) }} onDrop={e => { e.stopPropagation(); drop(e, id) }}>
            <Icon name={kindIcon(s, id)} size={13} /><span className="clip grow">{nameOf(s, id) || 'Untitled'}</span>
            <button className="x hover-only" aria-label={`Unpin ${nameOf(s, id)}`} title="Unpin" onClick={e => { e.preventDefault(); e.stopPropagation(); togglePin(id) }}>×</button>
          </a>
        )
      })}
      {over === '' && <div className="pin-end" />}
    </div>
  )
}
