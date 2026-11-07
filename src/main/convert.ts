// Import: Word (.docx), OpenDocument (.odt), RTF, HTML, Markdown/text, folders and Scrivener projects, converted to one tree
// the renderer maps onto stories, chapters, scenes and research (see importer.ts planTree). Prose comes out in Canon's
// Markdown-lite syntax (prose.ts): one paragraph per line, *italic*, **bold**, ^[footnotes], "> " quotes, "# " headings
// (the renderer decides whether they become chapters), and "* * *" scene breaks.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { projectDir, type ApiOptions } from './api.ts'
import { json, body, BadRequest, type Routes } from './http.ts'

export interface ImportNode {
  kind: 'folder' | 'text' | 'file'
  title: string
  text?: string
  synopsis?: string
  notes?: string
  label?: string
  status?: string
  keywords?: string[]
  /** Scrivener's "Include in compile" was off. */
  exclude?: boolean
  /** A whole document file (not a Scrivener binder item): alone it is a story, beside others a chapter. */
  whole?: boolean
  /** A file to keep as research. `path`: where it is now (copied into the project only when the import runs). */
  file?: { path: string; name: string; mime: string; size: number }
  children?: ImportNode[]
  /** Reference material, not manuscript (Scrivener's Research folder and other non-draft folders). */
  research?: boolean
}

// ---------------- zip ----------------

/** Read every entry of a zip archive (stored or deflated). ponytail: no zip64; fine below 4 GB. */
export function unzip(data: Uint8Array): Map<string, Uint8Array> {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  let e = b.length - 22
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--
  if (e < 0) throw new BadRequest('This file is damaged or isn’t the kind it claims to be.')
  const out = new Map<string, Uint8Array>()
  let p = b.readUInt32LE(e + 16)
  for (let k = b.readUInt16LE(e + 10); k > 0; k--) {
    if (b.readUInt32LE(p) !== 0x02014b50) break
    const method = b.readUInt16LE(p + 10), size = b.readUInt32LE(p + 20), nlen = b.readUInt16LE(p + 28)
    const at = b.readUInt32LE(p + 42), name = b.toString('utf8', p + 46, p + 46 + nlen)
    p += 46 + nlen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32)
    const start = at + 30 + b.readUInt16LE(at + 26) + b.readUInt16LE(at + 28), raw = b.subarray(start, start + size)
    if (method === 0) out.set(name, new Uint8Array(raw))
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(raw)))
  }
  return out
}

// ---------------- a small XML reader ----------------

export interface El { name: string; attrs: Record<string, string>; kids: (El | string)[] }
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decodeEnt = (t: string) => t.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m)

/** Elements, attributes and text; comments, processing instructions and doctypes are skipped. Forgiving about stray close tags. */
export function parseXml(xml: string): El {
  const root: El = { name: '#root', attrs: {}, kids: [] }
  const stack = [root]
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)/g
  for (let m; (m = re.exec(xml));) {
    const top = stack[stack.length - 1]
    if (m[1] !== undefined) top.kids.push(m[1])
    else if (m[2]) { for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === m[2]) { stack.length = i; break } }
    else if (m[3]) {
      const el: El = { name: m[3], attrs: {}, kids: [] }
      for (const a of (m[4] || '').matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) el.attrs[a[1]] = decodeEnt(a[2] ?? a[3] ?? '')
      top.kids.push(el)
      if (!m[5]) stack.push(el)
    } else if (m[6] !== undefined) top.kids.push(decodeEnt(m[6]))
  }
  return root
}
/** Element names without their namespace prefix ("w:p" → "p"). */
const local = (e: El) => e.name.slice(e.name.indexOf(':') + 1)
const kids = (e: El | undefined, name?: string) => (e?.kids || []).filter((k): k is El => typeof k !== 'string' && (!name || local(k) === name))
const child = (e: El | undefined, name: string) => kids(e, name)[0]
const attr = (e: El | undefined, name: string) => { if (!e) return undefined; for (const [k, v] of Object.entries(e.attrs)) if (k === name || k.endsWith(':' + name)) return v }
function* descendants(e: El, name: string): Generator<El> { for (const k of kids(e)) { if (local(k) === name) yield k; yield* descendants(k, name) } }
const textOf = (e: El): string => e.kids.map(k => (typeof k === 'string' ? k : textOf(k))).join('')
/** The trimmed text of a child element, or ''. */
const val = (e: El | undefined, name: string) => { const c = child(e, name); return c ? textOf(c).trim() : '' }
const on = (e: El | undefined) => !!e && !['0', 'false', 'off', 'none'].includes((attr(e, 'val') || '').toLowerCase())

// ---------------- runs → Markdown-lite ----------------

type Piece = { text: string; i?: boolean; b?: boolean } | { note: string }
const BREAK_LINE = /^[ \t]*(?:#|\*[ \t]*\*[ \t]*\*[ \t*]*|⁂|-{3,}|~{3,})[ \t]*$/

/** Styled runs as one line: adjacent runs with the same style merge, and markers stay tight around the words. */
export function runsToLine(pieces: Piece[]): string {
  const merged: Piece[] = []
  for (const p of pieces) {
    const last = merged[merged.length - 1]
    if ('text' in p && last && 'text' in last && !!last.i === !!p.i && !!last.b === !!p.b) last.text += p.text
    else merged.push('text' in p ? { ...p } : p)
  }
  return merged.map(p => {
    if ('note' in p) return p.note.trim() ? `^[${p.note.trim()}]` : ''
    const t = p.text.replace(/\*/g, '\\*')
    const m = p.i && p.b ? '***' : p.b ? '**' : p.i ? '*' : ''
    if (!m || !t.trim()) return t
    const core = t.trim(), lead = t.slice(0, t.length - t.trimStart().length), trail = t.slice(t.trimEnd().length)
    return lead + m + core + m + trail
  }).join('').replace(/[ \t ]+/g, s => (s.includes(' ') ? s : ' ')).trim()
}

interface Para { level?: number; quote?: boolean; brk?: boolean; line: string }
/** Paragraphs as Canon prose: headings as "#" lines, quotes as "> ", breaks as "* * *". Leading/trailing breaks go. */
function paragraphsToText(ps: Para[]): { title?: string; text: string } {
  let title: string | undefined
  const out: string[] = []
  for (const p of ps) {
    if (p.brk || BREAK_LINE.test(p.line.replace(/\\\*/g, '*'))) { if (out.length && out[out.length - 1] !== '* * *') out.push('* * *'); continue }
    if (!p.line) continue
    if (p.level === 0) { if (title === undefined && !out.length) { title = p.line.replace(/\\?\*/g, '').trim(); continue } out.push('# ' + p.line); continue }
    out.push(p.level ? '#'.repeat(Math.min(p.level, 3)) + ' ' + p.line : p.quote ? '> ' + p.line : p.line)
  }
  while (out[out.length - 1] === '* * *') out.pop()
  return { title, text: out.join('\n') }
}

// ---------------- Word (.docx) ----------------

interface StyleInfo { name: string; level?: number; quote?: boolean; i?: boolean; b?: boolean; basedOn?: string; brk?: boolean }
function docxStyles(xml?: string): Map<string, StyleInfo> {
  const m = new Map<string, StyleInfo>()
  if (!xml) return m
  for (const st of descendants(parseXml(xml), 'style')) {
    const id = attr(st, 'styleId') || ''
    const name = attr(child(st, 'name'), 'val') || id, rPr = child(st, 'rPr'), pPr = child(st, 'pPr')
    const h = name.match(/^heading\s*(\d)$/i), lvl = attr(child(pPr, 'outlineLvl'), 'val')
    m.set(id, {
      name, basedOn: attr(child(st, 'basedOn'), 'val'),
      level: /^title$/i.test(name) ? 0 : h ? +h[1] : lvl !== undefined && +lvl < 9 ? +lvl + 1 : undefined,
      quote: /quot/i.test(name), i: rPr ? on(child(rPr, 'i')) : undefined, b: rPr ? on(child(rPr, 'b')) : undefined, brk: on(child(pPr, 'pageBreakBefore')) || undefined,
    })
  }
  return m
}
/** Follow basedOn so "Chapter Title (based on Heading 1)" counts as a heading. */
function styleOf(styles: Map<string, StyleInfo>, id?: string, depth = 0): StyleInfo | undefined {
  const s = id ? styles.get(id) : undefined
  if (!s || depth > 8) return s
  const base = styleOf(styles, s.basedOn, depth + 1)
  return base ? { ...s, level: s.level ?? base.level, quote: s.quote || base.quote, i: s.i ?? base.i, b: s.b ?? base.b } : s
}

export function docx(data: Uint8Array, name: string): ImportNode {
  const z = unzip(data), dec = (p: string) => { const x = z.get(p); return x ? new TextDecoder().decode(x) : undefined }
  const doc = dec('word/document.xml')
  if (!doc) throw new BadRequest(`“${name}” isn’t a Word document.`)
  const styles = docxStyles(dec('word/styles.xml'))
  const notes = new Map<string, string>()
  const readNotes = (xml: string | undefined, tag: string) => {
    if (!xml) return
    for (const n of descendants(parseXml(xml), tag)) {
      if (attr(n, 'type') && attr(n, 'type') !== 'normal') continue // separators
      notes.set(tag + ':' + attr(n, 'id'), kids(n, 'p').map(p => para(p).line).filter(Boolean).join(' '))
    }
  }
  function runs(e: El, out: Piece[], brk: { page: boolean }) {
    for (const k of kids(e)) {
      const n = local(k)
      if (n === 'r') {
        const rPr = child(k, 'rPr'), cs = styleOf(styles, attr(child(rPr, 'rStyle'), 'val'))
        const i = rPr && child(rPr, 'i') ? on(child(rPr, 'i')) : !!cs?.i, b = rPr && child(rPr, 'b') ? on(child(rPr, 'b')) : !!cs?.b
        for (const c of kids(k)) {
          const cn = local(c)
          if (cn === 't') out.push({ text: textOf(c), i, b })
          else if (cn === 'tab') out.push({ text: ' ', i, b })
          else if (cn === 'noBreakHyphen') out.push({ text: '-', i, b })
          else if (cn === 'br' || cn === 'cr') { if (attr(c, 'type') === 'page') brk.page = true; else out.push({ text: '\n', i, b }) }
          else if (cn === 'footnoteReference' || cn === 'endnoteReference') out.push({ note: notes.get((cn === 'footnoteReference' ? 'footnote' : 'endnote') + ':' + attr(c, 'id')) || '' })
        }
      } else if (!['pPr', 'del', 'moveFrom', 'txbxContent', 'drawing', 'pict', 'rPr'].includes(n)) runs(k, out, brk)
    }
  }
  function para(p: El): Para & { pageAfter?: boolean } {
    const st = styleOf(styles, attr(child(child(p, 'pPr'), 'pStyle'), 'val'))
    const pieces: Piece[] = [], brk = { page: false }
    runs(p, pieces, brk)
    return { level: st?.level, quote: st?.quote, brk: st?.brk, line: runsToLine(pieces), pageAfter: brk.page }
  }
  readNotes(dec('word/footnotes.xml'), 'footnote')
  readNotes(dec('word/endnotes.xml'), 'endnote')
  const ps: Para[] = []
  const bodyEl = [...descendants(parseXml(doc), 'body')][0]
  for (const p of bodyEl ? descendants(bodyEl, 'p') : []) {
    const r = para(p)
    if (r.brk) ps.push({ brk: true, line: '' })
    // A soft line break inside a paragraph starts a new line (Canon has one paragraph per line).
    const lines = r.line.split('\n').map(x => x.trim())
    lines.forEach((l, i) => ps.push({ ...r, brk: false, line: l, level: i ? undefined : r.level }))
    if (r.pageAfter) ps.push({ brk: true, line: '' })
  }
  const { title, text } = paragraphsToText(ps)
  return { kind: 'text', whole: true, title: title || fileTitle(name), text }
}

// ---------------- OpenDocument (.odt) ----------------

export function odt(data: Uint8Array, name: string): ImportNode {
  const z = unzip(data), dec = (p: string) => { const x = z.get(p); return x ? new TextDecoder().decode(x) : undefined }
  const content = dec('content.xml')
  if (!content) throw new BadRequest(`“${name}” isn’t an OpenDocument text.`)
  const styles = new Map<string, StyleInfo>()
  const readStyles = (xml?: string) => {
    if (!xml) return
    for (const st of descendants(parseXml(xml), 'style')) {
      const tp = child(st, 'text-properties'), pp = child(st, 'paragraph-properties'), nm = attr(st, 'name') || ''
      const disp = attr(st, 'display-name') || nm.replace(/_20_/g, ' ')
      const h = disp.match(/^heading\s*(\d)$/i)
      styles.set(nm, {
        name: disp, basedOn: attr(st, 'parent-style-name'), level: /^title$/i.test(disp) ? 0 : h ? +h[1] : undefined, quote: /quot/i.test(disp),
        i: tp ? /italic|oblique/.test(attr(tp, 'font-style') || '') || undefined : undefined, b: tp ? /bold|[6-9]00/.test(attr(tp, 'font-weight') || '') || undefined : undefined,
        brk: pp ? attr(pp, 'break-before') === 'page' || undefined : undefined,
      })
    }
  }
  readStyles(dec('styles.xml')); readStyles(content)
  const runs = (e: El, out: Piece[], fmt: { i: boolean; b: boolean }) => {
    for (const k of e.kids) {
      if (typeof k === 'string') { out.push({ text: k.replace(/\s+/g, ' '), ...fmt }); continue }
      const n = local(k)
      if (n === 's') out.push({ text: ' '.repeat(+(attr(k, 'c') || 1)), ...fmt })
      else if (n === 'tab') out.push({ text: ' ', ...fmt })
      else if (n === 'line-break') out.push({ text: '\n', ...fmt })
      else if (n === 'note') out.push({ note: kids(child(k, 'note-body'), 'p').map(p => line(p)).join(' ') })
      else if (n === 'span' || n === 'a' || n === 'ruby-base') { const st = styleOf(styles, attr(k, 'style-name')); runs(k, out, { i: st?.i ?? fmt.i, b: st?.b ?? fmt.b }) }
      else if (!['bookmark', 'bookmark-start', 'bookmark-end', 'soft-page-break', 'annotation', 'tracked-changes', 'note-citation', 'frame'].includes(n)) runs(k, out, fmt)
    }
  }
  const line = (p: El) => { const st = styleOf(styles, attr(p, 'style-name')); const out: Piece[] = []; runs(p, out, { i: !!st?.i, b: !!st?.b }); return runsToLine(out) }
  const ps: Para[] = []
  const walk = (e: El) => {
    for (const k of kids(e)) {
      const n = local(k)
      if (n === 'h' || n === 'p') {
        const st = styleOf(styles, attr(k, 'style-name'))
        if (st?.brk) ps.push({ brk: true, line: '' })
        const level = n === 'h' ? +(attr(k, 'outline-level') || 1) : st?.level
        line(k).split('\n').forEach((l, i) => ps.push({ level: i ? undefined : level, quote: st?.quote, line: l.trim() }))
      } else if (!['tracked-changes', 'sequence-decls', 'variable-decls', 'table-of-content', 'forms'].includes(n)) walk(k)
    }
  }
  const text = [...descendants(parseXml(content), 'text')].find(e => e.name.startsWith('office:'))
  if (text) walk(text)
  const r = paragraphsToText(ps)
  return { kind: 'text', whole: true, title: r.title || fileTitle(name), text: r.text }
}

// ---------------- RTF ----------------

const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf',
  'listtable', 'listoverridetable', 'revtbl', 'rsidtbl', 'generator', 'xmlnstbl', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'fldinst',
  'object', 'objdata', 'nonshppict', 'shp', 'filetbl', 'mmathPr', 'pgdsctbl', 'listtext', 'pntext', 'pntxtb', 'pntxta', 'annotation', 'atnid', 'atnauthor', 'bkmkstart', 'bkmkend'])
const RTF_CHAR: Record<string, string> = { emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', bullet: '•', tab: ' ', emspace: ' ', enspace: ' ', qmspace: ' ' }

/** RTF to Canon prose: paragraphs, italic and bold, unicode and code-page characters, footnotes as ^[…]. Everything else is dropped. */
export function rtf(src: string): string {
  type Target = { lines: string[]; cur: Piece[] }
  /** `ends`: set only on the group that opened a footnote, so closing that group (and no inner one) finishes it. */
  interface St { i: boolean; b: boolean; skip: boolean; uc: number; target: Target; ends?: { note: Target; owner: Target } }
  const main: Target = { lines: [], cur: [] }
  let st: St = { i: false, b: false, skip: false, uc: 1, target: main }
  const stack: St[] = []
  let dec = new TextDecoder('windows-1252'), skipN = 0, first = false, bytes: number[] = []
  const flushBytes = () => { if (bytes.length) { put(dec.decode(Uint8Array.from(bytes))); bytes = [] } }
  const put = (t: string) => {
    if (st.skip || !t) return
    const cur = st.target.cur, last = cur[cur.length - 1]
    if (last && 'text' in last && !!last.i === st.i && !!last.b === st.b) last.text += t
    else cur.push({ text: t, i: st.i, b: st.b })
  }
  const par = (t: Target) => { t.lines.push(runsToLine(t.cur)); t.cur = [] }
  for (let p = 0; p < src.length;) {
    const c = src[p]
    if (c !== '\\' || src[p + 1] !== "'") flushBytes()
    if (c === '{') { stack.push(st); st = { ...st, ends: undefined }; first = true; p++; continue }
    if (c === '}') {
      const done = st
      st = stack.pop() || st
      if (done.ends) { par(done.ends.note); done.ends.owner.cur.push({ note: done.ends.note.lines.filter(Boolean).join(' ') }) }
      first = false; p++; continue
    }
    if (c === '\r' || c === '\n') { p++; continue }
    if (c !== '\\') { if (skipN > 0) skipN--; else put(c); first = false; p++; continue }
    const n = src[p + 1]
    if (n === "'") { const byte = parseInt(src.slice(p + 2, p + 4), 16); p += 4; if (skipN > 0) skipN--; else if (!Number.isNaN(byte)) bytes.push(byte); continue }
    if (n === '*') { st.skip = true; p += 2; continue } // an optional destination this reader doesn't know
    if (!/[a-z]/i.test(n || '')) { // a control symbol
      p += 2
      if (n === '\\' || n === '{' || n === '}') put(n)
      else if (n === '~') put(' ')
      else if (n === '_') put('-')
      else if (n === '\n' || n === '\r') { if (!st.skip) par(st.target) }
      first = false; continue
    }
    const m = /^([a-z]+)(-?\d+)? ?/i.exec(src.slice(p + 1, p + 40))!
    p += 1 + m[0].length
    const w = m[1], arg = m[2] === undefined ? undefined : +m[2]
    const wasFirst = first; first = false
    if (RTF_SKIP.has(w) && (wasFirst || w === 'fldinst')) { st.skip = true; continue }
    if (w === 'footnote') { const t: Target = { lines: [], cur: [] }; st.ends = { note: t, owner: st.target }; st.target = t; continue }
    if (skipN > 0 && w !== 'u') skipN = 0
    switch (w) {
      case 'ansicpg': try { dec = new TextDecoder('windows-' + arg) } catch { /* keep 1252 */ } break
      case 'mac': try { dec = new TextDecoder('macintosh') } catch { /* keep */ } break
      case 'uc': st.uc = arg ?? 1; break
      case 'u': put(String.fromCharCode(arg! < 0 ? arg! + 65536 : arg!)); skipN = st.uc; break
      case 'i': st.i = arg !== 0; break
      case 'b': st.b = arg !== 0; break
      case 'plain': st.i = st.b = false; break
      case 'par': if (!st.skip) par(st.target); break
      case 'line': if (!st.skip) { if (st.target === main) par(main); else put(' ') } break
      case 'page': case 'sect': if (!st.skip && st.target === main) { par(main); main.lines.push('* * *') } break
      case 'chftn': break
      default: if (RTF_CHAR[w]) put(RTF_CHAR[w])
    }
  }
  flushBytes()
  par(main)
  return paragraphsToText(main.lines.map(l => ({ line: l.trim() }))).text
}

// ---------------- HTML, text and Markdown ----------------

export function html(src: string, name: string): ImportNode {
  let t = src.replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, '')
  const title = src.match(/<title>([\s\S]*?)<\/title>/i)?.[1]
  t = t.replace(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, x) => `\n${'#'.repeat(+l)} ${x.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<\/?(em|i|cite)\b[^>]*>/gi, '*').replace(/<\/?(strong|b)\b[^>]*>/gi, '**')
    .replace(/<hr[^>]*>/gi, '\n* * *\n').replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, x) => x.replace(/<p[^>]*>/gi, '\n> '))
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, '')
  const text = decodeEnt(t).split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n')
  return { kind: 'text', whole: true, title: title ? decodeEnt(title).trim() : fileTitle(name), text }
}

/** Plain text that was hard-wrapped (every line under ~80 characters, paragraphs separated by blank lines) gets its paragraphs rejoined. */
export function unwrap(text: string): string {
  const lines = text.split('\n'), full = lines.filter(l => l.trim())
  if (full.length < 6) return text
  let wrapped = 0
  for (let i = 0; i < lines.length - 1; i++) if (lines[i].trim() && lines[i + 1].trim() && lines[i].length >= 40 && lines[i].length <= 82) wrapped++
  if (wrapped / full.length < 0.5 || Math.max(...full.map(l => l.length)) > 100) return text
  return text.split(/\n[ \t]*\n/).map(p => {
    const ls = p.split('\n').map(l => l.trim()).filter(Boolean)
    // Headings, quotes and breaks keep their own lines.
    return ls.some(l => /^(#{1,3}\s|>|[-*]\s)/.test(l) || BREAK_LINE.test(l)) ? ls.join('\n') : ls.join(' ')
  }).join('\n\n')
}
export function plain(text: string, name: string): ImportNode {
  const t = unwrap(text.replace(/^﻿/, '').replace(/\r\n?/g, '\n'))
  return { kind: 'text', whole: true, title: fileTitle(name), text: t.split('\n').map(l => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim() }
}

// ---------------- files, folders, Scrivener ----------------

const MIMES: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.heic': 'image/heic', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
}
export const mimeOf = (name: string) => MIMES[extname(name).toLowerCase()] || 'application/octet-stream'
const TEXTS = ['.docx', '.odt', '.rtf', '.txt', '.md', '.markdown', '.html', '.htm', '.text']
/** "03 - The ferry_crossing.docx" → "The ferry crossing". */
export const fileTitle = (name: string) => { const b = basename(name).replace(/\.[^.]+$/, ''); return b.replace(/^\d+[\s._-]+(?=\S)/, '').replace(/[-_]+/g, ' ').trim() || b }

/** UTF-8, or Windows-1252 when the bytes aren't valid UTF-8 (old text files). */
const readText = (p: string) => { const b = readFileSync(p); try { return new TextDecoder('utf-8', { fatal: true }).decode(b) } catch { return new TextDecoder('windows-1252').decode(b) } }
const asFile = (p: string, name = basename(p)): ImportNode => ({ kind: 'file', title: fileTitle(name), file: { path: p, name, mime: mimeOf(name), size: statSync(p).size } })

/** One document file as a node: text formats convert; anything else (a PDF, an image) is kept as a file. */
export function convertFile(p: string): ImportNode {
  const ext = extname(p).toLowerCase(), name = basename(p)
  if (ext === '.docx') return docx(readFileSync(p), name)
  if (ext === '.odt') return odt(readFileSync(p), name)
  if (ext === '.rtf') return { kind: 'text', whole: true, title: fileTitle(name), text: rtf(readText(p)) }
  if (ext === '.html' || ext === '.htm') return html(readText(p), name)
  if (TEXTS.includes(ext)) return plain(readText(p), name)
  return asFile(p)
}

/** A folder: subfolders become folders, documents become texts, other files become research files. Dot folders and huge trees are skipped. */
export function folder(dir: string, depth = 0, count = { n: 0 }): ImportNode {
  if (existsSync(join(dir, basename(dir).replace(/\.scriv$/, '') + '.scrivx')) || dir.endsWith('.scriv')) return { kind: 'folder', title: fileTitle(dir), children: scrivener(dir) }
  const children: ImportNode[] = []
  const entries = readdirSync(dir, { withFileTypes: true }).filter(d => !d.name.startsWith('.') && d.name !== 'node_modules').sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  for (const d of entries) {
    if (count.n++ > 3000) break
    const p = join(dir, d.name)
    if (d.isDirectory()) { if (depth < 6) children.push(folder(p, depth + 1, count)) }
    else if (d.isFile()) try { children.push(convertFile(p)) } catch { /* an unreadable file is skipped, not fatal */ }
  }
  return { kind: 'folder', title: basename(dir), children }
}

/** A Scrivener project (.scriv): the Draft becomes the manuscript; the Research folder and other top-level folders become research; Trash is skipped. Scrivener 2 and 3 layouts. */
export function scrivener(dir: string): ImportNode[] {
  if (dir.endsWith('.scrivx')) dir = dirname(dir)
  const xname = readdirSync(dir).find(f => f.endsWith('.scrivx'))
  if (!xname) throw new BadRequest('That folder isn’t a Scrivener project (there is no .scrivx file inside).')
  const x = parseXml(readFileSync(join(dir, xname), 'utf8'))
  const proj = kids(x).find(e => local(e) === 'ScrivenerProject') || x
  const names = (parent: El | undefined, tag: string) => new Map([...(parent ? descendants(parent, tag) : [])].map(e => [attr(e, 'ID') || '', (child(e, 'Title') ? textOf(child(e, 'Title')) : textOf(e)).trim()]))
  const labels = names(child(proj, 'LabelSettings'), 'Label'), statuses = names(child(proj, 'StatusSettings'), 'Status')
  const keywords = names(kids(proj, 'Keywords')[0] || child(proj, 'ProjectKeywords'), 'Keyword')
  const v3 = existsSync(join(dir, 'Files', 'Data'))
  const pathOf = (item: El, suffix: string) => {
    const id = attr(item, 'UUID') || attr(item, 'ID') || ''
    const d = v3 ? join(dir, 'Files', 'Data', id) : join(dir, 'Files', 'Docs')
    if (suffix !== 'content') return v3 ? join(d, suffix) : join(d, `${id}_${suffix}`)
    const f = existsSync(d) ? readdirSync(d).find(f => (v3 ? f.startsWith('content.') : f.replace(/\.[^.]+$/, '') === id)) : undefined
    return f && join(d, f)
  }
  const readRtf = (p?: string) => (p && existsSync(p) ? rtf(readText(p)) : '')
  const node = (item: El, research: boolean): ImportNode | undefined => {
    const type = attr(item, 'Type') || 'Text', title = val(item, 'Title') || 'Untitled'
    if (type === 'TrashFolder') return
    const meta = child(item, 'MetaData'), content = pathOf(item, 'content')
    const synopsisPath = pathOf(item, 'synopsis.txt'), notesPath = pathOf(item, 'notes.rtf')
    const label = labels.get(val(meta, 'LabelID')), status = statuses.get(val(meta, 'StatusID'))
    const kw = kids(child(item, 'Keywords'), 'KeywordID').map(k => keywords.get(textOf(k).trim())).filter((k): k is string => !!k)
    const extra = {
      synopsis: existsSync(synopsisPath || '') ? readText(synopsisPath!).trim() || undefined : undefined,
      notes: readRtf(notesPath) || undefined,
      label: label && !/^no label$/i.test(label) ? label : undefined, status: status && !/^no status$/i.test(status) ? status : undefined,
      keywords: kw.length ? kw : undefined,
      exclude: /^no$/i.test(val(meta, 'IncludeInCompile')) || undefined,
    }
    const subs = kids(child(item, 'Children'), 'BinderItem').map(c => node(c, research || type === 'ResearchFolder')).filter((n): n is ImportNode => !!n)
    const isText = !content || /\.rtfd?$|\.txt$/i.test(content)
    const text = content && /\.rtf$/i.test(content) ? readRtf(content) : content && /\.txt$/i.test(content) ? readText(content) : ''
    const r = research || type === 'ResearchFolder'
    if (!isText && content) return { ...asFile(content, title + extname(content)), ...extra, research: r }
    if (type.endsWith('Folder') || type === 'Folder' || subs.length) {
      // A folder's own text, or a text that has children, comes first: then its children follow it.
      const own: ImportNode[] = text.trim() ? [{ kind: 'text', title, text, ...extra, research: r }] : []
      return { kind: 'folder', title: type === 'DraftFolder' ? fileTitle(xname) : title, synopsis: extra.synopsis, label: extra.label, status: extra.status, exclude: extra.exclude, children: [...own, ...subs], research: r }
    }
    return { kind: 'text', title, text, ...extra, research: r }
  }
  const roots = kids(child(proj, 'Binder'), 'BinderItem')
  const out: ImportNode[] = []
  for (const item of roots) {
    const t = attr(item, 'Type')
    const n = node(item, t !== 'DraftFolder')
    if (n) out.push(n)
  }
  // The manuscript first.
  return out.sort((a, b) => Number(!!a.research) - Number(!!b.research))
}

// ---------------- routes ----------------

/** Copy a file into the project's files folder under a new, safe, unique name (keeping its extension). Returns the stored name. */
export function storeFile(filesDir: string, src: string, name = basename(src)): string {
  mkdirSync(filesDir, { recursive: true })
  const ext = extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '')
  const stem = basename(name, extname(name)).normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase() || 'file'
  const out = `${stem}-${randomBytes(4).toString('hex')}${ext}`
  copyFileSync(src, join(filesDir, out))
  return out
}

const DOCS = [{ name: 'Documents', extensions: ['docx', 'odt', 'rtf', 'txt', 'md', 'markdown', 'html', 'htm', ...(process.platform === 'darwin' ? ['scriv'] : [])] }]

export function importRoutes(o: ApiOptions): Routes {
  // Only files that came from a picker in this session may be copied into the project.
  const picked = new Set<string>()
  const remember = (n: ImportNode) => { if (n.file) picked.add(n.file.path); n.children?.forEach(remember) }
  return {
    'POST /api/import/pick': async r => {
      const { kind = 'files' } = await body<{ kind?: 'files' | 'folder' | 'scrivener' }>(r)
      let nodes: ImportNode[] = []
      if (kind === 'folder') { const p = await o.host.pickFolder('Choose a folder to import'); if (p) nodes = [folder(p)] }
      else if (kind === 'scrivener' && process.platform !== 'darwin') { const p = await o.host.pickFolder('Choose a Scrivener project (.scriv)'); if (p) nodes = scrivener(p) }
      else {
        // On macOS a .scriv project is a package, so the file picker can choose it like a document.
        const filters = kind === 'scrivener' ? [{ name: 'Scrivener projects', extensions: ['scriv', 'scrivx'] }] : DOCS
        const ps = await o.host.pickFiles(kind === 'scrivener' ? 'Choose a Scrivener project' : 'Choose documents to import', filters, kind !== 'scrivener')
        for (const p of ps) {
          if (p.endsWith('.scriv') || p.endsWith('.scrivx')) nodes.push(...scrivener(p))
          else nodes.push(convertFile(p))
        }
      }
      nodes.forEach(remember)
      return json({ nodes })
    },
    /** Copy picked research files into the project: { paths } → { [path]: storedName }. */
    'POST /api/import/store': async r => {
      const { paths } = await body<{ paths: string[] }>(r)
      const out: Record<string, string> = {}
      for (const p of paths || []) {
        if (!picked.has(p)) throw new BadRequest('That file wasn’t chosen for import.')
        out[p] = storeFile(join(projectDir(o), 'files'), p)
      }
      return json(out)
    },
  }
}
