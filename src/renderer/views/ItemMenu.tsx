// The ⋯ / right-click menu for a story, part, chapter or scene, shared by the sidebar tree and the outline.
// Moves and deletes are one undo step each; deleting a chapter with its scenes asks first.
import { useState } from 'react'
import { getState, stories, sectionsOf, scenesIn, contentsOf, chapterOf, project, nameOf, tx, update, remove, list, uid, type State, type Scene } from '../store.ts'
import { go, openReference, Icon } from '../ui.tsx'
import { addScene, addSection, addSceneIn, afterSection, intoSection, moveItems, removeSection, setSectionType, deleteSection } from '../scenes.ts'
import { exportSelection } from './Export.tsx'
import { togglePin, isPinned } from './Pinned.tsx'

// ---------------- hand-picked collections ----------------

/** Hand-picked collections (a collection with `ids`), in sidebar order. */
export const manualCollections = (s: State) => (project(s).collections || []).filter(c => c.ids)
/** Add a scene to a hand-picked collection, or take it out. */
export function toggleInCollection(colId: string, sceneId: string) {
  const c = (project(getState()).collections || []).find(x => x.id === colId)
  if (!c?.ids) return
  const on = c.ids.includes(sceneId)
  tx(on ? `Remove from “${c.name}”` : `Add to “${c.name}”`, () => update<'project'>('project', x => {
    const col = x.collections!.find(y => y.id === colId)!
    col.ids = on ? col.ids!.filter(i => i !== sceneId) : [...col.ids!, sceneId]
  }))
}
/** A new collection: smart (a saved filter) or hand-picked (optionally starting with some scenes). Opens it. */
export function newCollection(kind: 'smart' | 'manual', ids: string[] = []) {
  const id = uid('col')
  tx(kind === 'manual' ? 'New hand-picked collection' : 'New collection', () => update<'project'>('project', x => {
    x.collections = [...(x.collections || []), { id, name: 'New collection', filter: {}, ...(kind === 'manual' ? { ids } : {}) }]
  }), false)
  go('collection/' + id)
}

// ---------------- the menu ----------------

type Page = 'main' | 'story' | 'chapter' | 'collection' | 'delete'

/** Menu items for one record. `onRename`: the place that shows the row can rename it inline. `onCreated`: a new heading was added (to rename it). */
export function ItemMenu({ s, id, close, onRename, onCreated }: { s: State; id: string; close: () => void; onRename?: () => void; onCreated?: (id: string) => void }) {
  const [page, setPage] = useState<Page>('main')
  const r = s.recs[id]
  if (!r || (r.kind !== 'story' && r.kind !== 'section' && r.kind !== 'scene')) return null
  const item = (label: string, run: () => void, cls = '', hint?: string) =>
    <button className={'menu-item ' + cls} role="menuitem" onClick={() => { run(); close() }}><span className="grow">{label}</span>{hint && <span className="small muted">{hint}</span>}</button>
  const sub = (label: string, to: Page) => <button className="menu-item" role="menuitem" onClick={() => setPage(to)}><span className="grow">{label}</span><Icon name="right" size={12} /></button>
  const back = (title: string) => <div className="im-head"><button className="icon-btn sm" aria-label="Back" onClick={() => setPage('main')}><Icon name="left" size={13} /></button><b className="grow clip">{title}</b></div>
  const pin = item(isPinned(s, id) ? 'Unpin from the sidebar' : 'Pin to the sidebar', () => togglePin(id))
  const exp = item('Export…', () => exportSelection([id]))
  const sep = <div className="menu-sep" />

  if (r.kind === 'story') {
    const created = (x: string) => { onCreated?.(x) }
    return <div role="menu" className="im">
      {item('New scene', () => addScene(r))}
      {item('New chapter', () => created(addSection(r.id, 'chapter')))}
      {item('New part', () => created(addSection(r.id, 'part')))}
      {sep}
      {item('Open the outline', () => go('story/' + r.id))}
      {item('Read as one text', () => go('text/' + r.id))}
      {sep}{pin}{exp}
    </div>
  }

  if (r.kind === 'section') {
    const n = scenesIn(s, id).length, what = r.type === 'part' ? 'part' : 'chapter'
    if (page === 'delete') return <div role="menu" className="im im-confirm">
      <p>Delete “{r.title || 'Untitled'}”{n ? ` and the ${n} scene${n === 1 ? '' : 's'} in it` : ''}{r.type === 'part' && contentsOf(s, id).some(x => x.kind === 'section') ? ', with its chapters' : ''}? You can undo this.</p>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}><button className="btn sm ghost" onClick={() => setPage('main')}>Cancel</button><button className="btn sm danger" onClick={() => { deleteSection(id); close() }}>Delete</button></div>
    </div>
    return <div role="menu" className="im">
      {onRename && item('Rename', onRename)}
      {item('New scene in it', () => addSceneIn(id))}
      {item(`New ${what} after it`, () => onCreated?.(addSection(r.story, r.type, afterSection(getState(), id))))}
      {item(r.type === 'part' ? 'Make it a chapter' : 'Make it a part', () => setSectionType(id, r.type === 'part' ? 'chapter' : 'part'), '', r.type === 'part' ? '' : 'holds the chapters after it')}
      {sep}
      {item('Read as one text', () => go('text/' + id))}
      {item('Open in the reference pane', () => openReference(id))}
      {pin}{exp}
      {sep}
      {item('Remove the heading, keep the scenes', () => removeSection(id))}
      <button className="menu-item danger" role="menuitem" onClick={() => setPage('delete')}>Delete {what} and its scenes…</button>
    </div>
  }

  const sc = r as Scene
  if (page === 'story') return <div role="menu" className="im">
    {back('Move to story')}
    {stories(s).map(st => <button key={st.id} className={'menu-item' + (st.id === sc.story ? ' on' : '')} role="menuitem" disabled={st.id === sc.story}
      onClick={() => { moveItems([id], st.id, undefined, `Move “${sc.title || 'Untitled scene'}” to “${st.title}”`); close() }}><span className="grow clip">{st.title || 'Untitled story'}</span>{st.id === sc.story && <span className="small muted">here</span>}</button>)}
  </div>
  if (page === 'chapter') {
    const cur = chapterOf(s, id)?.id
    return <div role="menu" className="im">
      {back('Move to chapter')}
      {stories(s).filter(st => sectionsOf(s, st.id).length).map(st => <div key={st.id} className="stack" style={{ gap: 1 }}>
        <span className="lbl im-h">{st.title || 'Untitled story'}</span>
        <button className="menu-item" role="menuitem" onClick={() => { moveItems([id], st.id, sectionsOf(s, st.id)[0].id, `Move “${sc.title}” before the first chapter`); close() }}><span className="grow muted">Before the first chapter</span></button>
        {sectionsOf(s, st.id).map(sec => <button key={sec.id} className={'menu-item' + (sec.id === cur ? ' on' : '')} role="menuitem" disabled={sec.id === cur}
          onClick={() => { moveItems([id], st.id, intoSection(getState(), sec.id), `Move “${sc.title || 'Untitled scene'}” to “${sec.title || 'Untitled'}”`); close() }}>
          <span className={'grow clip' + (sec.type === 'part' ? ' im-part' : ' im-chap')}>{nameOf(s, sec.id)}</span></button>)}
      </div>)}
      {!stories(s).some(st => sectionsOf(s, st.id).length) && <p className="small muted im-h">No chapters yet. Add one from a story’s menu.</p>}
    </div>
  }
  if (page === 'collection') {
    const cols = manualCollections(s)
    return <div role="menu" className="im">
      {back('Add to collection')}
      {cols.map(c => <label key={c.id} className="menu-item"><input type="checkbox" checked={c.ids!.includes(id)} onChange={() => toggleInCollection(c.id, id)} /><span className="grow clip">{c.name || 'Untitled collection'}</span></label>)}
      {cols.length > 0 && sep}
      {item('New hand-picked collection', () => newCollection('manual', [id]))}
    </div>
  }
  const del = () => {
    const [v, a] = location.hash.slice(1).split('/')
    tx(`Delete scene “${sc.title || 'Untitled scene'}”`, () => { for (const x of list(getState(), 'note')) if (x.scene === id) remove(x.id); remove(id) })
    if (v === 'scene' && a === id) go('story/' + sc.story)
  }
  return <div role="menu" className="im">
    {item('Open', () => go('scene/' + id))}
    {item('Open in the reference pane', () => openReference(id))}
    {sep}
    {sub('Move to story', 'story')}
    {sub('Move to chapter', 'chapter')}
    {sub('Add to collection', 'collection')}
    {sep}{pin}{exp}
    {sep}
    {item('Delete scene', del, 'danger')}
  </div>
}
