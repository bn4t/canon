// The compiled manuscript, as the renderer hands it to the writers (DOCX, RTF, EPUB here; PDF, Markdown and text in compile.ts).
// Plain data and types only: the renderer imports these types too.

export interface DocRun { text: string; em?: boolean; strong?: boolean }
/** A run of text, or a footnote. */
export type DocPiece = DocRun | { note: DocRun[] }
/** 'scene': a scene's title; 'h1'/'h2': headings inside the prose (letters, documents); `first`: no first-line indent (after a heading or break). */
export interface DocBlock { type: 'p' | 'quote' | 'h1' | 'h2' | 'break' | 'scene'; runs: DocPiece[]; first?: boolean }
export type UnitKind = 'titlepage' | 'copyright' | 'dedication' | 'epigraph' | 'contents' | 'body' | 'story' | 'part' | 'chapter' | 'acknowledgements' | 'about'
/** One page-starting unit: front matter, a story, part or chapter, or back matter.
 * `label`: "Chapter One", "Part Two", a story's title; `title`: the heading's own title. `depth`: nesting in the table of contents. */
export interface DocUnit { kind: UnitKind; label?: string; title?: string; depth: number; blocks: DocBlock[] }
export interface Doc {
  title: string; subtitle?: string; author: string
  /** Manuscript title page: name, address, email, phone (one per line). */
  contact?: string
  /** Rounded for the manuscript title page ("about 82,000 words"). */
  words: number
  language: string; publisher?: string; isbn?: string; description?: string; series?: string; seriesIndex?: number; rights?: string
  /** The cover image: a stored research file in the project's files folder. */
  cover?: { file: string; mime: string }
  breakText: string
  units: DocUnit[]
  /** Page settings for Word and RTF. */
  paper?: 'letter' | 'a4'
}

/** Units that have a heading and belong in a table of contents. */
export const inContents = (u: DocUnit) => u.kind === 'story' || u.kind === 'part' || u.kind === 'chapter' || u.kind === 'acknowledgements' || u.kind === 'about'
/** The heading text of a unit: "Chapter One: The office at night", or whichever part exists. */
export const headingOf = (u: DocUnit) => [u.label, u.title].filter(Boolean).join(': ')
export const isNote = (p: DocPiece): p is { note: DocRun[] } => 'note' in p

// ---------------- HTML (EPUB pages, PDF and print share these) ----------------

export const escHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export const runHtml = (r: DocRun) => { let t = escHtml(r.text); if (r.em) t = `<em>${t}</em>`; if (r.strong) t = `<strong>${t}</strong>`; return t }
/** Blocks as XHTML-safe HTML. `note` returns the markup for a footnote reference (and keeps the note somewhere). */
export function blocksHtml(blocks: DocBlock[], breakText: string, note: (runs: DocRun[]) => string): string {
  const out: string[] = []
  let quote: string[] = []
  const endQuote = () => { if (quote.length) out.push(`<blockquote>${quote.join('')}</blockquote>`); quote = [] }
  for (const b of blocks) {
    const inner = b.runs.map(p => (isNote(p) ? note(p.note) : runHtml(p))).join('')
    if (b.type === 'quote') { quote.push(`<p>${inner}</p>`); continue } // consecutive quote lines are one quotation
    endQuote()
    out.push(b.type === 'break' ? `<p class="break">${escHtml(breakText)}</p>`
      : b.type === 'h1' ? `<h3>${inner}</h3>` : b.type === 'h2' ? `<h4>${inner}</h4>` : b.type === 'scene' ? `<h3 class="scene">${inner}</h3>`
      : `<p${b.first ? ' class="first"' : ''}>${inner}</p>`)
  }
  endQuote()
  return out.join('\n')
}
/** A story, part or chapter heading: the label and the title on their own lines. */
export function headingHtml(u: DocUnit): string {
  const tag = u.kind === 'chapter' || u.kind === 'acknowledgements' || u.kind === 'about' ? 'h2' : 'h1'
  const parts = [u.label && `<span class="label">${escHtml(u.label)}</span>`, u.title && `<span class="title">${escHtml(u.title)}</span>`].filter(Boolean)
  return parts.length ? `<${tag} class="${u.kind}">${parts.join(' ')}</${tag}>` : ''
}
/** Nested <ol> for a table of contents, from units with depths. `href(u)` links each. */
export function contentsHtml(units: DocUnit[], href: (u: DocUnit) => string): string {
  const items = units.filter(inContents)
  if (!items.length) return ''
  const base = Math.min(...items.map(u => u.depth))
  let out = '<ol>', level = 0, first = true
  for (const u of items) {
    const want = first ? 0 : Math.min(Math.max(0, u.depth - base), level + 1) // never skip a level
    if (first) first = false
    else if (want > level) out += '<ol>'
    else { out += '</li>'; for (; level > want; level--) out += '</ol></li>' }
    level = want
    out += `<li><a href="${escHtml(href(u))}">${escHtml(headingOf(u) || 'Untitled')}</a>`
  }
  out += '</li>'
  for (; level > 0; level--) out += '</ol></li>'
  return out + '</ol>'
}
