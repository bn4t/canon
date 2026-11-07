import { useEffect, useMemo, useRef, useState } from 'react'
import { project, stories, scenesOf, words, totalWords, update, get, getState, nameOf, treeOf, scenesIn, partOf, chapterOf, type State, type Story, type Scene, type TreeNode } from '../store.ts'
import { Icon, setChrome, MOD, Popover, openSettings, useSettingsSection, stored, store } from '../ui.tsx'
import { newStory, addScene, moveItems, afterSection, intoSection, sectionWithContents } from '../scenes.ts'
import { ItemMenu, newCollection, toggleInCollection } from './ItemMenu.tsx'
import { openCount } from './shared.tsx'
import { Pinned } from './Pinned.tsx'
import { ProjectMenuItems } from './Projects.tsx'

const labelColor = (l?: string) => (l ? `var(--l-${l})` : '')

/** The story the route is about: the outline's story, or the open scene's story. Nothing remembered. */
export function routeStory(s: State, view: string, a?: string): Story | undefined {
  if (view === 'story') return get(s, a, 'story')
  if (view === 'scene') return get(s, get(s, a, 'scene')?.story, 'story')
  if (view === 'text') return get(s, a, 'story') || get(s, get(s, a, 'section')?.story, 'story')
}

export function Sidebar({ s, view, a, onPalette, onScratch }: { s: State; view: string; a?: string; onPalette: () => void; onScratch: () => void }) {
  const p = project(s)
  const open = openCount(s)
  const settings = useSettingsSection()
  const n = stories(s).length
  const nav = (to: string, icon: string, label: string, on: boolean, extra?: React.ReactNode) =>
    <a className={'nav' + (on ? ' on' : '')} href={'#' + to} aria-current={on ? 'page' : undefined}><Icon name={icon} /><span className="grow">{label}</span>{extra}</a>
  const revealDb = () => fetch('/api/info').then(r => r.json()).then(i => fetch('/api/reveal', { method: 'POST', body: JSON.stringify({ path: i.db }) }))
  return (
    <nav className="side" aria-label="Sidebar">
      <div className="side-top">
        <span className="grow" />
        <button className="icon-btn" title={`Hide sidebar (${MOD}\\)`} aria-label="Hide sidebar" onClick={() => setChrome({ sidebar: false })}><Icon name="sidebar" /></button>
      </div>
      <Popover trigger={o => (
        <button className="side-project" onClick={o} aria-haspopup="menu">
          <span className="grow"><b>{p.title || 'Untitled project'}</b><span>{totalWords(s).toLocaleString()} words · {n} {n === 1 ? 'story' : 'stories'}</span></span>
          <Icon name="down" size={14} />
        </button>
      )}>{close => <div role="menu" style={{ minWidth: 220 }}>
        <ProjectMenuItems close={close} />
        {([['details', 'Project details and background'], ['book', 'Book details'], ['goals', 'Goals and progress'], ['export', 'Export'], ['backups', 'Backups']] as const).map(([k, l]) =>
          <button key={k} className="menu-item" role="menuitem" onClick={() => { close(); openSettings(k) }}>{l}</button>)}
        <div className="menu-sep" />
        <button className="menu-item" role="menuitem" onClick={() => { close(); revealDb() }}>Show the project file</button>
      </div>}</Popover>
      <button className="side-search" onClick={onPalette}><Icon name="find" size={15} /><span className="grow">Search or ask</span><kbd>{MOD}K</kbd></button>
      <div className="side-nav">
        {nav('home', 'home', 'Home', view === 'home')}
        {nav('world', 'world', 'World', view === 'world')}
        {nav('timeline', 'timeline', 'Timeline', view === 'timeline' || view === 'knowledge')}
        {nav('questions', 'questions', 'Questions', view === 'questions', open ? <span className="count" title={`${open} open`}>{open}</span> : null)}
        {nav('research', 'research', 'Research', view === 'research')}
      </div>
      <div className="side-scroll">
        <Pinned s={s} view={view} a={a} />
        <Manuscript s={s} view={view} a={a} />
      </div>
      <div className="side-foot">
        <button className="nav" onClick={onScratch} title="Loose notes, never sent to the assistant"><Icon name="scratch" /><span className="grow">Scratchpad</span></button>
        <button className={'nav' + (settings ? ' on' : '')} onClick={() => openSettings('details')}><Icon name="sliders" /><span className="grow">Settings</span>
          <span className={'save ' + s.save} title={s.save === 'error' ? 'Saving failed; retrying' : 'Every change is saved as you go'}>{s.save === 'saved' ? 'Saved' : s.save === 'saving' ? 'Saving…' : 'Not saved'}</span></button>
      </div>
    </nav>
  )
}

// ---------------- the manuscript tree ----------------
// Stories open their outline, parts and chapters their continuous text, scenes the editor.
// Drag scenes before a scene, into a chapter or part, or onto a story; drag chapters and parts (with everything in them) before other
// headings, into a part, or onto a story. Every drop is one undo step.

type RowKind = 'story' | 'part' | 'chapter' | 'scene'
/** What is being dragged (one drag at a time in one window). */
let dragging: { ids: string[]; kind: RowKind; title: string } | undefined
type Over = { id: string; how: 'before' | 'into' }

/** Where a drop on this row would go, or nothing when it can't take what is being dragged. */
function dropHow(kind: RowKind, id: string): Over['how'] | undefined {
  const d = dragging
  if (!d || d.ids.includes(id)) return
  if (d.kind === 'scene') return kind === 'scene' ? 'before' : 'into'
  if (d.kind === 'chapter') return kind === 'chapter' ? 'before' : kind === 'part' || kind === 'story' ? 'into' : undefined
  return kind === 'part' ? 'before' : kind === 'story' ? 'into' : undefined // a part never lands inside another part
}
function dropOn(kind: RowKind, id: string, how: Over['how']) {
  const d = dragging, s = getState()
  if (!d) return
  const r = s.recs[id] as { story?: string } | undefined
  const story = kind === 'story' ? id : r?.story
  if (!story) return
  const label = `Move “${d.title}”`
  if (how === 'before') return moveItems(d.ids, story, id, label)
  if (kind === 'story') return moveItems(d.ids, story, undefined, `${label} to “${nameOf(s, story)}”`)
  // Into a chapter: at its end. Into a part: a scene joins the part's own scenes (before its first chapter); a chapter goes to the part's end.
  moveItems(d.ids, story, d.kind === 'scene' ? intoSection(s, id) : afterSection(s, id), `${label} into “${nameOf(s, id)}”`)
}

const TREE = 'canon.tree'
/** Which rows are open: remembered per id on this machine; the path to what is open on screen always opens. */
function useExpanded(s: State, view: string, a?: string) {
  const [m, setM] = useState<Record<string, boolean>>(() => { try { return JSON.parse(stored(TREE, '{}')) } catch { return {} } })
  const save = (n: Record<string, boolean>) => { store(TREE, JSON.stringify(n)); return n }
  const path = useMemo(() => {
    const id = view === 'scene' || view === 'text' || view === 'story' ? a : undefined
    const r = id ? s.recs[id] : undefined
    if (!r || (r.kind !== 'scene' && r.kind !== 'section' && r.kind !== 'story')) return [] as string[]
    if (r.kind === 'story') return [r.id]
    return [r.story, partOf(s, r.id)?.id, r.kind === 'scene' ? chapterOf(s, r.id)?.id : undefined].filter(Boolean) as string[]
  }, [s, view, a])
  useEffect(() => { if (path.some(id => m[id] === false)) setM(x => save({ ...x, ...Object.fromEntries(path.map(id => [id, true])) })) }, [path.join()]) // eslint-disable-line react-hooks/exhaustive-deps
  const isOpen = (id: string, dflt: boolean) => m[id] ?? (path.includes(id) || dflt)
  const toggle = (id: string, dflt: boolean) => setM(x => save({ ...x, [id]: !(x[id] ?? (path.includes(id) || dflt)) }))
  const open = (id: string) => setM(x => save({ ...x, [id]: true }))
  return { isOpen, toggle, open }
}

function Manuscript({ s, view, a }: { s: State; view: string; a?: string }) {
  const [over, setOver] = useState<Over>()
  const [renaming, setRenaming] = useState<string>()
  const ex = useExpanded(s, view, a)
  const cols = project(s).collections || []
  const at = (v: string, id: string) => view === v && a === id

  /** Drag-and-drop and the context menu for one row. */
  const rowProps = (kind: RowKind, id: string, ids: () => string[], title: string) => ({
    draggable: kind !== 'story' && renaming !== id,
    onDragStart: (e: React.DragEvent) => { e.stopPropagation(); dragging = { ids: ids(), kind, title: title || 'Untitled' }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id) },
    onDragOver: (e: React.DragEvent) => { const how = dropHow(kind, id); if (!how) return; e.preventDefault(); e.stopPropagation(); if (over?.id !== id || over.how !== how) setOver({ id, how }) },
    onDragLeave: (e: React.DragEvent) => { if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setOver(o => (o?.id === id ? undefined : o)) },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); const how = dropHow(kind, id); if (how) dropOn(kind, id, how); dragging = undefined; setOver(undefined) },
    onDragEnd: () => { dragging = undefined; setOver(undefined) },
  })
  const dropCls = (id: string) => (over?.id === id ? (over.how === 'before' ? ' drag-over' : ' drop-into') : '')
  const created = (id: string) => { ex.open(id); setRenaming(id) }

  const sceneRow = (sc: Scene, n: number) => (
    <TreeRow key={sc.id} s={s} id={sc.id}>{menu => (
      <a href={'#scene/' + sc.id} className={'tree-scene tree-row' + (at('scene', sc.id) ? ' on' : '') + dropCls(sc.id)} aria-current={at('scene', sc.id) ? 'page' : undefined}
        onContextMenu={menu} {...rowProps('scene', sc.id, () => [sc.id], sc.title)}>
        <i className={'dot' + (sc.label ? '' : ' ring')} style={{ background: labelColor(sc.label) || undefined }} title={sc.label ? project(s).labels?.[sc.label] || sc.label : 'No label'} />
        <span className="n">{n}</span><span className="clip grow">{sc.title || 'Untitled scene'}</span><small>{words(sc.prose) ? words(sc.prose).toLocaleString() : ''}</small>
      </a>)}
    </TreeRow>
  )
  const nodeRows = (node: TreeNode, num: Map<string, number>): React.ReactNode => <>
    {node.scenes.map(sc => sceneRow(sc, num.get(sc.id) || 0))}
    {node.kids.map(k => {
      const sec = k.sec!, part = sec.type === 'part', open = ex.isOpen(sec.id, part)
      const inside = scenesIn(s, sec.id), w = inside.reduce((t, x) => t + words(x.prose), 0)
      return (
        <div key={sec.id} className="tree">
          <TreeRow s={s} id={sec.id} onRename={() => setRenaming(sec.id)} onCreated={created}>{menu => (
            <div className={'tree-sec tree-row' + (part ? ' part' : '') + (at('text', sec.id) ? ' on' : '') + dropCls(sec.id)} onContextMenu={menu} {...rowProps(part ? 'part' : 'chapter', sec.id, () => sectionWithContents(getState(), sec.id), sec.title)}>
              <button className={'disc' + (open ? ' open' : '')} aria-label={open ? `Collapse ${sec.title}` : `Expand ${sec.title}`} aria-expanded={open} onClick={() => ex.toggle(sec.id, part)}><Icon name="chevron" size={12} /></button>
              {renaming === sec.id
                ? <input className="tree-rename" autoFocus value={sec.title} aria-label={part ? 'Part title' : 'Chapter title'} onFocus={e => e.target.select()}
                  onChange={e => update<'section'>(sec.id, x => { x.title = e.target.value })} onBlur={() => setRenaming(undefined)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); setRenaming(undefined) } }} />
                : <a href={'#text/' + sec.id} className="grow clip" title={part ? 'Read the whole part' : 'Read the whole chapter'} onDoubleClick={e => { e.preventDefault(); setRenaming(sec.id) }}>{nameOf(s, sec.id)}</a>}
              <small title={`${inside.length} ${inside.length === 1 ? 'scene' : 'scenes'} · ${w.toLocaleString()} ${w === 1 ? 'word' : 'words'}`}>{inside.length}</small>
            </div>)}
          </TreeRow>
          {open && <div className="tree-kids">{nodeRows(k, num)}{!k.scenes.length && !k.kids.length && <p className="side-hint tree-empty">Empty. Drag scenes here.</p>}</div>}
        </div>
      )
    })}
  </>

  return (
    <>
      <div className="grp"><span>Manuscript</span><button className="icon-btn sm" title="New story" aria-label="New story" onClick={newStory}><Icon name="plus" size={14} /></button></div>
      {stories(s).map(st => {
        const scs = scenesOf(s, st.id)
        const num = new Map(scs.map((x, i) => [x.id, i + 1]))
        const open = ex.isOpen(st.id, false)
        return (
          <div key={st.id} className="tree">
            <TreeRow s={s} id={st.id} onCreated={created}>{menu => (
              <div className={'tree-story tree-row' + (at('story', st.id) || at('text', st.id) ? ' on' : '') + dropCls(st.id)} onContextMenu={menu} {...rowProps('story', st.id, () => [], st.title)}>
                <button className={'disc' + (open ? ' open' : '')} aria-label={open ? `Collapse ${st.title}` : `Expand ${st.title}`} aria-expanded={open} onClick={() => ex.toggle(st.id, false)}><Icon name="chevron" size={12} /></button>
                <a href={'#story/' + st.id} className="grow clip" title="Open the outline">{st.title || 'Untitled story'}</a>
                <small>{scs.length}</small>
              </div>)}
            </TreeRow>
            {open && <div className="tree-scenes">
              {nodeRows(treeOf(s, st.id), num)}
              <button className="tree-scene add" onClick={() => addScene(st)}><Icon name="plus" size={12} />Scene</button>
            </div>}
          </div>
        )
      })}
      {!stories(s).length && <button className="tree-scene add" onClick={newStory}><Icon name="plus" size={12} />New story</button>}
      <div className="grp"><span>Collections</span>
        <Popover className="right" trigger={o => <button className="icon-btn sm" title="New collection" aria-label="New collection" onClick={o}><Icon name="plus" size={14} /></button>}>{close => <div role="menu" style={{ width: 260 }}>
          <button className="menu-item" role="menuitem" onClick={() => { close(); newCollection('smart') }}><span className="grow">Smart collection<br /><span className="small muted">A saved filter: every scene with a character, a tag, a status</span></span></button>
          <button className="menu-item" role="menuitem" onClick={() => { close(); newCollection('manual') }}><span className="grow">Hand-picked collection<br /><span className="small muted">The scenes you choose, in the order you choose</span></span></button>
        </div>}</Popover>
      </div>
      {cols.map(c => (
        <a key={c.id} className={'tree-scene' + (view === 'collection' && a === c.id ? ' on' : '') + (over?.id === c.id ? ' drop-into' : '')} href={'#collection/' + c.id}
          title={c.ids ? 'Hand-picked: drag scenes here to add them' : 'Smart: a saved filter'}
          {...(c.ids ? {
            onDragOver: (e: React.DragEvent) => { if (dragging?.kind === 'scene') { e.preventDefault(); setOver({ id: c.id, how: 'into' }) } },
            onDragLeave: () => setOver(o => (o?.id === c.id ? undefined : o)),
            onDrop: (e: React.DragEvent) => { e.preventDefault(); const d = dragging; dragging = undefined; setOver(undefined); if (d?.kind === 'scene') for (const id of d.ids) if (!c.ids!.includes(id)) toggleInCollection(c.id, id) },
          } : {})}>
          <Icon name={c.ids ? 'list' : 'collection'} size={13} /><span className="clip grow">{c.name || 'Untitled collection'}</span>{c.ids && <small>{c.ids.filter(id => get(s, id, 'scene')).length}</small>}
        </a>
      ))}
      {!cols.length && <p className="side-hint">Smart ones are saved filters over scenes; hand-picked ones are scenes you choose, in your order.</p>}
    </>
  )
}

/** A row with a hover ⋯ button and the same menu on right-click. */
function TreeRow({ s, id, onRename, onCreated, children }: { s: State; id: string; onRename?: () => void; onCreated?: (id: string) => void; children: (onMenu: (e: React.MouseEvent) => void) => React.ReactNode }) {
  const opener = useRef<() => void>(undefined)
  return (
    <div className="tree-wrap">
      {children(e => { e.preventDefault(); opener.current?.() })}
      <Popover className="tree-more" trigger={o => { opener.current = o; return <button className="icon-btn sm" aria-label="More" title="More (or right-click)" onClick={o}><Icon name="more" size={14} /></button> }}>
        {close => <ItemMenu s={s} id={id} close={close} onRename={onRename} onCreated={onCreated} />}
      </Popover>
    </div>
  )
}
