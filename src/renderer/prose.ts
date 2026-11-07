// Canon prose is plain text with a little Markdown, so AI edits stay diffable and every format can be exported:
//   one paragraph per line;  *italic* or _italic_;  **bold**;  ***bold italic***;  ^[a footnote];  \* a literal asterisk
//   "> " a block quote line;  "# " / "## " a heading line (in-world documents, letters);  a scene break line: * * *  ***  #  ⁂  ---
// The editor draws the markup dimmed (it never hides characters, so the caret and the text always line up);
// export reads the same structure through parseProse.

export type MarkCls = 'md-mark' | 'md-em' | 'md-strong' | 'md-note' | 'md-quote' | 'md-h' | 'md-break'
/** A styled range of the raw text: [a, b). Markers (the asterisks, "> ", "^[" and "]") are their own 'md-mark' ranges. */
export interface Mark { a: number; b: number; cls: MarkCls }
export interface Run { text: string; em?: boolean; strong?: boolean }
/** A run of text, or a footnote (its own runs). */
export type Piece = Run | { note: Run[] }
export type BlockType = 'p' | 'quote' | 'h1' | 'h2' | 'break'
export interface Block { type: BlockType; runs: Piece[] }

const BREAK = /^[ \t]*(?:\*[ \t]*\*[ \t]*\*[ \t*]*|#|⁂|-{3,}|~{3,})[ \t]*$/
const HEAD = /^(#{1,2})[ \t]+(?=\S)/
const QUOTE = /^>[ \t]?/
export const isBreak = (line: string) => BREAK.test(line)

const space = (c?: string) => c === undefined || /\s/.test(c)
const word = (c?: string) => c !== undefined && /[\p{L}\p{N}]/u.test(c)
const punct = (c?: string) => c !== undefined && /[\p{P}\p{S}]/u.test(c)

interface Opener { ch: string; start: number; n: number }

/** Inline marks for one line of text starting at `off` in the whole prose. */
function inline(line: string, off: number, out: Mark[]) {
  const stack: (Opener | { ch: '^['; start: number })[] = []
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === '\\' && punct(line[i + 1])) { out.push({ a: off + i, b: off + i + 1, cls: 'md-mark' }); i += 2; continue }
    if (c === '^' && line[i + 1] === '[') { stack.push({ ch: '^[', start: i }); i += 2; continue }
    if (c === ']') {
      const j = stack.map(x => x.ch).lastIndexOf('^[')
      if (j >= 0) {
        const o = stack[j]
        stack.length = j // unmatched emphasis inside the note is dropped
        out.push({ a: off + o.start, b: off + i + 1, cls: 'md-note' }, { a: off + o.start, b: off + o.start + 2, cls: 'md-mark' }, { a: off + i, b: off + i + 1, cls: 'md-mark' })
      }
      i++; continue
    }
    if (c === '*' || c === '_') {
      let n = 1
      while (line[i + n] === c) n++
      const before = line[i - 1], after = line[i + n]
      let open = !space(after) && (!punct(after) || space(before) || punct(before))
      let close = !space(before) && (!punct(before) || space(after) || punct(after))
      if (c === '_') { open = open && !word(before); close = close && !word(after) } // snake_case is not italic
      let left = n, used = 0
      if (close) {
        for (let j = stack.length - 1; j >= 0 && left > 0; j--) {
          const o = stack[j]
          if (o.ch === '^[') break // emphasis never closes across a footnote boundary
          if (o.ch !== c) continue
          const op = o as Opener
          const k = op.n >= 3 && left >= 3 ? 3 : op.n >= 2 && left >= 2 ? 2 : 1
          const oa = op.start + op.n - k, cb = i + used
          out.push({ a: off + oa, b: off + oa + k, cls: 'md-mark' }, { a: off + cb, b: off + cb + k, cls: 'md-mark' })
          if (k !== 2) out.push({ a: off + oa + k, b: off + cb, cls: 'md-em' })
          if (k >= 2) out.push({ a: off + oa + k, b: off + cb, cls: 'md-strong' })
          op.n -= k; left -= k; used += k
          stack.length = op.n ? j + 1 : j // openers after the match can't close any more
        }
      }
      if (left > 0 && open) stack.push({ ch: c, start: i + used, n: left })
      i += n; continue
    }
    i++
  }
}

/** Every styled range in the prose, for the editor to draw. Ranges may nest and overlap; markers come as their own ranges. */
export function proseMarks(prose: string): Mark[] {
  const out: Mark[] = []
  let off = 0
  for (const line of prose.split('\n')) {
    if (isBreak(line)) { if (line.trim()) out.push({ a: off, b: off + line.length, cls: 'md-break' }) }
    else {
      const h = line.match(HEAD), q = !h && line.match(QUOTE)
      const pre = h ? h[0].length : q ? q[0].length : 0
      if (h) out.push({ a: off, b: off + pre, cls: 'md-mark' }, { a: off + pre, b: off + line.length, cls: 'md-h' })
      if (q) out.push({ a: off, b: off + pre, cls: 'md-mark' }, { a: off + pre, b: off + line.length, cls: 'md-quote' })
      inline(line.slice(pre), off + pre, out)
    }
    off += line.length + 1
  }
  return out
}

/** One line's text as runs and footnotes, markup removed. */
export function parseInline(text: string): Piece[] {
  const ms: Mark[] = []
  inline(text, 0, ms)
  const mark = new Uint8Array(text.length), em = new Uint8Array(text.length), strong = new Uint8Array(text.length), note = new Int32Array(text.length).fill(-1)
  for (const m of ms) for (let i = m.a; i < m.b; i++) {
    if (m.cls === 'md-mark') mark[i] = 1
    else if (m.cls === 'md-em') em[i]++
    else if (m.cls === 'md-strong') strong[i]++
    else if (m.cls === 'md-note') note[i] = m.a
  }
  const out: Piece[] = []
  const push = (into: Run[] | Piece[], ch: string, r: { em?: boolean; strong?: boolean }) => {
    const last = into[into.length - 1] as Run | undefined
    if (last && 'text' in last && !!last.em === !!r.em && !!last.strong === !!r.strong) last.text += ch
    else into.push({ text: ch, ...(r.em ? { em: true } : {}), ...(r.strong ? { strong: true } : {}) })
  }
  let cur: { at: number; runs: Run[] } | undefined
  for (let i = 0; i < text.length; i++) {
    if (note[i] >= 0) { if (!cur || cur.at !== note[i]) { cur = { at: note[i], runs: [] }; out.push({ note: cur.runs }) } }
    else cur = undefined
    if (mark[i]) continue
    const r = { em: em[i] % 2 === 1, strong: strong[i] > 0 }
    push(cur ? cur.runs : out, text[i], r)
  }
  return out
}

/** The prose as blocks: paragraphs (one per line), quotes, headings and scene breaks. Blank lines only separate. */
export function parseProse(prose: string): Block[] {
  const out: Block[] = []
  for (const line of prose.split('\n')) {
    if (!line.trim()) continue
    if (isBreak(line)) { out.push({ type: 'break', runs: [] }); continue }
    const h = line.match(HEAD), q = !h && line.match(QUOTE)
    const body = line.slice(h ? h[0].length : q ? q[0].length : 0).trim()
    out.push({ type: h ? (h[1].length === 1 ? 'h1' : 'h2') : q ? 'quote' : 'p', runs: parseInline(body) })
  }
  return out
}

/** Plain text without markup or footnotes (for counting, search snippets and plain-text export). */
export const runsText = (runs: Piece[]) => runs.map(p => ('text' in p ? p.text : '')).join('')
export function plainText(prose: string, breakText = '* * *'): string {
  return parseProse(prose).map(b => (b.type === 'break' ? breakText : runsText(b.runs))).join('\n\n')
}

/** Wrap a selection in a marker, or remove it when the selection is already wrapped. Returns the new text and selection. */
export function toggleWrap(text: string, a: number, b: number, marker: string): { text: string; a: number; b: number } {
  const k = marker.length
  if (text.slice(a - k, a) === marker && text.slice(b, b + k) === marker) return { text: text.slice(0, a - k) + text.slice(a, b) + text.slice(b + k), a: a - k, b: b - k }
  const sel = text.slice(a, b)
  if (sel.length > 2 * k && sel.startsWith(marker) && sel.endsWith(marker)) return { text: text.slice(0, a) + sel.slice(k, -k) + text.slice(b), a, b: b - 2 * k }
  // Keep the markers tight around the words, so "*word *" never happens.
  const lead = sel.length - sel.trimStart().length, trail = sel.length - sel.trimEnd().length
  const s = a + lead, e = b - trail
  return { text: text.slice(0, s) + marker + text.slice(s, e) + marker + text.slice(e), a: s + k, b: e + k }
}
