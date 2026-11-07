import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import './editor.css'
import {
  update, create, remove, tx, get, getState, scenesOf, entities, words, showToast, project, nameOf, sessionWords, dailyGoal, newNote, typeIds, typeDef, eventCode, notesFor,
  statusesOf, statusOf, chapterOf, partOf, LABELS, type State, type Story, type Scene, type Note, type MetaField, type StatusDef,
} from '../store.ts'
import { useAI, aiReady } from '../ai.ts'
import { diffWords, diffText } from '../diff.ts'
import { Area, Popover, useJob, JobStatus, Diff, go, Bar, Icon, MOD, AssistMenu, ConnectPrompt, Spark, askAssistant, ago, useChrome, openSettings, openReference, type AssistItem } from '../ui.tsx'
import { ProseField, Composition, applyFormat, findAll, replaceIn, setText, useTypewriter, type Hl, type FormatCmd } from './Prose.tsx'
import { exportSelection } from './Export.tsx'
import { RecordPicker, History, hrefOf } from './shared.tsx'
import {
  usePendingVer, hunksFor, accept, acceptAll, rejectAll, builtState, BUILT, useHashes, buildOne, deriveCardChanges, applyCardFill, direct, locate, critique, continuity,
  splitAt, mergeNext, type Hunk, type CardFill,
} from '../scenes.ts'
// Older imports still reach these through the editor module.
export { addPending, builtState, BUILT, useHashes, buildOne, deriveOne, direct, locate, critique, continuity, newStory, addScene, reorder } from '../scenes.ts'

const labelColor = (l?: string) => (l ? `var(--l-${l})` : 'var(--line2)')
const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`
const firstName = (name: string) => name.split(' ')[0]
const DEFAULT_STATUS = ['todo', 'draft', 'revised', 'final']
/** A status as a pill: the built-in ones keep their tuned colours; a project's own statuses take their colour. */
export function StatusPill({ st }: { st: StatusDef }) {
  return DEFAULT_STATUS.includes(st.id) && st.color === ({ todo: 'var(--line2)', draft: 'var(--l-yellow)', revised: 'var(--l-blue)', final: 'var(--l-green)' } as Record<string, string>)[st.id]
    ? <span className={'status-pill ' + st.id}>{st.label}</span>
    : <span className="status-pill" style={{ background: `color-mix(in srgb, ${st.color} 22%, transparent)`, color: `color-mix(in srgb, ${st.color} 62%, var(--ink))` }}>{st.label}</span>
}

/** The scene editor (#scene/<id>). */
export function SceneView({ s, sceneId }: { s: State; sceneId: string }) {
  const sc = get(s, sceneId, 'scene'), st = sc && get(s, sc.story, 'story')
  if (!sc || !st) return <><Bar /><div className="empty"><h2>Not found</h2><p>This scene may have been deleted, or undone.</p><a className="btn" href="#home">Home</a></div></>
  return <Editor key={sc.id} s={s} st={st} sc={sc} />
}

// ---------------- the editor ----------------

type Mode = 'menu' | 'rewrite' | 'comment' | 'ask'
interface Tool { range: [number, number]; mode: Mode }
type Range = Hl
interface Find { q: string; rep: string; cs: boolean; i: number }

function Editor({ s, st, sc }: { s: State; st: Story; sc: Scene }) {
  usePendingVer()
  const ai = useAI()
  const ready = aiReady(ai)
  const chrome = useChrome()
  const job = useJob()
  const hashes = useHashes(s, st.id)
  const root = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null), wrap = useRef<HTMLDivElement>(null), back = useRef<HTMLDivElement>(null), floatRef = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const caret = useRef(0), down = useRef(false)
  const [tool, setTool] = useState<Tool>()
  const [live, setLive] = useState('')
  const [focus, setFocus] = useState(false)
  const [cur, setCur] = useState(0)
  const [hot, setHot] = useState<string>()
  const [flash, setFlash] = useState<[number, number]>()
  const [history, setHistory] = useState(false)
  const [compare, setCompare] = useState<{ title: string; before: string; after: string }>()
  const [fill, setFill] = useState<CardFill>()
  const [width, setWidth] = useState(1200)
  const [pos, setPos] = useState<Record<string, number>>({})
  const [find, setFind] = useState<Find>()
  const findIn = useRef<HTMLInputElement>(null)
  // Each Find command puts the cursor in the find field (once it's there).
  const [findAsk, setFindAsk] = useState(0)
  useEffect(() => { if (findAsk) { findIn.current?.focus(); findIn.current?.select() } }, [findAsk])
  const tw = useTypewriter()
  const edit = (fn: (x: Scene) => void) => update<'scene'>(sc.id, fn)
  const scs = scenesOf(s, st.id), i = scs.findIndex(x => x.id === sc.id)
  const chapter = chapterOf(s, sc.id) || partOf(s, sc.id)
  const p = project(s)
  const notes = notesFor(s, sc.id), open = notes.filter(n => !n.done)
  const hunks = live ? [] : hunksFor(s, sc)
  const k = Math.min(cur, Math.max(0, hunks.length - 1))
  const built = builtState(sc, hashes[sc.id])
  const folded = chrome.assistant || width < 1000
  const w = words(sc.prose)

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    if (root.current) ro.observe(root.current)
    return () => ro.disconnect()
  }, [])
  // Menu: Focus Mode, Previous/Next Scene; notes and Find ask for a passage to be shown.
  useEffect(() => {
    const onCmd = (e: Event) => {
      const c = (e as CustomEvent<string>).detail
      if (c === 'focus') setFocus(f => !f)
      else if (c === 'find') { e.preventDefault(); const t = area.current, sel = t && t.selectionEnd > t.selectionStart && !t.value.slice(t.selectionStart, t.selectionEnd).includes('\n') ? t.value.slice(t.selectionStart, t.selectionEnd) : ''
        setFind(f => ({ q: sel || f?.q || '', rep: f?.rep || '', cs: !!f?.cs, i: 0 })); setFindAsk(k => k + 1) }
      else if (c === 'scene:prev' && i > 0) go('scene/' + scs[i - 1].id)
      else if (c === 'scene:next' && i < scs.length - 1) go('scene/' + scs[i + 1].id)
    }
    const onSel = (e: Event) => { const at = locate(get(getState(), sc.id, 'scene')!.prose, (e as CustomEvent<string>).detail); if (at) setFlash(at); else showToast('That passage is no longer in the text.') }
    const up = () => { if (down.current) { down.current = false; if (document.activeElement === area.current) readSelection() } }
    addEventListener('canon:command', onCmd); addEventListener('canon:select', onSel); addEventListener('mouseup', up)
    return () => { removeEventListener('canon:command', onCmd); removeEventListener('canon:select', onSel); removeEventListener('mouseup', up) }
  }, [sc.id, i, scs]) // eslint-disable-line react-hooks/exhaustive-deps
  // Show a passage: highlight it briefly and scroll it into the middle of the window.
  useEffect(() => {
    if (!flash) return
    requestAnimationFrame(() => back.current?.querySelector('[data-a="flash"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    const t = setTimeout(() => setFlash(undefined), 1600)
    return () => clearTimeout(t)
  }, [flash])

  const readSelection = () => {
    const t = area.current
    if (!t) return
    caret.current = t.selectionStart
    if (down.current) return
    const a = t.selectionStart, b = t.selectionEnd
    if (b - a > 1 && t.value.slice(a, b).trim()) setTool(x => (x && x.range[0] === a && x.range[1] === b ? x : { range: [a, b], mode: 'menu' }))
    else setTool(undefined)
  }

  // Highlights drawn behind the text: notes, suggestions, find matches, the selection the toolbar works on.
  const ranges: Range[] = []
  const matches = find && !live ? findAll(sc.prose, find.q, find.cs) : []
  const fi = matches.length ? Math.min(find!.i, matches.length - 1) : 0
  if (!live) {
    matches.forEach(([a, b], j) => ranges.push({ k: 'f:' + j, a, b, cls: 'bk-find' + (j === fi ? ' hot' : '') }))
    for (const n of open) { const r = n.quote ? locate(sc.prose, n.quote) : undefined; if (r) ranges.push({ k: 'n:' + n.id, a: r[0], b: r[1], cls: 'bk-note ' + n.by + (hot === 'n:' + n.id ? ' hot' : '') }) }
    hunks.forEach((h, j) => { if (!h.whole) ranges.push({ k: 'h:' + j, a: h.at, b: h.at + h.p.find!.length, cls: 'bk-sugg' + (j === k ? ' hot' : '') }) })
    if (tool) ranges.push({ k: 'sel', a: tool.range[0], b: tool.range[1], cls: 'bk-sel' })
    if (flash) ranges.push({ k: 'flash', a: flash[0], b: flash[1], cls: 'bk-flash' })
  }

  // Measure where each highlight sits, so margin cards, gutter marks and the toolbar line up with the text.
  useLayoutEffect(() => {
    const b = body.current, bk = back.current
    if (!b || !bk) return
    const top = b.getBoundingClientRect().top, wr = wrap.current?.getBoundingClientRect()
    const next: Record<string, number> = { __wrap: (wr?.top ?? top) - top, __w: wr?.width ?? 0, __float: (floatRef.current?.getBoundingClientRect().top ?? top) - top }
    bk.querySelectorAll<HTMLElement>('[data-a]').forEach(el => { const key = el.dataset.a!; if (!(key in next)) { const r = el.getBoundingClientRect(); next[key] = r.top - top; next['x:' + key] = r.left - (wr?.left ?? 0) } })
    bk.querySelectorAll<HTMLElement>('[data-z]').forEach(el => { next['z:' + el.dataset.z] = el.getBoundingClientRect().bottom - top })
    if (JSON.stringify(next) !== JSON.stringify(pos)) setPos(next)
  })

  const goTo = (j: number) => { const h = hunks[j]; if (!h) return; setCur(j); if (!h.whole) setFlash([h.at, h.at + h.p.find!.length]) }
  // Find: step through matches, keeping the current one in view; replace through the field so ⌘Z in the text undoes it.
  const showMatch = (j: number) => requestAnimationFrame(() => back.current?.querySelector(`[data-a="f:${j}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  const step = (d: number) => { if (!find || !matches.length) return; const j = (fi + d + matches.length) % matches.length; setFind({ ...find, i: j }); showMatch(j) }
  const replaceOne = () => { const m = matches[fi], t = area.current; if (!m || !t || !find) return; replaceIn(t, m[0], m[1], find.rep); findIn.current?.focus(); showMatch(fi) }
  const replaceAll = () => {
    const t = area.current; if (!t || !find || !matches.length) return
    let out = '', at = 0
    for (const [a, b] of matches) { out += sc.prose.slice(at, a) + find.rep; at = b }
    setText(t, out + sc.prose.slice(at)); findIn.current?.focus()
    showToast(`Replaced ${plural(matches.length, 'match', 'matches')} in this scene · ${MOD}Z in the text undoes it`)
  }
  const format = (cmd: FormatCmd) => { if (area.current && !live) applyFormat(area.current, cmd) }
  const prev = i > 0 ? scs[i - 1] : undefined, next = i < scs.length - 1 ? scs[i + 1] : undefined
  const sel = tool ? sc.prose.slice(tool.range[0], tool.range[1]) : ''

  const draft = () => job.run(sc.prose.trim() ? 'Drafting a new version from the card…' : 'Drafting from the card…', async (sig, progress) => {
    const empty = !sc.prose.trim()
    const r = await buildOne(sc.id, sig, t => { if (empty) setLive(t); else progress(`Drafting a new version from the card… ${plural(words(t), 'word')}`) })
    if (r === 'suggested') { setCur(0); showToast('The new draft is a suggestion over your text: compare, then accept or reject it.') }
  }).finally(() => setLive(''))
  const fillCard = () => job.run('Reading the text to fill the card…', async sig => {
    const d = await deriveCardChanges(sc.id, sig)
    if (!Object.keys(d).length) showToast('The card already says what the text does.'); else setFill(d)
  })
  const feedback = () => job.run('Reading the scene as an editor…', async sig => { const n = await critique(sc.id, sig); showToast(n ? `${plural(n, 'note')} in the margin` : 'No notes: the scene holds up.') })
  const check = () => job.run(`Reading all of “${st.title}” for continuity…`, sig => continuity(st.id, sig))
  const rewrite = (range: [number, number], dir: string) => { setTool(undefined); job.run('Rewriting the passage…', sig => direct(sc.id, range[0], range[1], dir, sig)) }
  const fixNote = (n: Note) => {
    const at = locate(sc.prose, n.quote)
    if (!at) return job.setErr('That passage is no longer in the text. Select it and use Rewrite.')
    job.run('Suggesting a fix…', sig => direct(sc.id, at[0], at[1], `Fix this: ${n.text}${n.fix ? `\nSuggested fix: ${n.fix}` : ''}`, sig))
  }
  const delScene = () => { tx(`Delete scene “${sc.title || 'Untitled scene'}”`, () => remove(sc.id)); go(next ? 'scene/' + next.id : prev ? 'scene/' + prev.id : 'story/' + st.id) }

  const noCard = !sc.card.trim()
  const assist: (AssistItem | 'sep')[] = [
    { label: 'Draft from card', dest: 'Suggestions', run: draft, disabled: noCard || sc.pinned,
      hint: sc.pinned ? 'Locked: unlock it in ⋯ to redraft' : noCard ? 'Write the scene card first' : sc.prose.trim() ? 'A new draft from the card and the canon, shown over your text' : 'Writes the scene from its card and the canon' },
    tool ? { label: 'Rewrite the selection', hint: `${plural(words(sel), 'word')}: say how it should change`, dest: 'Suggestions', run: () => setTool({ ...tool, mode: 'rewrite' }) }
      : { label: 'Rewrite the whole scene', hint: 'Say how it should change', dest: 'Suggestions', disabled: !sc.prose.trim() || sc.pinned, run: () => setTool({ range: [0, sc.prose.length], mode: 'rewrite' }) },
    { label: 'Fill card from text', hint: sc.prose.trim() ? 'What happens, wants, must land, cast and events, read from the text' : 'Needs text to read', dest: 'Card', disabled: !sc.prose.trim(), run: fillCard },
    'sep',
    { label: 'Get feedback', hint: 'Notes on the scene against its card, voice and canon', dest: 'Margin', disabled: !sc.prose.trim(), run: feedback },
    { label: 'Check continuity', hint: `Reads all of “${st.title}” against the canon`, dest: 'Margin + Questions', run: check },
  ]

  const placeholder = noCard ? 'Write here. Or write the scene card above and use ✦ Assist › Draft from card.' : 'Write here, or use ✦ Assist › Draft from card.'
  if (focus) return (
    <Composition s={s} title={sc.title} words={w} target={sc.target} onExit={() => setFocus(false)}>
      <ProseField value={live || sc.prose} readOnly={!!live} ariaLabel="Scene text" autoFocus areaRef={area} placeholder={placeholder} typewriter={tw}
        onChange={v => edit(x => { x.prose = v })} />
    </Composition>
  )

  const author = (p.author || 'You').trim()[0]?.toUpperCase() || 'Y'
  const noteCard = (n: Note) => <NoteCard key={n.id} n={n} author={author} busy={!!job.busy} ready={ready} onHot={on => setHot(on ? 'n:' + n.id : undefined)}
    onShow={() => { const at = locate(sc.prose, n.quote); if (at) setFlash(at); else showToast('That passage is no longer in the text.') }} onFix={() => fixNote(n)} />
  const suggCard = (h: Hunk, j: number) => <SuggestionCard key={'h' + j} h={h} n={j + 1} of={hunks.length} active={j === k} prose={sc.prose} onFocus={() => goTo(j)}
    onCompare={() => setCompare({ title: 'The new draft from the card', before: sc.prose, after: h.p.replace || '' })} />
  const y = (key: string) => (key in pos ? pos[key] - (pos.__float || 0) : 0)

  return (
    <div className="ed" ref={root}>
      <Bar>
        <div className="crumbs grow"><a href={'#story/' + st.id} className="clip">{st.title || 'Untitled story'}</a><Icon name="chevron" size={12} />
          {chapter && <><a href={'#text/' + chapter.id} className="clip" title="Read and write the whole chapter">{nameOf(s, chapter.id)}</a><Icon name="chevron" size={12} /></>}
          <b className="clip">{sc.title || 'Untitled scene'}</b>
          <span className="scene-of">Scene {i + 1} of {scs.length}</span></div>
        <button className="icon-btn" disabled={!prev} title={prev ? `Previous scene: ${prev.title}` : 'This is the first scene'} aria-label="Previous scene" onClick={() => prev && go('scene/' + prev.id)}><Icon name="left" /></button>
        <button className="icon-btn" disabled={!next} title={next ? `Next scene: ${next.title}` : 'This is the last scene'} aria-label="Next scene" onClick={() => next && go('scene/' + next.id)}><Icon name="right" /></button>
        <button className="icon-btn" title={`Focus mode (${MOD}⇧↵)`} aria-label="Focus mode" onClick={() => setFocus(true)}><Icon name="focus" /></button>
        <span className="bar-sep" />
        <AssistMenu items={assist} busy={job.busy ? 'busy' : undefined} />
        <MoreMenu sc={sc} next={next} caret={caret} onHistory={() => setHistory(true)} onDelete={delScene} onFind={() => dispatchEvent(new CustomEvent('canon:command', { detail: 'find', cancelable: true }))} />
        <span className="bar-sep" />
      </Bar>
      {find && <FindBar find={find} n={matches.length} i={fi} inputRef={findIn} onChange={f => setFind({ ...f, i: f.q !== find.q || f.cs !== find.cs ? 0 : f.i })} onStep={step}
        onReplace={replaceOne} onReplaceAll={replaceAll} onClose={() => { setFind(undefined); area.current?.focus() }} />}
      {hunks.length > 0 && <SuggestionBar hunks={hunks} k={k} folded={folded} prose={sc.prose} onGo={goTo}
        onCompare={h => setCompare({ title: 'The new draft from the card', before: sc.prose, after: h.p.replace || '' })} />}
      <div className={'ed-body' + (folded ? ' folded' : '') + (tw ? ' tw' : '')} ref={body}>
        {folded && <div className="ed-gut" aria-label="Notes, folded while the assistant is open">
          {open.filter(n => ('n:' + n.id) in pos).map(n => (
            <div key={n.id} className="ed-gm-pos" style={{ top: pos['n:' + n.id] }}>
              <Popover trigger={o => <button className={'ed-gm ' + n.by} title={n.text} aria-label="Show note" onClick={o}
                onMouseEnter={() => setHot('n:' + n.id)} onMouseLeave={() => setHot(undefined)}>{n.by === 'check' ? '!' : n.by === 'ai' ? <Spark size={10} /> : author}</button>}>
                {() => <div style={{ width: 300 }}>{noteCard(n)}</div>}
              </Popover>
            </div>
          ))}
        </div>}
        <div className="ed-page">
          <div className="ed-doc">
            <SceneCard s={s} st={st} sc={sc} built={built} compact={folded} busy={!!job.busy} ready={ready} onFill={fillCard} />
            {fill && <CardChanges s={s} sc={sc} fill={fill} onDone={() => setFill(undefined)} />}
            <input className="doc-title" value={sc.title} placeholder="Untitled scene" aria-label="Scene title" onChange={e => edit(x => { x.title = e.target.value })} />
            <JobStatus job={job} />
            <ProseField className="ed-prose" value={live || sc.prose} readOnly={!!live} ariaLabel="Scene text" placeholder={placeholder} ranges={ranges} typewriter={tw}
              areaRef={area} backRef={back} wrapRef={wrap} onChange={v => edit(x => { x.prose = v })}
              onSelect={readSelection} onMouseDown={() => { down.current = true }}
              onKeyDown={e => { if (e.key === 'Escape' && tool) { e.preventDefault(); setTool(undefined) } else if (e.key === 'Escape' && find) { e.preventDefault(); setFind(undefined) } }}>
              {tool && <SelectionTool key={tool.range.join(':') + tool.mode} tool={tool} setTool={setTool} text={sel} whole={tool.range[0] === 0 && tool.range[1] === sc.prose.length}
                pov={st.pov ? firstName(nameOf(s, st.pov)) : ''} ready={ready} busy={!!job.busy}
                top={tool.range[0] === 0 && tool.range[1] === sc.prose.length ? 0 : (pos['z:sel'] ?? 0) - (pos.__wrap ?? 0) + 8} left={Math.max(0, Math.min((pos['x:sel'] ?? 0) - 24, (pos.__w ?? 600) - 520))}
                onRewrite={dir => rewrite(tool.range, dir)}
                onComment={text => { tx('Add comment', () => { create('note', newNote(sc.id, { quote: sel, text })) }, false); setTool(undefined) }}
                onAsk={q => { askAssistant(`About this passage in “${sc.title}”:\n\n“${sel}”${q ? `\n\n${q}` : ''}`); setTool(undefined) }}
                onFormat={format} />}
            </ProseField>
          </div>
        </div>
        {!folded && <aside className="ed-margin" aria-label="Notes">
          <MarginHead sc={sc} open={open.length} busy={!!job.busy} ready={ready} onFeedback={feedback} />
          <div className="ed-float-wrap" ref={floatRef}>
            <Floating items={[
              ...hunks.map((h, j) => ({ k: 'h:' + j, y: h.whole ? 0 : y('h:' + j), node: suggCard(h, j) })),
              ...open.map(n => ({ k: 'n:' + n.id, y: n.quote && ('n:' + n.id) in pos ? y('n:' + n.id) : 0, node: noteCard(n) })),
            ]} />
          </div>
          <Resolved notes={notes.filter(n => n.done)} />
        </aside>}
      </div>
      <footer className="ed-foot">
        <span>{w.toLocaleString()}{sc.target ? ` / ${sc.target.toLocaleString()}` : ''} words</span>
        {sc.target ? <span className="ed-mini" aria-hidden="true"><i style={{ width: Math.min(100, (w / sc.target) * 100) + '%' }} /></span> : null}
        <span>Today {Math.max(0, sessionWords(s)).toLocaleString()}{dailyGoal(s) ? ` / ${dailyGoal(s)!.toLocaleString()}` : ''}</span>
        <span className="grow" />
        <span className="ed-hint">Select text to rewrite or comment · <kbd>{MOD}J</kbd> ask the assistant</span>
        <span className="bar-sep" />
        <button className="btn sm ghost" onClick={() => setHistory(true)}><Icon name="history" size={14} />History{sc.snapshots.length ? ` · ${sc.snapshots.length}` : ''}</button>
      </footer>
      {history && <HistoryDialog sc={sc} onClose={() => setHistory(false)} />}
      {compare && <CompareDialog {...compare} onClose={() => setCompare(undefined)} />}
    </div>
  )
}

/** Cards placed at their anchors' heights, pushed down so they never overlap. */
function Floating({ items }: { items: { k: string; y: number; node: ReactNode }[] }) {
  const refs = useRef(new Map<string, HTMLDivElement>())
  const [tops, setTops] = useState<Record<string, number>>({})
  useLayoutEffect(() => {
    let bottom = 0
    const next: Record<string, number> = {}
    for (const it of [...items].sort((a, b) => a.y - b.y)) { const t = Math.max(it.y, bottom); next[it.k] = t; bottom = t + (refs.current.get(it.k)?.offsetHeight || 0) + 10 }
    if (JSON.stringify(next) !== JSON.stringify(tops)) setTops(next)
  })
  const height = Math.max(0, ...items.map(it => (tops[it.k] ?? it.y) + (refs.current.get(it.k)?.offsetHeight || 0)))
  return (
    <div className="ed-float" style={{ height }}>
      {items.map(it => <div key={it.k} className="ed-float-item" style={{ top: tops[it.k] ?? it.y }} ref={el => { if (el) refs.current.set(it.k, el); else refs.current.delete(it.k) }}>{it.node}</div>)}
    </div>
  )
}

// ---------------- the selection toolbar ----------------

const QUICK = ['Tighter', 'Colder', 'More subtext', 'Cut the metaphor']

function SelectionTool({ tool, setTool, text, whole, pov, ready, busy, top, left, onRewrite, onComment, onAsk, onFormat }: {
  tool: Tool; setTool: (t: Tool | undefined) => void; text: string; whole: boolean; pov: string; ready: boolean; busy: boolean; top: number; left: number
  onRewrite: (dir: string) => void; onComment: (text: string) => void; onAsk: (q: string) => void; onFormat: (cmd: FormatCmd) => void
}) {
  const [v, setV] = useState('')
  const mode = tool.mode
  const set = (m: Mode) => setTool({ ...tool, mode: m === mode ? 'menu' : m })
  const submit = () => { const t = v.trim(); if (mode === 'rewrite' && t) onRewrite(t); else if (mode === 'comment' && t) onComment(t); else if (mode === 'ask') onAsk(t) }
  const quick = [...QUICK, ...(pov ? [`In ${pov}’s voice`] : [])]
  return (
    <div className="ed-tb" role="dialog" aria-label={whole ? 'Rewrite the whole scene' : 'Selection actions'} style={{ top, left }} onMouseDown={e => e.stopPropagation()}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setTool(undefined) } }}>
      <div className="ed-tb-top">
        <button className={mode === 'rewrite' ? 'on' : ''} onClick={() => set('rewrite')}><Spark size={13} />Rewrite</button>
        {!whole && <button className={mode === 'comment' ? 'on' : ''} onClick={() => set('comment')}><Icon name="comment" size={14} />Comment</button>}
        {!whole && <button className={mode === 'ask' ? 'on' : ''} onClick={() => set('ask')}>Ask about this</button>}
        {!whole && mode === 'menu' && <span className="ed-tb-fmt" role="group" aria-label="Format">
          <button title={`Bold (${MOD}B)`} aria-label="Bold" onClick={() => onFormat('bold')}><b>B</b></button>
          <button title={`Italic (${MOD}I)`} aria-label="Italic" onClick={() => onFormat('italic')}><i>I</i></button>
          <button title="Block quote" aria-label="Block quote" onClick={() => onFormat('quote')}>❝</button>
          <button title="Make it a footnote" aria-label="Footnote" onClick={() => onFormat('footnote')}><sup>fn</sup></button>
        </span>}
        <span className="grow" />
        <span className="ed-tb-n">{whole ? 'Whole scene · ' : ''}{plural(words(text), 'word')}</span>
        <button className="x" aria-label="Close" onClick={() => setTool(undefined)}>×</button>
      </div>
      {mode !== 'menu' && <div className="ed-tb-in">
        {mode !== 'comment' && !ready ? <ConnectPrompt compact what={mode === 'rewrite' ? 'rewrite passages' : 'ask about the text'} /> : <>
          <label className="ed-tb-field">
            {mode === 'comment'
              ? <textarea autoFocus value={v} rows={2} placeholder="Your note on this passage" onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }} />
              : <input autoFocus value={v} placeholder={mode === 'rewrite' ? (whole ? 'How should the scene change? Slower; less said; end on the bell' : 'How should it change? Slower; let her notice the smell first') : 'What do you want to know? (optional)'}
                onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} />}
            <button className="btn sm" disabled={busy || (mode !== 'ask' && !v.trim())} onClick={submit}>{mode === 'rewrite' ? 'Rewrite' : mode === 'comment' ? 'Comment' : 'Ask'} <kbd>↵</kbd></button>
          </label>
          {mode === 'rewrite' && <div className="ed-tb-quick">{quick.map(q => <button key={q} disabled={busy} onClick={() => onRewrite(q)}>{q}</button>)}</div>}
          <div className="ed-tb-cap">{mode === 'rewrite' ? 'Comes back as a suggestion in the text. Nothing changes until you accept it.' : mode === 'comment' ? 'Lands in the margin, next to the passage.' : 'Opens the assistant with this passage quoted.'}</div>
        </>}
      </div>}
    </div>
  )
}

// ---------------- suggestions ----------------

function SuggestionBar({ hunks, k, folded, prose, onGo, onCompare }: { hunks: Hunk[]; k: number; folded: boolean; prose: string; onGo: (j: number) => void; onCompare: (h: Hunk) => void }) {
  const h = hunks[k]
  const from = [...new Set(hunks.map(x => x.who === 'Assistant' ? 'the assistant' : x.who === 'Rewrite' ? 'your rewrites' : 'the card'))].join(' and ')
  return (
    <div className="ed-sbar-wrap">
      <div className="ed-sbar" role="region" aria-label="Suggestions">
        <Spark size={14} />
        <b>{plural(hunks.length, 'suggestion')}</b><span className="muted clip">from {from} · you can keep writing</span>
        <span className="grow" />
        <button className="icon-btn sm" aria-label="Previous suggestion" disabled={k <= 0} onClick={() => onGo(k - 1)}><Icon name="left" size={14} /></button>
        <span className="small">{k + 1} of {hunks.length}</span>
        <button className="icon-btn sm" aria-label="Next suggestion" disabled={k >= hunks.length - 1} onClick={() => onGo(k + 1)}><Icon name="right" size={14} /></button>
        <button className="btn sm" onClick={() => rejectAll(hunks)}>Reject all</button>
        <button className="btn sm ins" onClick={() => acceptAll(hunks)}>Accept all</button>
      </div>
      {folded && h && <div className="ed-sbar-detail"><SuggestionCard key={k} h={h} n={k + 1} of={hunks.length} active prose={prose} flat onFocus={() => onGo(k)} onCompare={() => onCompare(h)} /></div>}
    </div>
  )
}

function SuggestionCard({ h, n, of, active, prose, flat, onFocus, onCompare }: { h: Hunk; n: number; of: number; active: boolean; prose: string; flat?: boolean; onFocus: () => void; onCompare: () => void }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(h.p.replace || '')
  const save = () => { if (v !== h.p.replace) h.edit?.(v); setEditing(false) }
  return (
    <div className={'ed-card-s' + (active ? ' on' : '') + (flat ? ' flat' : '')} role="group" aria-label={`Suggestion ${n} of ${of}`} onClick={onFocus}>
      <div className="ed-who"><span className="ed-av ai"><Spark size={10} /></span><b>{h.who}</b>{h.source && <span className="lbl clip">{h.source}</span>}</div>
      {h.p.why && <div className="ed-why">{h.p.why}</div>}
      {h.whole
        ? <div className="ed-why">A new draft of the whole scene: {plural(words(h.p.replace || ''), 'word')}, now {plural(words(prose), 'word')}. If you accept, your text is kept in History. <button className="link" onClick={e => { e.stopPropagation(); onCompare() }}>Compare</button></div>
        : editing ? <textarea className="f" autoFocus value={v} onClick={e => e.stopPropagation()} onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save() }} />
          : <div className="ed-diff"><Diff parts={diffWords(h.p.find || '', h.p.replace || '')} /></div>}
      <div className="ed-act" onClick={e => e.stopPropagation()}>
        <button className="btn sm ins" onClick={() => {
          if (editing && v !== h.p.replace) h.edit?.(v)
          // A local suggestion was edited in place; a chat's is copied with the new text.
          accept(!editing || h.p.replace === v ? h : { ...h, p: { ...h.p, replace: v } })
        }}>Accept</button>
        <button className="btn sm" onClick={h.reject}>Reject</button>
        <span className="grow" />
        {h.edit && !h.whole && <button className="btn sm ghost" onClick={() => (editing ? save() : setEditing(true))}>{editing ? 'Done editing' : 'Edit before accepting'}</button>}
      </div>
    </div>
  )
}

// ---------------- notes in the margin ----------------

function MarginHead({ sc, open, busy, ready, onFeedback }: { sc: Scene; open: number; busy: boolean; ready: boolean; onFeedback: () => void }) {
  const [connect, setConnect] = useState(false)
  const [adding, setAdding] = useState(false)
  const [v, setV] = useState('')
  const add = () => { if (v.trim()) tx('Add note', () => { create('note', newNote(sc.id, { text: v.trim() })) }, false); setV(''); setAdding(false) }
  return (
    <div className="ed-mh">
      <div className="row nowrap"><b>Notes</b><span className="lbl">{open ? `${open} open` : 'none open'}</span><span className="grow" />
        <button className="btn sm soft" disabled={busy || !sc.prose.trim()} title={sc.prose.trim() ? 'Notes on the scene against its card, voice and canon' : 'Needs text to read'}
          onClick={() => (ready ? onFeedback() : setConnect(c => !c))}><Spark size={12} />Get feedback</button></div>
      {connect && !ready && <ConnectPrompt compact what="get feedback" />}
      {adding ? <div className="ed-add">
        <textarea className="f" autoFocus value={v} placeholder="A note on the whole scene" onChange={e => setV(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add() } else if (e.key === 'Escape') setAdding(false) }} />
        <div className="row"><button className="btn sm" disabled={!v.trim()} onClick={add}>Add note</button><button className="btn sm ghost" onClick={() => setAdding(false)}>Cancel</button></div>
      </div> : <button className="btn sm ghost ed-addbtn" onClick={() => setAdding(true)}><Icon name="plus" size={13} />Note on the scene</button>}
    </div>
  )
}

const SEV: Record<string, string> = { critical: 'Critical', error: 'Error', warning: 'Warning', note: 'Note' }

function NoteCard({ n, author, busy, ready, onHot, onShow, onFix }: { n: Note; author: string; busy: boolean; ready: boolean; onHot: (on: boolean) => void; onShow: () => void; onFix: () => void }) {
  const [reply, setReply] = useState<string>()
  const [connect, setConnect] = useState(false)
  const who = n.by === 'you' ? 'You' : n.by === 'ai' ? 'Assistant' : 'Continuity check'
  const sub = n.by === 'you' ? `${n.quote ? 'on a passage' : 'on the scene'} · ${ago(n.at)}` : n.by === 'ai' ? n.topic || 'Feedback' : SEV[n.severity || 'warning'] || 'Warning'
  const send = () => {
    if (!reply?.trim()) return setReply(undefined)
    tx('Reply to note', () => { create('note', newNote(n.scene, { quote: n.quote, text: reply.trim(), topic: 'Reply' })) }, false)
    setReply(undefined)
  }
  return (
    <div className={'ed-note ' + n.by + (n.done ? ' done' : '')} onMouseEnter={() => onHot(true)} onMouseLeave={() => onHot(false)}>
      <div className="ed-who">
        <span className={'ed-av ' + n.by}>{n.by === 'ai' ? <Spark size={10} /> : n.by === 'check' ? '!' : author}</span><b>{who}</b><span className="lbl clip">· {sub}</span>
        <span className="grow" /><button className="x hover-only" aria-label="Delete note" title="Delete note" onClick={() => tx('Delete note', () => remove(n.id))}>×</button>
      </div>
      {n.quote && <button className="ed-q" title="Show the passage" onClick={onShow}>{n.quote}</button>}
      <div className="ed-text">{n.text}</div>
      {n.fix && <div className="ed-why"><span className="lbl">Suggested fix</span> {n.fix}</div>}
      {connect && !ready && <ConnectPrompt compact what="suggest fixes" />}
      {reply !== undefined && <textarea className="f" autoFocus value={reply} placeholder="Your reply" onChange={e => setReply(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } else if (e.key === 'Escape') setReply(undefined) }} />}
      <div className="ed-act">
        {n.done ? <button className="btn sm ghost" onClick={() => update<'note'>(n.id, x => { x.done = false })}>Reopen</button> : <>
          {n.by !== 'you' && n.quote && <button className="btn sm soft" disabled={busy} title="A rewrite of the passage that addresses the note, as a suggestion" onClick={() => (ready ? onFix() : setConnect(c => !c))}>Suggest a fix</button>}
          {reply === undefined ? <button className="btn sm ghost" onClick={() => setReply('')}>Reply</button> : <button className="btn sm" onClick={send}>Send reply</button>}
          <button className="btn sm ghost" onClick={() => update<'note'>(n.id, x => { x.done = true })}>Resolve</button>
        </>}
      </div>
    </div>
  )
}

function Resolved({ notes }: { notes: Note[] }) {
  const [open, setOpen] = useState(false)
  if (!notes.length) return null
  return (
    <div className="ed-resolved">
      <button className="btn sm ghost" onClick={() => setOpen(o => !o)}><Icon name={open ? 'down' : 'chevron'} size={12} />{plural(notes.length, 'resolved note')}</button>
      {open && notes.map(n => (
        <div key={n.id} className="ed-note done">
          {n.quote && <span className="ed-q">{n.quote}</span>}
          <div className="ed-text">{n.text}</div>
          <div className="ed-act"><button className="btn sm ghost" onClick={() => update<'note'>(n.id, x => { x.done = false })}>Reopen</button>
            <button className="btn sm ghost danger" onClick={() => tx('Delete note', () => remove(n.id))}>Delete</button></div>
        </div>
      ))}
    </div>
  )
}

// ---------------- the scene card and its properties ----------------

function SceneCard({ s, st, sc, built, compact, busy, ready, onFill }: { s: State; st: Story; sc: Scene; built: ReturnType<typeof builtState>; compact: boolean; busy: boolean; ready: boolean; onFill: () => void }) {
  const edit = (fn: (x: Scene) => void) => update<'scene'>(sc.id, fn)
  const empty = !sc.card.trim()
  const [editing, setEditing] = useState(empty && !sc.prose.trim())
  const [expanded, setExpanded] = useState(false)
  const status = statusOf(s, sc.status)
  const docs = st.form === 'documents'
  const landed = new Set((sc.meta?.landed || '').split('\n').filter(Boolean))
  const must = sc.mustLand.filter(m => m.trim())
  const flag = (built === 'built' || built === 'stale') && <span className={'chip ' + BUILT[built].cls} title={BUILT[built].hint}>{BUILT[built].label}</span>
  if (compact && !expanded && !editing) return (
    <button className="ed-cardrow" onClick={() => setExpanded(true)} title="Show the scene card">
      <span className="lbl">Scene card</span><p>{sc.card || 'No card yet'}</p>
      <StatusPill st={status} /><Icon name="down" size={12} />
    </button>
  )
  return (
    <section className="ed-card" aria-label="Scene card">
      <div className="row nowrap"><span className="lbl">Scene card</span>{flag}<span className="grow" />
        {compact && !editing && <button className="btn sm ghost" onClick={() => setExpanded(false)}>Fold</button>}
        <button className="btn sm ghost" onClick={() => setEditing(e => !e)}>{editing ? 'Done' : 'Edit card'}</button></div>
      {editing ? <div className="stack">
        <Area label={docs ? 'What the document is and does' : 'What happens'} value={sc.card} autoFocus={empty} placeholder="What happens, and what changes" onChange={v => edit(x => { x.card = v })} />
        {!docs && <Area label="What each person wants" value={sc.wants} placeholder="Who wants what here, and what stands in the way" onChange={v => edit(x => { x.wants = v })} />}
        <Area label="Must land · one per line" value={sc.mustLand.join('\n')} placeholder="A line, an image or a turn the scene has to deliver" onChange={v => edit(x => { x.mustLand = v.split('\n') })} />
      </div> : <>
        {empty ? <div className="ed-nocard"><span className="muted">{sc.prose.trim() ? 'No card yet. The card is what drafting, checks and the outline work from.' : 'No card yet: say what happens in this scene.'}</span>
          {sc.prose.trim() ? <button className="btn sm soft" disabled={busy || !ready} title={ready ? 'Reads the text and proposes a card' : 'Connect an assistant in Settings'} onClick={onFill}><Spark size={12} />Fill card from text</button>
            : <button className="btn sm" onClick={() => setEditing(true)}>Write the card</button>}</div>
          : <p className="ed-what">{sc.card}</p>}
        {sc.wants.trim() && <p className="ed-wants"><span className="lbl">Wants</span>{sc.wants}</p>}
        {must.length > 0 && <div className="ed-must">{must.map((m, j) => (
          <label key={j} className={'ed-must-i' + (landed.has(m) ? ' on' : '')} title={landed.has(m) ? 'Landed' : 'Tick it once the text delivers it'}>
            <span className="lbl ed-must-l">{j === 0 ? 'Must land' : ''}</span>
            <input type="checkbox" checked={landed.has(m)} onChange={() => edit(x => { const l = new Set((x.meta?.landed || '').split('\n').filter(Boolean)); if (l.has(m)) l.delete(m); else l.add(m); x.meta = { ...x.meta, landed: [...l].join('\n') } })} />
            <span>{m}</span></label>))}</div>}
      </>}
      <Props s={s} st={st} sc={sc} />
    </section>
  )
}

type PropKey = 'status' | 'beat' | 'label' | 'cast' | 'shows' | 'target' | 'tags' | `field:${string}`

function Props({ s, st, sc }: { s: State; st: Story; sc: Scene }) {
  const p = project(s), labels = p.labels || {}
  const fields = p.sceneFields || []
  const status = statusOf(s, sc.status)
  const chip = (key: PropKey, label: ReactNode) =>
    <Popover key={key} trigger={o => <button className="chip ed-chip" onClick={o}>{label}</button>}>{close => <PropEditor s={s} st={st} sc={sc} k={key} close={close} />}</Popover>
  const linkName = (id: string) => eventCode(s, id) || (nameOf(s, id).length > 22 ? nameOf(s, id).slice(0, 20) + '…' : nameOf(s, id)) || 'Missing'
  const on = Object.entries(sc.links).filter(([, v]) => v === 'on').map(([id]) => id), felt = Object.entries(sc.links).filter(([, v]) => v === 'felt').map(([id]) => id)
  const shown = new Set<string>(['status'])
  const out: ReactNode[] = [chip('status', <><StatusPill st={status} /><Icon name="down" size={10} /></>)]
  const add = (key: PropKey, has: boolean, label: () => ReactNode) => { if (has) { shown.add(key); out.push(chip(key, label())) } }
  add('beat', !!sc.beat, () => <><span className="k">Beat</span>{sc.beat}</>)
  add('label', !!sc.label, () => <><i className="dot" style={{ background: labelColor(sc.label) }} />{labels[sc.label!] || sc.label}</>)
  add('cast', sc.cast.length > 0, () => <><span className="k">Cast</span><span className="clip">{sc.cast.map(c => nameOf(s, c).replace(/^The /, '') || 'Missing').join(' · ')}</span></>)
  add('shows', on.length + felt.length > 0, () => <><span className="k">Shows</span>{on.map(linkName).join(' ')}{felt.length > 0 && <><span className="k">· felt</span>{felt.map(linkName).join(' ')}</>}</>)
  add('target', !!sc.target, () => <><span className="k">Target</span>{sc.target!.toLocaleString()}</>)
  add('tags', (sc.tags || []).filter(Boolean).length > 0, () => <><span className="k">Tags</span>{(sc.tags || []).filter(Boolean).join(', ')}</>)
  for (const f of fields) add(`field:${f.key}`, !!sc.meta?.[f.key], () => <><span className="k">{f.label}</span>{f.kind === 'check' ? 'Yes' : sc.meta![f.key]}</>)
  const missing: [PropKey, string][] = ([['beat', 'Beat'], ['label', 'Label'], ['cast', 'Cast and setting'], ['shows', 'Events and facts it shows'], ['target', 'Target words'], ['tags', 'Tags']] as [PropKey, string][])
    .concat(fields.map(f => [`field:${f.key}`, f.label || 'Untitled field'] as [PropKey, string])).filter(([key]) => !shown.has(key))
  return (
    <div className="ed-props">
      {out}
      {sc.pinned && <Popover trigger={o => <button className="chip ed-chip" onClick={o}><Icon name="lock" size={12} />Locked</button>}>{close => <div className="ed-pedit">
        <p className="small">Locked: the assistant won’t redraft this scene.</p><button className="btn sm" onClick={() => { tx('Unlock scene', () => update<'scene'>(sc.id, x => { x.pinned = false })); close() }}>Unlock</button></div>}</Popover>}
      {sc.exclude && <Popover trigger={o => <button className="chip ed-chip" onClick={o}><Icon name="eye" size={12} />Left out of export</button>}>{close => <div className="ed-pedit">
        <p className="small">This scene is skipped when you export.</p><button className="btn sm" onClick={() => { update<'scene'>(sc.id, x => { x.exclude = false }); close() }}>Include it again</button></div>}</Popover>}
      <Popover trigger={o => <button className="chip dash ed-chip" onClick={o}>+ Property</button>}>{close => <AddProp s={s} st={st} sc={sc} missing={missing} close={close} />}</Popover>
    </div>
  )
}

function AddProp({ s, st, sc, missing, close }: { s: State; st: Story; sc: Scene; missing: [PropKey, string][]; close: () => void }) {
  const [k, setK] = useState<PropKey>()
  if (k) return <PropEditor s={s} st={st} sc={sc} k={k} close={close} />
  return <div className="ed-pedit" style={{ padding: 0 }}>
    {missing.map(([key, label]) => <button key={key} className="menu-item" onClick={() => setK(key)}>{label}</button>)}
    {missing.length > 0 && <div className="menu-sep" />}
    <button className="menu-item" onClick={() => { close(); openSettings('labels') }}><span className="grow">Custom scene fields…</span><span className="lbl">Settings</span></button>
  </div>
}

function PropEditor({ s, st, sc, k, close }: { s: State; st: Story; sc: Scene; k: PropKey; close: () => void }) {
  const edit = (fn: (x: Scene) => void) => update<'scene'>(sc.id, fn)
  const p = project(s), labels = p.labels || {}
  const [q, setQ] = useState('')
  if (k === 'status') { const cur = statusOf(s, sc.status).id; return <div className="ed-pedit" style={{ padding: 0 }}>{statusesOf(s).map(x => (
    <button key={x.id} className={'menu-item' + (cur === x.id ? ' on' : '')} onClick={() => { edit(y => { y.status = x.id }); close() }}>
      <StatusPill st={x} /><span className="grow" />{cur === x.id && <Icon name="check" size={14} />}</button>))}
    <div className="menu-sep" /><button className="menu-item" onClick={() => { close(); openSettings('labels') }}><span className="grow">Edit statuses…</span><span className="lbl">Settings</span></button></div> }
  if (k === 'beat') {
    const beats = [...new Set([...st.beats, sc.beat].filter(Boolean))]
    return <div className="ed-pedit">
      <span className="lbl">Beat</span>
      {beats.map(b => <button key={b} className={'menu-item' + (sc.beat === b ? ' on' : '')} onClick={() => { edit(x => { x.beat = b }); close() }}>{b}</button>)}
      {!st.beats.length && <p className="small muted">“{st.title}” has no beats yet. Add them in Story details on the outline, or type one.</p>}
      <input className="f" value={q} placeholder="Another beat" onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && q.trim()) { edit(x => { x.beat = q.trim() }); close() } }} />
      {sc.beat && <button className="btn sm ghost" onClick={() => { edit(x => { x.beat = '' }); close() }}>No beat</button>}
    </div>
  }
  if (k === 'label') return <div className="ed-pedit" style={{ padding: 0 }}>
    {LABELS.map(l => <button key={l} className={'menu-item' + (sc.label === l ? ' on' : '')} onClick={() => { edit(x => { x.label = l }); close() }}><i className="dot" style={{ background: labelColor(l) }} />{labels[l] || l}</button>)}
    {sc.label && <><div className="menu-sep" /><button className="menu-item" onClick={() => { edit(x => { x.label = undefined }); close() }}>No label</button></>}
    <div className="menu-sep" /><button className="menu-item" onClick={() => { close(); openSettings('labels') }}><span className="grow">Name the labels…</span><span className="lbl">Settings</span></button>
  </div>
  if (k === 'cast') return <div className="ed-pedit">
    <span className="lbl">Cast and setting</span>
    {sc.cast.map(c => <div key={c} className="row nowrap"><a className="grow clip" href={'#world/' + c} title="Open. ⌥-click to open it beside this scene.">{nameOf(s, c) || 'Missing'}</a><button className="x" aria-label="Remove" onClick={() => edit(x => { x.cast = x.cast.filter(y => y !== c) })}>×</button></div>)}
    <input className="f" autoFocus value={q} placeholder="Add someone or somewhere" onChange={e => setQ(e.target.value)} />
    <div className="ed-pick">{typeIds(s).map(t => {
      const xs = entities(s, t).filter(e => !sc.cast.includes(e.id) && e.name.toLowerCase().includes(q.toLowerCase()))
      return xs.length ? <div key={t}><span className="lbl ed-pick-h">{typeDef(s, t).label}</span>{xs.map(e => <button key={e.id} className="menu-item" onClick={() => { edit(x => { x.cast.push(e.id) }); setQ('') }}>{e.name}</button>)}</div> : null
    })}</div>
  </div>
  if (k === 'shows') return <div className="ed-pedit" style={{ width: 340 }}>
    <span className="lbl">Events and facts this scene shows</span>
    {Object.entries(sc.links).map(([id, how]) => <div key={id} className="row nowrap">
      <a className="grow clip" href={'#' + hrefOf(s, id)} title="Open. ⌥-click to open it beside this scene.">{nameOf(s, id) || 'Missing'}</a>
      <div className="seg"><button className={how === 'on' ? 'on' : ''} title="Shown on the page" onClick={() => edit(x => { x.links[id] = 'on' })}>On the page</button><button className={how === 'felt' ? 'on' : ''} title="The effect, not the cause" onClick={() => edit(x => { x.links[id] = 'felt' })}>Felt</button></div>
      <button className="x" aria-label="Remove" onClick={() => edit(x => { delete x.links[id] })}>×</button></div>)}
    <RecordPicker s={s} kinds={['fact']} label="+ Event or fact" exclude={Object.keys(sc.links)} onPick={id => edit(x => { x.links[id] = 'on' })} />
  </div>
  if (k === 'target') return <div className="ed-pedit">
    <span className="lbl">Target words</span>
    <input className="f" type="number" min={0} step={100} autoFocus value={sc.target || ''} onChange={e => edit(x => { x.target = Number(e.target.value) || undefined })} onKeyDown={e => { if (e.key === 'Enter') close() }} />
  </div>
  if (k === 'tags') return <div className="ed-pedit">
    <span className="lbl">Tags, comma-separated</span>
    <input className="f" autoFocus value={(sc.tags || []).join(', ')} placeholder="flashback, harbour" onChange={e => edit(x => { x.tags = e.target.value.split(',').map(t => t.trimStart()) })} onKeyDown={e => { if (e.key === 'Enter') close() }} />
  </div>
  const f = (p.sceneFields || []).find(x => `field:${x.key}` === k) as MetaField | undefined
  if (!f) return null
  const v = sc.meta?.[f.key] || '', set = (val: string) => edit(x => { x.meta = { ...x.meta, [f.key]: val } })
  return <div className="ed-pedit">
    <span className="lbl">{f.label}</span>
    {f.kind === 'check' ? <label className="row nowrap"><input type="checkbox" checked={v === 'yes'} onChange={e => set(e.target.checked ? 'yes' : '')} />{f.label}</label>
      : f.kind === 'list' ? (f.options || []).filter(Boolean).map(o => <button key={o} className={'menu-item' + (v === o ? ' on' : '')} onClick={() => { set(v === o ? '' : o); close() }}>{o}</button>)
        : <input className="f" autoFocus type={f.kind === 'date' ? 'date' : 'text'} value={v} onChange={e => set(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') close() }} />}
  </div>
}

/** "Fill card from text" comes back as proposed changes to the card. */
function CardChanges({ s, sc, fill, onDone }: { s: State; sc: Scene; fill: CardFill; onDone: () => void }) {
  const [off, setOff] = useState(new Set<keyof CardFill>())
  const rows: { k: keyof CardFill; where: string; before?: string; after: string }[] = []
  if (fill.title) rows.push({ k: 'title', where: 'Title', before: sc.title, after: fill.title })
  if (fill.card) rows.push({ k: 'card', where: 'Scene card › What happens', before: sc.card, after: fill.card })
  if (fill.wants) rows.push({ k: 'wants', where: 'Scene card › Wants', before: sc.wants, after: fill.wants })
  if (fill.mustLand) rows.push({ k: 'mustLand', where: 'Scene card › Must land', before: sc.mustLand.join('\n'), after: fill.mustLand.join('\n') })
  if (fill.beat) rows.push({ k: 'beat', where: 'Beat', before: sc.beat, after: fill.beat })
  if (fill.cast) rows.push({ k: 'cast', where: 'Cast and setting', after: fill.cast.map(id => nameOf(s, id)).join(' · ') })
  if (fill.links) rows.push({ k: 'links', where: 'Shows', after: Object.entries(fill.links).map(([id, v]) => `${nameOf(s, id)}${v === 'felt' ? ' (felt)' : ''}`).join(' · ') })
  const picked = rows.filter(r => !off.has(r.k))
  const apply = () => { tx('Fill card from text', () => applyCardFill(sc.id, Object.fromEntries(picked.map(r => [r.k, fill[r.k]])) as CardFill)); onDone() }
  return (
    <div className="changes-box" role="group" aria-label="Proposed changes to the card">
      <div className="changes-h"><span className="spark-ic"><Spark size={12} /></span><b>Proposed changes to the card</b><span className="lbl">{picked.length} of {rows.length} selected</span></div>
      {rows.map(r => (
        <label key={r.k} className="change-row">
          <input type="checkbox" checked={!off.has(r.k)} onChange={() => setOff(o => { const n = new Set(o); if (n.has(r.k)) n.delete(r.k); else n.add(r.k); return n })} aria-label="Include this change" />
          <span className="change-body"><span className="change-one"><span className="lbl">{r.where}</span>
            <span className="change-text">{r.before?.trim() ? <Diff parts={diffWords(r.before, r.after)} /> : <ins>{r.k === 'cast' || r.k === 'links' ? '+ ' : ''}{r.after}</ins>}</span></span></span>
        </label>
      ))}
      <div className="changes-foot"><button className="btn sm pri" disabled={!picked.length} onClick={apply}>{picked.length === 1 ? 'Apply 1 change' : `Apply ${picked.length} changes`}</button><button className="btn sm ghost" onClick={onDone}>Discard</button></div>
    </div>
  )
}

// ---------------- ⋯: lock, export, split, merge, history, delete ----------------

function MoreMenu({ sc, next, caret, onHistory, onDelete, onFind }: { sc: Scene; next?: Scene; caret: React.RefObject<number>; onHistory: () => void; onDelete: () => void; onFind: () => void }) {
  const item = (close: () => void, label: string, hint: string, run: () => void, opts: { icon: string; disabled?: boolean; danger?: boolean; on?: boolean }) =>
    <button className={'assist-item ed-more-i' + (opts.danger ? ' danger' : '')} role="menuitem" disabled={opts.disabled} onClick={() => { close(); run() }}>
      <Icon name={opts.icon} size={15} /><span className="t"><b>{label}</b><span>{hint}</span></span>{opts.on && <Icon name="check" size={14} />}</button>
  return (
    <Popover className="right" trigger={o => <button className="icon-btn" aria-label="More scene actions" title="More scene actions" onClick={o}><Icon name="more" /></button>}>
      {close => {
        const at = caret.current ?? 0
        const canSplit = !!sc.prose.trim() && at > 0 && at < sc.prose.length
        return <div className="assist-menu" role="menu" aria-label="Scene actions">
          {item(close, sc.pinned ? 'Unlock' : 'Lock', sc.pinned ? 'Locked: the assistant won’t redraft it' : 'The assistant won’t redraft a locked scene', () => tx(sc.pinned ? 'Unlock scene' : 'Lock scene', () => update<'scene'>(sc.id, x => { x.pinned = !x.pinned })), { icon: sc.pinned ? 'unlock' : 'lock' })}
          {item(close, 'Leave out of export', sc.exclude ? 'Skipped when you export' : 'Keep it in the project, skip it when you export', () => update<'scene'>(sc.id, x => { x.exclude = !x.exclude }), { icon: 'eye', on: !!sc.exclude })}
          {item(close, 'Export this scene…', 'Word, PDF, EPUB and more, just this scene', () => exportSelection([sc.id]), { icon: 'upload' })}
          <div className="menu-sep" />
          {item(close, 'Find and replace…', `In this scene (${MOD}F)`, onFind, { icon: 'find' })}
          {item(close, 'Open in the reference pane', 'Keep it beside you while you work elsewhere', () => openReference(sc.id), { icon: 'split' })}
          <div className="menu-sep" />
          {item(close, 'Split at the cursor', canSplit ? 'The text after the cursor becomes a new scene' : 'Put the cursor where the new scene should start', () => splitAt(sc, at), { icon: 'split', disabled: !canSplit })}
          {item(close, 'Merge with the next scene', next ? `Appends “${next.title || 'Untitled scene'}” to this one` : 'This is the last scene of the story', () => mergeNext(sc), { icon: 'merge', disabled: !next })}
          <div className="menu-sep" />
          {item(close, 'History…', `${plural(sc.snapshots.length, 'saved version')} of the text, and every change`, onHistory, { icon: 'history' })}
          {item(close, 'Delete scene', 'You can undo it', onDelete, { icon: 'trash', danger: true })}
        </div>
      }}
    </Popover>
  )
}

// ---------------- history: versions of the text, and every change ----------------

function HistoryDialog({ sc, onClose }: { sc: Scene; onClose: () => void }) {
  const [tab, setTab] = useState<'text' | 'all'>('text')
  const [cmp, setCmp] = useState<number>()
  const [name, setName] = useState('')
  const parts = useMemo(() => (cmp === undefined ? [] : diffText(sc.snapshots[cmp]?.text || '', sc.prose)), [cmp, sc])
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; addEventListener('keydown', esc); return () => removeEventListener('keydown', esc) }, [onClose])
  const save = () => { tx('Save a version', () => update<'scene'>(sc.id, x => { x.snapshots = [{ text: x.prose, at: new Date().toISOString(), name: name.trim() || `Version ${x.snapshots.filter(t => t.name).length + 1}` }, ...x.snapshots] })); setName('') }
  const restore = (j: number) => { const t = sc.snapshots[j]; tx('Restore a version', () => update<'scene'>(sc.id, x => { const cur = x.prose; x.prose = t.text; x.snapshots[j] = { text: cur, at: new Date().toISOString(), name: 'Before restore' } })); setCmp(undefined) }
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette ed-hist" onMouseDown={e => e.stopPropagation()} role="dialog" aria-label="History">
        <div className="ed-hist-h"><div className="grow clip"><b>History</b><span className="muted small"> · {sc.title || 'Untitled scene'}</span></div>
          <div className="seg"><button className={tab === 'text' ? 'on' : ''} onClick={() => setTab('text')}>Versions of the text{sc.snapshots.length ? ` · ${sc.snapshots.length}` : ''}</button><button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>Every change</button></div>
          <button className="x" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="ed-hist-b">
          {tab === 'all' ? <History id={sc.id} render={prev => typeof prev.prose === 'string' && prev.prose !== sc.prose ? <div className="review ed-hist-diff"><Diff parts={diffText(prev.prose, sc.prose)} /></div>
            : <p className="small muted">The text was the same as now; the card or the properties changed.</p>} /> : <>
            <div className="row nowrap"><input className="f" value={name} placeholder="Name this version (optional): before the cut" onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') save() }} />
              <button className="btn" disabled={!sc.prose.trim()} onClick={save}>Save this version</button></div>
            <p className="small muted">Drafts, rewrites, splits, merges and accepted suggestions keep the text they replaced here automatically.</p>
            {!sc.snapshots.length && <p className="small muted">No earlier versions yet.</p>}
            {sc.snapshots.map((t, j) => (
              <div key={j} className={'ed-ver' + (cmp === j ? ' on' : '')}>
                <div className="grow"><b className="small">{t.name || 'Automatic'}</b><div className="small muted">{new Date(t.at).toLocaleString()} · {plural(words(t.text), 'word')}</div></div>
                <button className="btn sm ghost" onClick={() => setCmp(cmp === j ? undefined : j)}>{cmp === j ? 'Hide' : 'Compare with now'}</button>
                <button className="btn sm" onClick={() => restore(j)}>Restore</button>
              </div>
            ))}
            {cmp !== undefined && <><div className="small"><del>removed since</del> · <ins>added since</ins></div><div className="review ed-hist-diff"><Diff parts={parts} /></div></>}
          </>}
        </div>
      </div>
    </div>
  )
}

function CompareDialog({ title, before, after, onClose }: { title: string; before: string; after: string; onClose: () => void }) {
  const parts = useMemo(() => diffText(before, after), [before, after])
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; addEventListener('keydown', esc); return () => removeEventListener('keydown', esc) }, [onClose])
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette ed-hist" onMouseDown={e => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="ed-hist-h"><b className="grow">{title}</b><span className="small"><del>your text</del> · <ins>the new draft</ins></span><button className="x" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="ed-hist-b"><div className="review ed-hist-diff" style={{ maxHeight: 'none' }}><Diff parts={parts} /></div></div>
      </div>
    </div>
  )
}

// ---------------- find and replace in the scene ----------------

function FindBar({ find, n, i, inputRef, onChange, onStep, onReplace, onReplaceAll, onClose }: {
  find: Find; n: number; i: number; inputRef: React.RefObject<HTMLInputElement | null>; onChange: (f: Find) => void; onStep: (d: number) => void
  onReplace: () => void; onReplaceAll: () => void; onClose: () => void
}) {
  const keys = (e: React.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
  return (
    <div className="ed-find" role="search" aria-label="Find in this scene" onKeyDown={keys}>
      <label className="ed-find-f"><Icon name="find" size={14} /><input ref={inputRef} value={find.q} placeholder="Find in this scene" aria-label="Find"
        onChange={e => onChange({ ...find, q: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onStep(e.shiftKey ? -1 : 1) } }} />
        <span className="ed-find-n">{find.q ? (n ? `${i + 1} of ${n}` : 'No matches') : ''}</span></label>
      <button className="icon-btn sm" aria-label="Previous match" title="Previous (⇧↵)" disabled={!n} onClick={() => onStep(-1)}><Icon name="left" size={14} /></button>
      <button className="icon-btn sm" aria-label="Next match" title="Next (↵)" disabled={!n} onClick={() => onStep(1)}><Icon name="right" size={14} /></button>
      <button className={'ed-find-cs' + (find.cs ? ' on' : '')} aria-pressed={find.cs} title="Match case" onClick={() => onChange({ ...find, cs: !find.cs })}>Aa</button>
      <span className="bar-sep" />
      <label className="ed-find-f rep"><input value={find.rep} placeholder="Replace with" aria-label="Replace with" onChange={e => onChange({ ...find, rep: e.target.value })}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onReplace() } }} /></label>
      <button className="btn sm" disabled={!n} onClick={onReplace}>Replace</button>
      <button className="btn sm" disabled={!n} onClick={onReplaceAll}>All</button>
      <span className="grow" />
      <a className="small muted ed-find-all" href="#find" title={`Find and replace across the project (${MOD}⇧F)`}>Whole project…</a>
      <button className="x" aria-label="Close find" onClick={onClose}>×</button>
    </div>
  )
}
