// The text view (#text/<storyOrSectionId>): a whole story, part or chapter as one continuous manuscript you can write in.
// Each scene keeps its own record; the view lays them end to end with quiet dividers, so revising across scenes reads
// like the book. Scenes off screen skip layout (content-visibility), so a long story stays quick.
import { memo, useEffect, useState } from 'react'
import {
  get, update, create, tx, flowOf, contentsOf, sectionsOf, sectionNumber, partOf, nextOrder, newScene, statusOf, words, nameOf,
  type State, type Scene, type Section, type FlowItem, type Story, type StatusDef,
} from '../store.ts'
import { Bar, Icon, go } from '../ui.tsx'
import { ProseField, Composition, useTypewriter } from './Prose.tsx'
import { exportSelection } from './Export.tsx'
import './text.css'

const n = (x: number) => x.toLocaleString()
const plural = (k: number, one: string) => `${n(k)} ${k === 1 ? one : one + 's'}`
const secLabel = (s: State, x: Section) => `${x.type === 'part' ? 'Part' : 'Chapter'} ${sectionNumber(s, x.id)}`
/** "Chapter 3: The Ledger", or just "Chapter 3" when the title only repeats the number. */
const secName = (s: State, x: Section) => secLabel(s, x) + (x.title.trim() && !/^(part|chapter)\s+\d+$/i.test(x.title.trim()) ? `: ${x.title.trim()}` : '')

export function TextView({ s, id }: { s: State; id: string }) {
  const rec = get(s, id, 'story') || get(s, id, 'section')
  const story: Story | undefined = rec?.kind === 'story' ? rec : get(s, rec?.story, 'story')
  const [focus, setFocus] = useState(false)
  const [fresh, setFresh] = useState<string>()
  const tw = useTypewriter()
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent<string>).detail === 'focus') { e.preventDefault(); setFocus(f => !f) } }
    addEventListener('canon:command', on)
    return () => removeEventListener('canon:command', on)
  }, [])
  if (!rec || !story) return <><Bar /><div className="empty"><h2>Not found</h2><p>It may have been deleted, or undone.</p><a className="btn" href="#home">Home</a></div></>
  const sec = rec.kind === 'section' ? rec : undefined
  const flow = flowOf(s, story.id)
  const items: FlowItem[] = sec ? [sec, ...contentsOf(s, sec.id)] : flow
  const scs = items.filter((x): x is Scene => x.kind === 'scene')
  const total = scs.reduce((k, sc) => k + words(sc.prose), 0)
  const siblings = sec ? sectionsOf(s, story.id).filter(x => x.type === sec.type) : []
  const at = sec ? siblings.findIndex(x => x.id === sec.id) : -1
  const prev = at > 0 ? siblings[at - 1] : undefined, next = at >= 0 ? siblings[at + 1] : undefined
  const part = sec?.type === 'chapter' ? partOf(s, sec.id) : undefined

  /** A new scene right after `x` in the story (or at the very end), opened here ready to type. */
  const addAfter = (x?: FlowItem) => {
    const k = x ? flow.findIndex(y => y.id === x.id) : flow.length - 1, before = flow[k + 1]
    const order = x && before ? (x.order + before.order) / 2 : nextOrder(flow)
    let nid = ''
    tx('New scene', () => { nid = create('scene', newScene(story.id, order, { title: 'Untitled scene', cast: story.pov ? [story.pov] : [] })) })
    setFresh(nid)
  }
  // "+ Scene" closes each chapter (and an empty part); not between a part's heading and its first chapter.
  const closes = (j: number) => {
    const x = items[j], nx = items[j + 1]
    if (nx && nx.kind !== 'section') return false
    return !(x.kind === 'section' && x.type === 'part' && nx?.kind === 'section' && nx.type === 'chapter')
  }
  const inSection = (j: number) => { for (let i = j; i >= 0; i--) { const x = items[i]; if (x.kind === 'section') return x } }
  const page = (
    <div className="tv-doc">
      {!sec && <header className="tv-head"><h1>{story.title || 'Untitled story'}</h1>{story.premise.trim() && <p>{story.premise}</p>}</header>}
      {!items.length && <div className="tv-empty"><p>Nothing written yet. Scenes you add appear here, one after another, as the reader will meet them.</p>
        <button className="btn" onClick={() => addAfter()}><Icon name="plus" size={14} />First scene</button></div>}
      {items.map((x, j) => {
        const home = closes(j) ? inSection(j) : undefined
        return <div key={x.id} className="tv-item">
          {x.kind === 'section' ? <SectionHead s={s} sec={x} top={j === 0} /> : <SceneBlock sc={x} st={statusOf(s, x.status)} fresh={fresh === x.id} tw={tw} />}
          {closes(j) && <button className="tv-add" onClick={() => addAfter(x)} title={home ? `A new scene at the end of ${secName(s, home)}` : 'A new scene at the end'}>
            <Icon name="plus" size={13} />Scene</button>}
        </div>
      })}
    </div>
  )
  if (focus) return <Composition s={s} words={total} onExit={() => setFocus(false)}>{page}</Composition>
  return (
    <div className="tv">
      <Bar>
        <div className="crumbs grow">
          <a href={'#story/' + story.id} className="clip" title="The story’s outline">{story.title || 'Untitled story'}</a>
          {part && <><Icon name="chevron" size={12} /><a href={'#text/' + part.id} className="clip">{secName(s, part)}</a></>}
          {sec && <><Icon name="chevron" size={12} /><b className="clip">{secName(s, sec)}</b></>}
          <span className="tv-count">{plural(scs.length, 'scene')} · {plural(total, 'word')}</span>
        </div>
        {sec && <>
          <button className="icon-btn" disabled={!prev} aria-label={`Previous ${sec.type}`} title={prev ? `Previous: ${secName(s, prev)}` : `This is the first ${sec.type}`} onClick={() => prev && go('text/' + prev.id)}><Icon name="left" /></button>
          <button className="icon-btn" disabled={!next} aria-label={`Next ${sec.type}`} title={next ? `Next: ${secName(s, next)}` : `This is the last ${sec.type}`} onClick={() => next && go('text/' + next.id)}><Icon name="right" /></button>
        </>}
        <button className="icon-btn" title="Focus mode (⇧⌘↵)" aria-label="Focus mode" onClick={() => setFocus(true)}><Icon name="focus" /></button>
        <span className="bar-sep" />
        {sec && <a className="btn sm ghost" href={'#text/' + story.id} title={`All of ${nameOf(s, story.id)}`}>Whole story</a>}
        <a className="btn sm ghost" href={'#story/' + story.id} title="Cards for every scene">Outline</a>
        <button className="btn sm ghost" onClick={() => exportSelection([id])} title={`Export ${sec ? 'this ' + sec.type : 'this story'}`}>Export…</button>
        <span className="bar-sep" />
      </Bar>
      <div className={'tv-page' + (tw ? ' tw' : '')}>{page}</div>
    </div>
  )
}

function SectionHead({ s, sec, top }: { s: State; sec: Section; top: boolean }) {
  const kind = sec.type === 'part' ? 'Part' : 'Chapter'
  return (
    <header className={'tv-sec ' + sec.type + (top ? ' top' : '')}>
      <a className="tv-sec-n" href={'#text/' + sec.id} title={`Only this ${sec.type}`}>{secLabel(s, sec)}</a>
      <input className="tv-sec-t" value={sec.title} placeholder={`Untitled ${sec.type}`} aria-label={`${kind} title`} spellCheck
        onChange={e => update<'section'>(sec.id, x => { x.title = e.target.value })} />
      {sec.synopsis.trim() && <p className="tv-sec-syn">{sec.synopsis}</p>}
    </header>
  )
}

/** One scene in the flow. Memoised on the record, so typing in one scene doesn't redraw the others. */
const SceneBlock = memo(function SceneBlock({ sc, st, fresh, tw }: { sc: Scene; st: StatusDef; fresh: boolean; tw: boolean }) {
  const w = words(sc.prose), title = sc.title.trim() || 'Untitled scene'
  return (
    <section className={'tv-scene' + (sc.exclude ? ' out' : '')} aria-label={title}>
      <div className="tv-div">
        <a className="tv-st" href={'#scene/' + sc.id} title="Open in the scene editor. ⌥-click to open it beside this.">
          <i className="dot" style={{ background: st.color }} title={st.label} /><span className="clip">{title}</span></a>
        {sc.exclude && <span className="tv-tag" title="Left out of export">left out</span>}
        <span className="tv-rule" />
        <span className="tv-w">{w ? plural(w, 'word') : ''}</span>
      </div>
      <ProseField className="tv-pf" value={sc.prose} ariaLabel={`Text of ${title}`} autoFocus={fresh} typewriter={tw}
        placeholder={sc.card.trim() ? `Write the scene. The card: ${sc.card.trim()}` : 'Write the scene.'} onChange={v => update<'scene'>(sc.id, x => { x.prose = v })} />
    </section>
  )
})
