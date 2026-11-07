// The formatted prose field: a textarea whose text is invisible, over a copy of the text that carries the styling
// (Markdown-lite from prose.ts) and the highlights. The caret, selection, spelling and undo are the textarea's own,
// so typing is native; the copy only draws. Nothing in the copy may change a glyph's advance or a line's height.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { proseMarks, parseProse, isBreak, type Mark, type Piece, type Run } from '../prose.ts'
import { showToast, sessionWords, dailyGoal, type State } from '../store.ts'
import { stored, store } from '../ui.tsx'
import './prose.css'

/** A highlight drawn behind the text. `k` names it, so its position can be measured through data-a / data-z anchors. */
export interface Hl { k: string; a: number; b: number; cls: string }

/** The text again, styled, with marks where highlights go; anchors (data-a / data-z) mark where each highlight starts and ends. */
export function Backdrop({ text, ranges, marks }: { text: string; ranges: Hl[]; marks: Mark[] }) {
  const rs = ranges.filter(r => r.b > r.a && r.a >= 0 && r.b <= text.length)
  const ms = marks.filter(m => m.b > m.a && m.b <= text.length)
  const cuts = [...new Set([0, text.length, ...rs.flatMap(r => [r.a, r.b]), ...ms.flatMap(m => [m.a, m.b])])].sort((a, b) => a - b)
  const out: ReactNode[] = []
  let mi = 0
  const open: Mark[] = []
  const sorted = [...ms].sort((a, b) => a.a - b.a)
  cuts.forEach((c, j) => {
    for (const r of rs) if (r.b === c) out.push(<span key={'z' + r.k} data-z={r.k} />)
    for (const r of rs) if (r.a === c) out.push(<span key={'a' + r.k} data-a={r.k} />)
    const end = cuts[j + 1]
    if (end === undefined) return
    // Sweep: marks starting at or before this cut join, marks that ended leave.
    while (mi < sorted.length && sorted[mi].a <= c) open.push(sorted[mi++])
    for (let i = open.length - 1; i >= 0; i--) if (open[i].b <= c) open.splice(i, 1)
    const t = text.slice(c, end)
    const hl = rs.filter(r => r.a <= c && r.b >= end).map(r => r.cls)
    const md = [...new Set(open.filter(m => m.a <= c && m.b >= end).map(m => m.cls))]
    // Markers draw last so they stay dimmed inside a styled range.
    const cls = [...md.filter(x => x !== 'md-mark'), ...(md.includes('md-mark') ? ['md-mark'] : []), ...hl].join(' ')
    out.push(hl.length ? <mark key={'m' + c} className={cls}>{t}</mark> : cls ? <span key={'s' + c} className={cls}>{t}</span> : t)
  })
  return <>{out}{'​'}</>
}

// ---------------- editing helpers (keep the textarea's own undo) ----------------

/** Replace [a, b) with text through the browser's editing, so ⌘Z in the field undoes it; then select [selA, selB). */
export function replaceIn(t: HTMLTextAreaElement, a: number, b: number, text: string, selA?: number, selB?: number) {
  t.focus()
  t.setSelectionRange(a, b)
  if (!(text ? document.execCommand('insertText', false, text) : document.execCommand('delete'))) {
    t.setRangeText(text, a, b, 'end')
    t.dispatchEvent(new Event('input', { bubbles: true }))
  }
  if (selA !== undefined) t.setSelectionRange(selA, selB ?? selA)
}
/** Make the field's text `next`, touching only the part that changed. */
export function setText(t: HTMLTextAreaElement, next: string, selA?: number, selB?: number) {
  const cur = t.value
  let p = 0
  while (p < cur.length && p < next.length && cur[p] === next[p]) p++
  let q = 0
  while (q < cur.length - p && q < next.length - p && cur[cur.length - 1 - q] === next[next.length - 1 - q]) q++
  replaceIn(t, p, cur.length - q, next.slice(p, next.length - q), selA, selB)
}

export type FormatCmd = 'bold' | 'italic' | 'quote' | 'heading' | 'break' | 'footnote'
const stars = (t: string, i: number, dir: -1 | 1) => { let n = 0; while (t[dir < 0 ? i - 1 - n : i + n] === '*') n++; return n }

/** Toggle a format on the field's selection (or at the caret). */
export function applyFormat(t: HTMLTextAreaElement, cmd: FormatCmd) {
  const v = t.value, a = t.selectionStart, b = t.selectionEnd
  if (cmd === 'bold' || cmd === 'italic') {
    const m = cmd === 'bold' ? '**' : '*', k = m.length
    const before = stars(v, a, -1), after = stars(v, b, 1)
    // Already wrapped: *word* (or ***word*** for italic), **word** for bold. Bold's two stars never count as italic.
    const wrapped = cmd === 'bold' ? before >= 2 && after >= 2 : before % 2 === 1 && after % 2 === 1
    if (wrapped) return setText(t, v.slice(0, a - k) + v.slice(a, b) + v.slice(b + k), a - k, b - k)
    if (a === b) return replaceIn(t, a, b, m + m, a + k)
    const sel = v.slice(a, b), lead = sel.length - sel.trimStart().length, trail = sel.length - sel.trimEnd().length
    const s = a + lead, e = b - trail
    return replaceIn(t, s, e, m + v.slice(s, e) + m, s + k, e + k)
  }
  if (cmd === 'footnote') {
    if (a === b) return replaceIn(t, a, b, '^[]', a + 2)
    return replaceIn(t, a, b, '^[' + v.slice(a, b).trim() + ']', a + 2, a + 2 + v.slice(a, b).trim().length)
  }
  if (cmd === 'break') {
    const pre = a === 0 || v[a - 1] === '\n' ? '' : '\n'
    const post = v[b] === undefined || v[b] === '\n' ? '\n' : '\n'
    const ins = pre + '* * *' + post
    return replaceIn(t, a, b, ins, a + ins.length)
  }
  // Line formats work on every line the selection touches.
  const ls = v.lastIndexOf('\n', a - 1) + 1
  let le = v.indexOf('\n', b > a && v[b - 1] === '\n' ? b - 1 : b)
  if (le < 0) le = v.length
  const lines = v.slice(ls, le).split('\n')
  const body = lines.filter(l => l.trim() && !isBreak(l))
  let next: string[]
  if (cmd === 'quote') {
    const all = body.length > 0 && body.every(l => /^>[ \t]?/.test(l))
    next = lines.map(l => (!l.trim() || isBreak(l) ? l : all ? l.replace(/^>[ \t]?/, '') : '> ' + l.replace(/^#{1,2}[ \t]+/, '')))
  } else {
    const all = body.length > 0 && body.every(l => /^#{1,2}[ \t]+/.test(l))
    next = lines.map(l => (!l.trim() || isBreak(l) ? l : all ? l.replace(/^#{1,2}[ \t]+/, '') : '# ' + l.replace(/^>[ \t]?/, '')))
  }
  const out = next.join('\n')
  setText(t, v.slice(0, ls) + out + v.slice(le), ls, ls + out.length)
}

/** Every match of q in text: [start, end) pairs. */
export function findAll(text: string, q: string, matchCase = false): [number, number][] {
  if (!q) return []
  const hay = matchCase ? text : text.toLowerCase(), needle = matchCase ? q : q.toLowerCase()
  const out: [number, number][] = []
  for (let i = hay.indexOf(needle); i >= 0 && out.length < 2000; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length])
  return out
}

// ---------------- typewriter scrolling (per machine) ----------------

let typewriter = stored('canon.typewriter', '0') === '1'
const twSubs = new Set<() => void>()
export const useTypewriter = () => useSyncExternalStore(f => (twSubs.add(f), () => twSubs.delete(f)), () => typewriter)
export function setTypewriter(on: boolean) { typewriter = on; store('canon.typewriter', on ? '1' : '0'); twSubs.forEach(f => f()) }
// View › Typewriter Scrolling, from anywhere.
addEventListener('canon:command', e => {
  if ((e as CustomEvent<string>).detail !== 'typewriter') return
  e.preventDefault()
  setTypewriter(!typewriter)
  showToast(typewriter ? 'Typewriter scrolling on: the line you’re writing stays in the middle' : 'Typewriter scrolling off')
})

/** Where the caret is, measured on the styled copy (the textarea can't say). */
export function caretRect(back: HTMLElement, index: number): DOMRect | undefined {
  const w = document.createTreeWalker(back, NodeFilter.SHOW_TEXT)
  let n = 0
  for (let node = w.nextNode() as Text | null; node; node = w.nextNode() as Text | null) {
    const len = node.data.length
    if (index <= n + len) {
      const r = document.createRange()
      r.setStart(node, Math.max(0, Math.min(len, index - n)))
      r.collapse(true)
      return r.getClientRects()[0] || r.getBoundingClientRect()
    }
    n += len
  }
}
const scroller = (el: HTMLElement): HTMLElement | null => {
  for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p }
  return null
}
/** Keep the caret's line about 45% down the scrolling view. */
function holdCaret(t: HTMLTextAreaElement, back: HTMLElement) {
  const r = caretRect(back, t.selectionEnd), sc = scroller(t)
  if (!r || !sc || !r.height) return
  const box = sc.getBoundingClientRect()
  sc.scrollTop += r.top + r.height / 2 - (box.top + box.height * 0.45)
}

// ---------------- the field ----------------

export interface ProseFieldProps {
  value: string
  onChange?: (v: string) => void
  readOnly?: boolean
  placeholder?: string
  ariaLabel?: string
  autoFocus?: boolean
  className?: string
  /** Highlights (notes, suggestions, find matches…) drawn with the styling. */
  ranges?: Hl[]
  areaRef?: RefObject<HTMLTextAreaElement | null>
  backRef?: RefObject<HTMLDivElement | null>
  wrapRef?: RefObject<HTMLDivElement | null>
  onSelect?: () => void
  onMouseDown?: () => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onFocus?: () => void
  typewriter?: boolean
  children?: ReactNode
}

export function ProseField({ value, onChange, readOnly, placeholder, ariaLabel = 'Text', autoFocus, className = '', ranges = [], areaRef, backRef, wrapRef, onSelect, onMouseDown, onKeyDown, onFocus, typewriter: tw, children }: ProseFieldProps) {
  const area = useRef<HTMLTextAreaElement | null>(null), back = useRef<HTMLDivElement | null>(null)
  const marks = useMemo(() => proseMarks(value), [value])
  // Format menu commands act on the field that has focus.
  useEffect(() => {
    const on = (e: Event) => {
      const c = (e as CustomEvent<string>).detail
      if (!c.startsWith('format:') || !area.current || document.activeElement !== area.current || readOnly) return
      e.preventDefault()
      applyFormat(area.current, c.slice(7) as FormatCmd)
    }
    addEventListener('canon:command', on)
    return () => removeEventListener('canon:command', on)
  }, [readOnly])
  const hold = () => { if (tw && area.current && back.current) { const t = area.current, b = back.current; requestAnimationFrame(() => requestAnimationFrame(() => holdCaret(t, b))) } }
  return (
    <div className={'pf ' + className} ref={el => { if (wrapRef) wrapRef.current = el }}>
      <div className="pf-back" aria-hidden="true" ref={el => { back.current = el; if (backRef) backRef.current = el }}><Backdrop text={value} ranges={ranges} marks={marks} /></div>
      <textarea ref={el => { area.current = el; if (areaRef) areaRef.current = el }} className="prose-area pf-area" value={value} readOnly={readOnly} aria-label={ariaLabel} autoFocus={autoFocus} spellCheck
        placeholder={placeholder} onChange={e => { onChange?.(e.target.value); hold() }} onSelect={onSelect} onMouseDown={onMouseDown} onFocus={onFocus}
        onKeyUp={e => { if (e.key.startsWith('Arrow') || e.key === 'Enter' || e.key.startsWith('Page')) hold() }} onClick={hold}
        onKeyDown={e => {
          // ⌘B / ⌘I also work where the menu doesn't reach (Windows/Linux without a menu bar shortcut).
          if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'i') && !readOnly) { e.preventDefault(); applyFormat(e.currentTarget, e.key === 'b' ? 'bold' : 'italic') }
          onKeyDown?.(e)
        }} />
      {children}
    </div>
  )
}

// ---------------- read-only rendering ----------------

const runs = (rs: (Run | Piece)[], notes: Run[][]): ReactNode[] => rs.map((p, i) => {
  if ('note' in p) { notes.push(p.note); return <sup key={i} className="pt-fn" title={p.note.map(r => r.text).join('')}>{notes.length}</sup> }
  const t: ReactNode = p.text
  return p.strong && p.em ? <strong key={i}><em>{t}</em></strong> : p.strong ? <strong key={i}>{t}</strong> : p.em ? <em key={i}>{t}</em> : <span key={i}>{t}</span>
})
/** Prose shown as a reader sees it: italics, quotes, breaks, footnotes at the end. */
export function ProseText({ text, empty = 'No text yet.' }: { text: string; empty?: string }) {
  const blocks = useMemo(() => parseProse(text), [text])
  if (!blocks.length) return <p className="pt-empty">{empty}</p>
  const notes: Run[][] = []
  const body = blocks.map((b, i) => b.type === 'break' ? <div key={i} className="pt-break">* * *</div>
    : b.type === 'quote' ? <blockquote key={i}>{runs(b.runs, notes)}</blockquote>
      : b.type === 'h1' || b.type === 'h2' ? <h4 key={i}>{runs(b.runs, notes)}</h4>
        : <p key={i}>{runs(b.runs, notes)}</p>)
  return <div className="pt">{body}{notes.length > 0 && <ol className="pt-notes">{notes.map((n, i) => <li key={i}>{runs(n, [])}</li>)}</ol>}</div>
}

// ---------------- composition (focus) mode ----------------

const PAPER = { narrow: '560px', medium: '680px', wide: '820px' } as const
type Paper = keyof typeof PAPER
const n = (x: number) => x.toLocaleString()

/** Full-screen writing: the text and nothing else. Page width, a page on a dimmed desk, and typewriter scrolling are remembered on this machine. */
export function Composition({ s, title, words, target, onExit, children }: { s: State; title?: string; words: number; target?: number; onExit: () => void; children: ReactNode }) {
  const [width, setWidth] = useState<Paper>(() => (stored('canon.focus.width', 'medium') as Paper) in PAPER ? stored('canon.focus.width', 'medium') as Paper : 'medium')
  const [page, setPage] = useState(() => stored('canon.focus.page', '0') === '1')
  const tw = useTypewriter()
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onExit() }; addEventListener('keydown', esc); return () => removeEventListener('keydown', esc) }, [onExit])
  useEffect(() => { store('canon.focus.width', width); store('canon.focus.page', page ? '1' : '0') }, [width, page])
  const today = Math.max(0, sessionWords(s)), goal = dailyGoal(s)
  return (
    <div className={'focus-mode' + (page ? ' page' : '') + (tw ? ' tw' : '')} style={{ ['--paper' as string]: PAPER[width] }}>
      <div className="focus-bar">
        <span>{n(words)}{target ? ` / ${n(target)}` : ''} words</span>
        <span>Today {n(today)}{goal ? ` / ${n(goal)}` : ''}</span>
        <span className="seg" role="group" aria-label="Page width">{(Object.keys(PAPER) as Paper[]).map(k => <button key={k} className={width === k ? 'on' : ''} aria-pressed={width === k} onClick={() => setWidth(k)}>{k[0].toUpperCase() + k.slice(1)}</button>)}</span>
        <button className={'btn sm ghost' + (page ? ' on' : '')} aria-pressed={page} title="The text on a page, the rest dimmed" onClick={() => setPage(p => !p)}>Page</button>
        <button className={'btn sm ghost' + (tw ? ' on' : '')} aria-pressed={tw} title="Keep the line you’re writing in the middle of the screen" onClick={() => setTypewriter(!tw)}>Typewriter</button>
        <button className="btn sm" onClick={onExit}>Leave <kbd>esc</kbd></button>
      </div>
      <div className="doc focus-doc">{title !== undefined && <h1>{title || 'Untitled scene'}</h1>}{children}</div>
    </div>
  )
}
