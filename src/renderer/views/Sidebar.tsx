import { useRef, useState } from 'react'
import { project, stories, scenesOf, words, totalWords, uid, tx, update, getState, type State, type Story } from '../store.ts'
import { Icon, setChrome, MOD, go, stored, store } from '../ui.tsx'
import { newStory, addScene, reorder } from './Write.tsx'
import { WorldIndex } from './World.tsx'
import { openCount } from './shared.tsx'

const labelColor = (l?: string) => (l ? `var(--l-${l})` : 'transparent')

/** The story the user last worked in: the one in the route, else the remembered one, else the first. */
export function currentStory(s: State, view: string, a?: string): Story | undefined {
  const sts = stories(s)
  if ((view === 'write' || view === 'story') && a) { const st = sts.find(x => x.id === a); if (st) { store('canon.story', st.id); return st } }
  return sts.find(x => x.id === stored('canon.story', '')) || sts[0]
}

export function Sidebar({ s, view, a, b, onPalette, onScratch }: { s: State; view: string; a?: string; b?: string; onPalette: () => void; onScratch: () => void }) {
  const p = project(s)
  const st = currentStory(s, view, a)
  const open = openCount(s)
  const nav = (to: string, icon: string, label: string, on: boolean, extra?: React.ReactNode) =>
    <a className={'nav' + (on ? ' on' : '')} href={'#' + to}><Icon name={icon} /><span className="grow">{label}</span>{extra}</a>
  return (
    <nav className="side" aria-label="Sidebar">
      <div className="side-top">
        <span className="grow" />
        <button className="icon-btn" title={`Hide sidebar (${MOD}\\)`} aria-label="Hide sidebar" onClick={() => setChrome({ sidebar: false })}><Icon name="sidebar" /></button>
      </div>
      <a className="side-project" href="#project/project" title="Project settings">
        <b>{p.title || 'Untitled project'}</b>
        <span>{stories(s).length} {stories(s).length === 1 ? 'story' : 'stories'} · {totalWords(s).toLocaleString()} words</span>
      </a>
      <div className="side-nav">
        {nav(st ? `write/${st.id}` : 'write', 'write', 'Write', view === 'write')}
        {nav(st ? `story/${st.id}` : 'write', 'board', 'Plan', view === 'story' || view === 'collection')}
        {nav('world', 'world', 'World', view === 'world')}
        {nav('timeline', 'timeline', 'Timeline', view === 'timeline' || view === 'knowledge')}
        {nav('questions', 'questions', 'Questions', view === 'questions', open ? <span className="count">{open}</span> : null)}
      </div>
      <div className="side-scroll">
        {view === 'world' ? <WorldIndex s={s} cur={a} /> : <StoryTree s={s} cur={st} sceneId={view === 'write' ? b : undefined} plan={view === 'story'} />}
      </div>
      <div className="side-foot">
        <button className="nav" onClick={onPalette}><Icon name="find" /><span className="grow">Search</span><kbd>{MOD}K</kbd></button>
        <div className="row nowrap" style={{ gap: 2 }}>
          <a className={'icon-btn' + (view === 'project' ? ' on' : '')} href="#project/project" title="Project, guides and settings"><Icon name="settings" /></a>
          <a className={'icon-btn' + (view === 'find' ? ' on' : '')} href="#find" title={`Find and replace (${MOD}⇧F)`}><Icon name="replace" /></a>
          <button className="icon-btn" title="Scratchpad: never sent to the AI" onClick={onScratch}><Icon name="scratch" /></button>
          <span className="grow" />
          <span className={'save ' + s.save} title={s.save === 'error' ? 'Saving failed; retrying' : undefined}>{s.save === 'saved' ? 'Saved' : s.save === 'saving' ? 'Saving…' : 'Not saved'}</span>
        </div>
      </div>
    </nav>
  )
}

function StoryTree({ s, cur, sceneId, plan }: { s: State; cur?: Story; sceneId?: string; plan: boolean }) {
  const drag = useRef<string>(undefined)
  const [over, setOver] = useState<string>()
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const cols = project(s).collections || []
  const newCollection = () => {
    const id = uid('col')
    tx('New collection', () => update<'project'>('project', x => { x.collections = [...(x.collections || []), { id, name: 'New collection', filter: {} }] }), false)
    go('collection/' + id)
  }
  return (
    <>
      <div className="grp"><span>Stories</span><button className="icon-btn sm" title="New story" aria-label="New story" onClick={newStory}><Icon name="plus" size={14} /></button></div>
      {stories(s).map(st => {
        const scs = scenesOf(s, st.id)
        const isCur = st.id === cur?.id
        const expanded = closed[st.id] === undefined ? isCur : !closed[st.id]
        return (
          <div key={st.id} className="tree">
            <div className={'tree-story' + (isCur && (plan || !sceneId) ? ' on' : '')}>
              <button className={'disc' + (expanded ? ' open' : '')} aria-label={expanded ? 'Collapse' : 'Expand'} onClick={() => setClosed(c => ({ ...c, [st.id]: expanded }))}><Icon name="chevron" size={12} /></button>
              <a href={'#' + (plan ? 'story/' : 'write/') + st.id} className="grow clip">{st.title || 'Untitled story'}</a>
              <small>{scs.length || ''}</small>
            </div>
            {expanded && <div className="tree-scenes">
              {scs.map((y, i) => (
                <a key={y.id} href={`#write/${st.id}/${y.id}`} className={'tree-scene' + (y.id === sceneId ? ' on' : '') + (over === y.id ? ' drag-over' : '')} draggable
                  onDragStart={() => { drag.current = y.id }} onDragOver={e => { if (drag.current) { e.preventDefault(); setOver(y.id) } }} onDragLeave={() => setOver(undefined)}
                  onDragEnd={() => { drag.current = undefined; setOver(undefined) }}
                  onDrop={e => { e.preventDefault(); if (drag.current && drag.current !== y.id) reorder(scenesOf(getState(), st.id), drag.current, y.id); drag.current = undefined; setOver(undefined) }}>
                  <i className="dot" style={{ background: labelColor(y.label), boxShadow: y.label ? undefined : 'inset 0 0 0 1px var(--line2)' }} />
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
      {cols.map(c => <a key={c.id} className="tree-scene" href={'#collection/' + c.id}><Icon name="collection" size={13} /><span className="clip grow">{c.name}</span></a>)}
      {!cols.length && <p className="side-hint">Saved filters over scenes: everything with Delphine, every flashback.</p>}
    </>
  )
}
