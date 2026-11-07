// Export: compile the manuscript (stories → parts → chapters → scenes) into one Doc, then write it as Word, RTF, PDF, EPUB,
// Markdown or plain text. Outcome-first presets choose sensible defaults; "More options" adjusts headings and front matter.
// Word, RTF and EPUB are written by the desktop shell (src/main/exporter.ts); PDF is rendered from HTML there too.
import {
  project, stories, get, list, treeOf, sectionsOf, chapterOf, partOf, words, update, tx, getState,
  type State, type Scene, type Section, type TreeNode,
} from './store.ts'
import { parseProse } from './prose.ts'
import {
  blocksHtml, headingHtml, contentsHtml, escHtml, isNote, headingOf, inContents,
  type Doc, type DocBlock, type DocUnit, type DocRun, type DocPiece,
} from '../main/doc.ts'

export type Preset = 'manuscript' | 'paperback' | 'ebook' | 'reading' | 'markdown' | 'text'
export type FileType = 'docx' | 'rtf' | 'pdf' | 'epub' | 'md' | 'txt'
/** Chapter One / Chapter 1 / One / 1 / none. */
export type Numbering = 'word' | 'number' | 'bare-word' | 'bare-number' | 'none'
export const PRESETS: { id: Preset; label: string; hint: string; files: FileType[] }[] = [
  { id: 'manuscript', label: 'Manuscript for submission', hint: 'Word or RTF in standard manuscript format, for agents and editors', files: ['docx', 'rtf'] },
  { id: 'paperback', label: 'Paperback', hint: 'A print-ready PDF at a book trim size, with running heads and page numbers', files: ['pdf'] },
  { id: 'ebook', label: 'Ebook', hint: 'EPUB with cover, contents and metadata, for Apple Books, Kobo and Kindle', files: ['epub'] },
  { id: 'reading', label: 'Reading copy', hint: 'A comfortable PDF to read on screen or send to first readers', files: ['pdf'] },
  { id: 'markdown', label: 'Markdown', hint: 'Plain text that keeps italics, headings and footnotes', files: ['md'] },
  { id: 'text', label: 'Plain text', hint: 'Just the words', files: ['txt'] },
]
export const FILE_LABEL: Record<FileType, string> = { docx: 'Word', rtf: 'RTF', pdf: 'PDF', epub: 'EPUB', md: 'Markdown', txt: 'Text' }
export const TRIMS = { '5x8': [5, 8], '5.25x8': [5.25, 8], '5.5x8.5': [5.5, 8.5], '6x9': [6, 9] } as const
export const PAGES = { a4: 'A4', letter: 'Letter', a5: 'A5' } as const
export const FONTS = ['Georgia', 'Palatino', 'Baskerville', 'Iowan Old Style', 'Charter', 'Times New Roman'] as const

export interface ExportOpts {
  preset: Preset; file: FileType
  chapters: Numbering; chapterTitles: boolean; parts: Numbering; storyTitles: boolean; sceneTitles: boolean; breakText: string
  titlePage: boolean; copyright: boolean; dedication: boolean; epigraph: boolean; contents: boolean; acknowledgements: boolean; about: boolean
  /** Manuscript: paper size and the contact block for the title page. */
  paper: 'letter' | 'a4'; contact: string
  /** Paperback trim; reading-copy page; PDF font and size (pt). */
  trim: keyof typeof TRIMS; page: keyof typeof PAGES; font: string; size: number
}
const usLike = () => typeof navigator !== 'undefined' && /^en-(US|CA)|^es-(US|MX)/.test(navigator.language)
export function defaultsFor(preset: Preset): ExportOpts {
  const base: ExportOpts = {
    preset, file: PRESETS.find(p => p.id === preset)!.files[0],
    chapters: 'word', chapterTitles: true, parts: 'word', storyTitles: true, sceneTitles: false, breakText: '* * *',
    titlePage: true, copyright: false, dedication: false, epigraph: false, contents: false, acknowledgements: false, about: false,
    paper: usLike() ? 'letter' : 'a4', contact: '', trim: '5.5x8.5', page: usLike() ? 'letter' : 'a4', font: 'Georgia', size: 11,
  }
  if (preset === 'manuscript') return { ...base, breakText: '#' }
  if (preset === 'paperback') return { ...base, copyright: true, dedication: true, epigraph: true, acknowledgements: true, about: true, font: 'Palatino', size: 10.5, breakText: '⁂' }
  if (preset === 'ebook') return { ...base, copyright: true, dedication: true, epigraph: true, contents: true, acknowledgements: true, about: true }
  if (preset === 'reading') return { ...base, size: 12 }
  return base
}

// ---------------- remembered choices (project.exportPrefs) ----------------

interface Prefs { preset?: Preset; opts?: Partial<Record<Preset, Partial<ExportOpts>>>; contact?: string }
const prefsOf = (s: State) => (project(s).exportPrefs || {}) as Prefs
export const lastPreset = (s: State): Preset => prefsOf(s).preset || 'manuscript'
/** A preset's options: its defaults, then what was used last time. The contact block is shared by every preset. */
export function optsFor(s: State, preset: Preset): ExportOpts {
  const p = prefsOf(s)
  return { ...defaultsFor(preset), ...p.opts?.[preset], preset, ...(p.contact !== undefined ? { contact: p.contact } : {}) }
}
/** Remember the choices behind an export (one quiet undo step, only when something changed). */
export function rememberOpts(o: ExportOpts) {
  const p = prefsOf(getState())
  const d = defaultsFor(o.preset)
  const diff = Object.fromEntries(Object.entries(o).filter(([k, v]) => k !== 'contact' && k !== 'preset' && d[k as keyof ExportOpts] !== v))
  const next: Prefs = { ...p, preset: o.preset, opts: { ...p.opts, [o.preset]: diff }, contact: o.contact || undefined }
  if (JSON.stringify(next) !== JSON.stringify(p)) tx('Remember export settings', () => update<'project'>('project', x => { x.exportPrefs = next as Record<string, unknown> }), false)
}

// ---------------- what goes in ----------------

/** Whether a scene is chosen: it, its chapter, its part or its story is in `ids` (none: everything). */
export function chosen(s: State, ids: string[]) {
  if (!ids.length) return (_: Scene) => true
  const set = new Set(ids)
  return (sc: Scene) => set.has(sc.id) || set.has(sc.story) || set.has(chapterOf(s, sc.id)?.id || '') || set.has(partOf(s, sc.id)?.id || '')
}
/** Scenes that go in: chosen, not left out, with some text. */
export function scenesFor(s: State, ids: string[]): Scene[] {
  const pick = chosen(s, ids)
  const out: Scene[] = []
  const walk = (n: TreeNode) => { if (n.sec?.exclude) return; out.push(...n.scenes.filter(sc => pick(sc) && !sc.exclude && sc.prose.trim())); n.kids.forEach(walk) }
  for (const st of stories(s)) walk(treeOf(s, st.id))
  return out
}

const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
export function numberWord(n: number): string {
  if (n < 20) return ONES[n]
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '')
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + numberWord(n % 100) : '')
  return String(n)
}
export function numberLabel(kind: 'Chapter' | 'Part', n: number, style: Numbering): string | undefined {
  return style === 'word' ? `${kind} ${numberWord(n)}` : style === 'number' ? `${kind} ${n}` : style === 'bare-word' ? numberWord(n) : style === 'bare-number' ? String(n) : undefined
}
/** A section's own title, unless it is only the automatic "Chapter 3" / "Part 2". */
const ownTitle = (sec: Section) => (/^(chapter|part)\s+(\d+|[a-z-]+)$/i.test(sec.title.trim()) ? '' : sec.title.trim())

const toDoc = (p: { text: string; em?: boolean; strong?: boolean } | { note: { text: string; em?: boolean; strong?: boolean }[] }): DocPiece => p
/** Scenes' text as blocks: a break (or the scene's title) between scenes; paragraphs after a heading or break are not indented. */
function sceneBlocks(scs: Scene[], sceneTitles: boolean): DocBlock[] {
  const out: DocBlock[] = []
  scs.forEach((sc, i) => {
    if (sceneTitles && sc.title.trim()) out.push({ type: 'scene', runs: [{ text: sc.title.trim() }] })
    else if (i > 0) out.push({ type: 'break', runs: [] })
    for (const b of parseProse(sc.prose)) out.push({ type: b.type, runs: b.runs.map(toDoc) })
  })
  out.forEach((b, i) => { if (b.type === 'p' && (i === 0 || ['break', 'scene', 'h1', 'h2'].includes(out[i - 1].type))) b.first = true })
  return out
}
const textBlocks = (t: string): DocBlock[] => parseProse(t).map(b => ({ type: b.type, runs: b.runs.map(toDoc), first: true }))
export const suggestedCopyright = (s: State) => `© ${new Date().getFullYear()} ${project(s).author || ''}`.trim()

/** The manuscript (or the chosen part of it) as one Doc. */
export function buildDoc(s: State, ids: string[], o: ExportOpts): Doc {
  const p = project(s), book = p.book || {}
  const keep = new Set(scenesFor(s, ids).map(x => x.id))
  const sts = stories(s).filter(st => list(s, 'scene').some(sc => sc.story === st.id && keep.has(sc.id)))
  const multi = sts.length > 1
  const units: DocUnit[] = []
  for (const st of sts) {
    const nums = (type: Section['type']) => new Map(sectionsOf(s, st.id).filter(x => x.type === type && !x.exclude).map((x, i) => [x.id, i + 1]))
    const chapN = nums('chapter'), partN = nums('part')
    const has = (n: TreeNode): boolean => !n.sec?.exclude && (n.scenes.some(sc => keep.has(sc.id)) || n.kids.some(has))
    const tree = treeOf(s, st.id)
    const top = tree.scenes.filter(sc => keep.has(sc.id))
    if (multi) units.push(o.storyTitles ? { kind: 'story', label: st.title || 'Untitled story', depth: 0, blocks: sceneBlocks(top, o.sceneTitles) } : { kind: 'body', depth: 0, blocks: sceneBlocks(top, o.sceneTitles) })
    else if (top.length) units.push({ kind: 'body', depth: 0, blocks: sceneBlocks(top, o.sceneTitles) })
    const add = (n: TreeNode, depth: number) => {
      if (!n.sec || !has(n)) return
      const sec = n.sec, chap = sec.type === 'chapter'
      const label = chap ? numberLabel('Chapter', chapN.get(sec.id) || 1, o.chapters) : numberLabel('Part', partN.get(sec.id) || 1, o.parts)
      const title = ownTitle(sec) && (!chap || o.chapterTitles || !label) ? ownTitle(sec) : undefined
      units.push({ kind: sec.type, label, title, depth, blocks: sceneBlocks(n.scenes.filter(sc => keep.has(sc.id)), o.sceneTitles) })
      n.kids.forEach(k => add(k, depth + 1))
    }
    tree.kids.forEach(k => add(k, multi ? 1 : 0))
  }
  const author = (p.author || '').trim()
  const rights = book.copyright?.trim() || suggestedCopyright(s)
  const manuscript = o.preset === 'manuscript'
  const front: DocUnit[] = [
    ...(o.titlePage ? [{ kind: 'titlepage' as const, depth: 0, blocks: [] }] : []),
    ...(o.copyright && !manuscript ? [{ kind: 'copyright' as const, depth: 0, blocks: textBlocks([rights, book.publisher, book.isbn && 'ISBN ' + book.isbn].filter(Boolean).join('\n')) }] : []),
    ...(o.dedication && book.dedication?.trim() ? [{ kind: 'dedication' as const, depth: 0, blocks: textBlocks(book.dedication) }] : []),
    ...(o.epigraph && book.epigraph?.trim() ? [{ kind: 'epigraph' as const, depth: 0, blocks: textBlocks(book.epigraph) }] : []),
    ...(o.contents && units.some(inContents) ? [{ kind: 'contents' as const, depth: 0, blocks: [] }] : []),
  ]
  const back: DocUnit[] = [
    ...(o.acknowledgements && book.acknowledgements?.trim() ? [{ kind: 'acknowledgements' as const, title: 'Acknowledgements', depth: 0, blocks: textBlocks(book.acknowledgements) }] : []),
    ...(o.about && book.about?.trim() ? [{ kind: 'about' as const, title: 'About the author', depth: 0, blocks: textBlocks(book.about) }] : []),
  ]
  const cover = book.cover ? get(s, book.cover, 'research') : undefined
  return {
    title: (ids.length && sts.length === 1 && stories(s).length > 1 ? sts[0].title : p.title) || 'Untitled', subtitle: book.subtitle || undefined, author,
    contact: o.contact || undefined, words: list(s, 'scene').filter(sc => keep.has(sc.id)).reduce((n, sc) => n + words(sc.prose), 0),
    language: book.language || 'en', publisher: book.publisher, isbn: book.isbn, description: book.description, series: book.series, seriesIndex: book.seriesIndex, rights,
    cover: cover?.file ? { file: cover.file, mime: cover.mime || 'image/jpeg' } : undefined,
    breakText: o.breakText || '* * *', units: [...front, ...units, ...back], paper: o.paper,
  }
}

// ---------------- Markdown and plain text ----------------

const mdEsc = (t: string) => t.replace(/([\\*_^[\]])/g, '\\$1')
const mdRun = (r: DocRun) => { const t = mdEsc(r.text); return r.em && r.strong ? `***${t}***` : r.strong ? `**${t}**` : r.em ? `*${t}*` : t }
export function toMarkdown(d: Doc): string {
  const notes: string[] = []
  const runs = (ps: DocPiece[]) => ps.map(p => (isNote(p) ? (notes.push(p.note.map(mdRun).join('')), `[^${notes.length}]`) : mdRun(p))).join('')
  const brk = /^[#>]/.test(d.breakText) ? '\\' + d.breakText : d.breakText
  const out: string[] = []
  for (const u of d.units) {
    const h = '#'.repeat(Math.min(6, u.depth + 1)) + ' '
    if (u.kind === 'titlepage') { out.push(`# ${d.title}`, ...(d.subtitle ? [`*${mdEsc(d.subtitle)}*`] : []), ...(d.author ? [`by ${mdEsc(d.author)}`] : [])); continue }
    if (u.kind === 'contents') continue // Markdown readers build their own
    if (headingOf(u)) out.push(h + headingOf(u))
    for (const b of u.blocks) out.push(b.type === 'break' ? brk : b.type === 'quote' ? '> ' + runs(b.runs) : b.type === 'scene' || b.type === 'h1' || b.type === 'h2' ? '#'.repeat(Math.min(6, u.depth + (b.type === 'h2' ? 3 : 2))) + ' ' + runs(b.runs) : runs(b.runs))
  }
  return out.join('\n\n') + (notes.length ? '\n\n' + notes.map((n, i) => `[^${i + 1}]: ${n}`).join('\n') : '') + '\n'
}
export function toText(d: Doc): string {
  const out: string[] = []
  for (const u of d.units) {
    const notes: string[] = []
    const runs = (ps: DocPiece[]) => ps.map(p => (isNote(p) ? (notes.push(p.note.map(r => r.text).join('')), `[${notes.length}]`) : p.text)).join('')
    if (u.kind === 'titlepage') { out.push([d.title.toUpperCase(), d.subtitle, d.author && 'by ' + d.author].filter(Boolean).join('\n')); continue }
    if (u.kind === 'contents') continue
    if (headingOf(u)) out.push((u.kind === 'chapter' ? headingOf(u) : headingOf(u).toUpperCase()))
    for (const b of u.blocks) out.push(b.type === 'break' ? d.breakText : b.type === 'quote' ? '    ' + runs(b.runs) : runs(b.runs))
    if (notes.length) out.push('Notes\n' + notes.map((n, i) => `${i + 1}. ${n}`).join('\n'))
  }
  return out.join('\n\n') + '\n'
}

// ---------------- HTML for PDF and print ----------------

const cssStr = (t: string) => '"' + t.replace(/["\\]/g, '\\$&').replace(/\n/g, ' ') + '"'
/** The book as one HTML page for Chromium to print: paperback (trim size, mirrored margins, running heads), reading copy, or print. */
export function toHtml(d: Doc, o: ExportOpts, mode: 'paperback' | 'reading' | 'print'): string {
  const [w, h] = TRIMS[o.trim] || TRIMS['5.5x8.5']
  const size = mode === 'paperback' ? `${w}in ${h}in` : mode === 'reading' ? PAGES[o.page] || 'Letter' : 'auto'
  const font = `${cssStr(o.font)}, Georgia, 'Times New Roman', serif`
  const page = mode === 'paperback'
    ? `@page{size:${size};margin:.7in .6in .75in .75in}
@page :left{margin:.7in .75in .75in .6in;@top-left{content:${cssStr(d.author)};font:italic 8pt ${font};color:#555}@bottom-left{content:counter(page);font:8pt ${font}}}
@page :right{@top-right{content:${cssStr(d.title)};font:italic 8pt ${font};color:#555}@bottom-right{content:counter(page);font:8pt ${font}}}
@page front{@top-left{content:none}@top-right{content:none}@bottom-left{content:none}@bottom-right{content:none}}`
    : mode === 'reading' ? `@page{size:${size};margin:2.2cm 2.4cm 2.4cm;@bottom-center{content:counter(page);font:9pt ${font};color:#666}} @page front{@bottom-center{content:none}}`
      : '@page{margin:2cm}'
  const css = `${page}
body{font:${o.size}pt/${mode === 'paperback' ? 1.4 : 1.55} ${font};color:#111;margin:0;${mode === 'paperback' ? 'text-align:justify;hyphens:auto;' : ''}widows:2;orphans:2}
p{margin:0;text-indent:1.5em} p.first,blockquote p{text-indent:0} blockquote{margin:.8em 1.5em}
.unit{break-before:page} .unit:first-child{break-before:auto} .front{page:front}
h1,h2{font-weight:normal;text-align:center;margin:${mode === 'paperback' ? '1.4in' : '2.5em'} 0 2em;line-height:1.3;break-after:avoid} h1 span,h2 span{display:block}
.label{font-size:.85em;letter-spacing:.12em;text-transform:uppercase;margin-bottom:.5em} h1 .title{font-size:1.6em} h2 .title{font-size:1.35em}
h3,h4{font-size:1em;text-align:center;margin:1.4em 0 .6em;break-after:avoid} h4{font-weight:normal;font-style:italic} h3.scene{text-align:left;font-style:italic;font-weight:normal}
.break{text-align:center;text-indent:0;margin:1em 0;break-after:avoid}
.titlepage{text-align:center;padding-top:30%} .titlepage h1{font-size:2.2em;margin:0 0 .4em} .titlepage p{text-indent:0} .titlepage .sub{font-style:italic;margin-bottom:3em}
.copyright{padding-top:55%;font-size:.85em} .copyright p,.dedication p,.epigraph p{text-indent:0;margin:.4em 0}
.dedication,.epigraph{padding-top:30%;text-align:center} .dedication{font-style:italic}
.contents ol{list-style:none;padding-left:1.2em} .contents>ol{padding-left:0} .contents li{margin:.35em 0} .contents a{color:inherit;text-decoration:none}
.notes{margin-top:2em;font-size:.85em;border-top:1px solid #999;padding-top:.6em} .notes p{text-indent:0} sup{font-size:.7em;line-height:0}`
  const body = d.units.map(u => {
    const notes: string[] = []
    const note = (runs: DocRun[]) => { notes.push(blocksHtml([{ type: 'p', runs, first: true }], '', () => '')); return `<sup>${notes.length}</sup>` }
    // Front matter and a part's title page carry no running head or page number.
    const front = ['titlepage', 'copyright', 'dedication', 'epigraph', 'contents'].includes(u.kind) || (u.kind === 'part' && !u.blocks.length) ? ' front' : ''
    const inner = u.kind === 'titlepage' ? `<h1>${escHtml(d.title)}</h1>${d.subtitle ? `<p class="sub">${escHtml(d.subtitle)}</p>` : ''}<p>${escHtml(d.author)}</p>`
      : u.kind === 'contents' ? `<h2>Contents</h2>${contentsHtml(d.units, () => '#')}`
        : headingHtml(u) + blocksHtml(u.blocks, d.breakText, note) + (notes.length ? `<ol class="notes">${notes.map(n => `<li>${n}</li>`).join('')}</ol>` : '')
    return `<section class="unit ${u.kind}${front}">${inner}</section>`
  }).join('\n')
  return `<!doctype html><html lang="${escHtml(d.language || 'en')}"><meta charset="utf-8"><title>${escHtml(d.title)}</title><style>${css}</style><body>${body}</body></html>`
}

// ---------------- writing the file ----------------

/** POST to the desktop shell, which shows a save dialog. The saved path, or '' when cancelled. */
export async function saveVia(url: string, body: BodyInit): Promise<string> {
  const r = await fetch(url, { method: 'POST', body })
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()).path
}
const fileName = (t: string) => t.replace(/[^\p{L}\p{N}\- ]+/gu, '').trim() || 'canon'

/** Compile and save. Returns the saved path ('' when the save dialog was cancelled). */
export async function exportBook(s: State, ids: string[], o: ExportOpts): Promise<string> {
  const d = buildDoc(s, ids, o)
  if (!d.units.some(u => u.blocks.length)) throw new Error(ids.length ? 'Nothing to export: the chosen scenes have no text yet (or are left out of export).' : 'Nothing to export yet: no scene has any text.')
  const name = `${fileName(d.title)}.${o.file}`, q = '?name=' + encodeURIComponent(name), doc = JSON.stringify(d)
  switch (o.file) {
    case 'docx': return saveVia('/api/export/docx' + q, doc)
    case 'rtf': return saveVia('/api/export/rtf' + q, doc)
    case 'epub': return saveVia('/api/export/ebook' + q, doc)
    case 'pdf': return saveVia('/api/export/pdf' + q, JSON.stringify({ html: toHtml(d, o, o.preset === 'paperback' ? 'paperback' : 'reading') }))
    case 'md': return saveVia('/api/save' + q, toMarkdown(d))
    case 'txt': return saveVia('/api/save' + q, toText(d))
  }
}

/** Print: the scenes chosen (none: everything) in a plain reading layout, through the system print dialog. */
export async function printBook(s: State, ids: string[]) {
  const o = { ...defaultsFor('reading'), titlePage: false }
  const d = buildDoc(s, ids, o)
  if (!d.units.some(u => u.blocks.length)) throw new Error('Nothing to print: there is no text here yet.')
  if (ids.length && ids.every(id => s.recs[id]?.kind === 'scene')) d.units = d.units.filter(u => u.blocks.length) // one scene: no page for its part heading
  const r = await fetch('/api/print', { method: 'POST', body: JSON.stringify({ html: toHtml(d, o, 'print') }) })
  if (!r.ok) throw new Error(await r.text())
}

// ---------------- the older form (kept for callers that still use it) ----------------

export type Format = 'md' | 'txt' | 'html' | 'epub'
export const FORMATS: { id: Format; label: string }[] = [{ id: 'epub', label: 'EPUB' }, { id: 'html', label: 'PDF' }, { id: 'md', label: 'Markdown' }, { id: 'txt', label: 'Plain text' }]
export interface CompileOpts { sceneTitles: boolean; storyTitles: boolean; titlePage: boolean; separator: string }
export function compile(s: State, ids: string[], format: Format, o: CompileOpts): Promise<string> {
  const preset: Preset = format === 'epub' ? 'ebook' : format === 'html' ? 'reading' : format === 'md' ? 'markdown' : 'text'
  return exportBook(s, ids, { ...defaultsFor(preset), sceneTitles: o.sceneTitles, storyTitles: o.storyTitles, titlePage: o.titlePage, breakText: o.separator })
}
