import { useRef, useState } from 'react'
import { project, stories, scenesOf, words, totalWords, uid, tx, update, get, getState, type State, type Story } from '../store.ts'
import { Icon, setChrome, MOD, go, Popover, openSettings, useSettingsSection } from '../ui.tsx'
import { newStory, addScene, reorder } from '../scenes.ts'
import { openCount } from './shared.tsx'

const labelColor = (l?: string) => (l ? `var(--l-${l})` : '')

/** The story the route is about: the outline's story, or the open scene's story. Nothing remembered. */
export function routeStory(s: State, view: string, a?: string): Story | undefined {
  if (view === 'story') return get(s, a, 'story')
  if (view === 'scene') return get(s, get(s, a, 'scene')?.story, 'story')
}

export function Sidebar({ s, view, a, onPalette, onScratch }: { s: State; view: string; a?: string; onPalette: () => void; onScratch: () => void }) {
  const p = project(s)
  const open = openCount(s)
  const settings = useSettingsSection()
  const n = stories(s).length
  const nav = (to: string, icon: string, label: string, on: boolean, extra?: React.ReactNode) =>
    <a className={'nav' + (on ? ' on' : '')} href={'#' + to} aria-current={on ? 'page' : undefined}><Icon name={icon} /><span className="grow">{label}</span>{extra}</a>
  const revealDb = () => fetch('/api/info').then(r => r.json()).then(i => fetch('/api/reveal', { method: 'POST', body: JSON.stringify({ path: i.dataDir + '/canon.db' }) }))
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
        {([['details', 'Project details and background'], ['goals', 'Goals and progress'], ['export', 'Export and backup']] as const).map(([k, l]) =>
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
      </div>
      <div className="side-scroll">
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

/** Stories open their outline; scenes open the editor. Drag scenes to reorder. */
function Manuscript({ s, view, a }: { s: State; view: string; a?: string }) {
  const drag = useRef<string>(undefined)
  const [over, setOver] = useState<string>()
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const cur = routeStory(s, view, a)
  const cols = project(s).collections || []
  const newCollection = () => {
    const id = uid('col')
    tx('New collection', () => update<'project'>('project', x => { x.collections = [...(x.collections || []), { id, name: 'New collection', filter: {} }] }), false)
    go('collection/' + id)
  }
  return (
    <>
      <div className="grp"><span>Manuscript</span><button className="icon-btn sm" title="New story" aria-label="New story" onClick={newStory}><Icon name="plus" size={14} /></button></div>
      {stories(s).map(st => {
        const scs = scenesOf(s, st.id)
        const expanded = toggled[st.id] ?? st.id === cur?.id
        return (
          <div key={st.id} className="tree">
            <div className={'tree-story' + (view === 'story' && a === st.id ? ' on' : '')}>
              <button className={'disc' + (expanded ? ' open' : '')} aria-label={expanded ? `Collapse ${st.title}` : `Expand ${st.title}`} aria-expanded={expanded} onClick={() => setToggled(c => ({ ...c, [st.id]: !expanded }))}><Icon name="chevron" size={12} /></button>
              <a href={'#story/' + st.id} className="grow clip" title="Open the outline">{st.title || 'Untitled story'}</a>
              <small>{scs.length}</small>
            </div>
            {expanded && <div className="tree-scenes">
              {scs.map((y, i) => (
                <a key={y.id} href={'#scene/' + y.id} className={'tree-scene' + (view === 'scene' && y.id === a ? ' on' : '') + (over === y.id ? ' drag-over' : '')} draggable
                  aria-current={view === 'scene' && y.id === a ? 'page' : undefined}
                  onDragStart={() => { drag.current = y.id }} onDragOver={e => { if (drag.current) { e.preventDefault(); setOver(y.id) } }} onDragLeave={() => setOver(undefined)}
                  onDragEnd={() => { drag.current = undefined; setOver(undefined) }}
                  onDrop={e => { e.preventDefault(); if (drag.current && drag.current !== y.id) reorder(scenesOf(getState(), st.id), drag.current, y.id); drag.current = undefined; setOver(undefined) }}>
                  <i className={'dot' + (y.label ? '' : ' ring')} style={{ background: labelColor(y.label) || undefined }} title={y.label ? project(s).labels?.[y.label] || y.label : 'No label'} />
                  <span className="n">{i + 1}</span><span className="clip grow">{y.title || 'Untitled scene'}</span><small>{words(y.prose) ? words(y.prose).toLocaleString() : ''}</small>
                </a>
              ))}
              <button className="tree-scene add" onClick={() => addScene(st)}><Icon name="plus" size={12} />Scene</button>
            </div>}
          </div>
        )
      })}
      {!stories(s).length && <button className="tree-scene add" onClick={newStory}><Icon name="plus" size={12} />New story</button>}
      <div className="grp"><span>Collections</span><button className="icon-btn sm" title="New collection: a saved filter over scenes" aria-label="New collection" onClick={newCollection}><Icon name="plus" size={14} /></button></div>
      {cols.map(c => <a key={c.id} className={'tree-scene' + (view === 'collection' && a === c.id ? ' on' : '')} href={'#collection/' + c.id}><Icon name="collection" size={13} /><span className="clip grow">{c.name}</span></a>)}
      {!cols.length && <p className="side-hint">Saved filters over scenes: everything with one character, every flashback.</p>}
    </>
  )
}
