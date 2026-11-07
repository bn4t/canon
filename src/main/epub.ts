// EPUB 3: `ebook` writes a finished book from a compiled Doc (cover, front matter, nested contents, endnotes, series metadata);
// `epub` is the older chapters-of-HTML form. Both share the zip writer, which Word export uses too.
import { crc32, deflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { blocksHtml, headingHtml, contentsHtml, escHtml, inContents, headingOf, type Doc, type DocRun, type DocUnit } from './doc.ts'

export interface Book { title: string; author: string; chapters: { title: string; html: string }[] } // html: XHTML body fragment, escaped by the renderer

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** Store or deflate entries into a zip archive. ponytail: no zip64; fine below 4 GB. */
export function zip(entries: { name: string; data: string | Uint8Array; store?: boolean }[], now = new Date()): Uint8Array {
  const parts: Buffer[] = [], central: Buffer[] = []
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const date = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  let offset = 0
  for (const e of entries) {
    const raw = Buffer.from(e.data), name = Buffer.from(e.name)
    const body = e.store ? raw : deflateRawSync(raw)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(e.store ? 0 : 8, 8)
    head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12); head.writeUInt32LE(crc32(raw), 14)
    head.writeUInt32LE(body.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(name.length, 26)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); head.copy(cen, 8, 6, 30)
    cen.writeUInt32LE(offset, 42)
    parts.push(head, name, body)
    central.push(cen, name)
    offset += head.length + name.length + body.length
  }
  const size = central.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...parts, ...central, end]))
}

export function epub(b: Book, now = new Date()): Uint8Array {
  const page = (title: string, body: string) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/><title>${esc(title)}</title>
<style>body{font-family:serif;line-height:1.5} p{margin:0;text-indent:1.4em} h1+p,h2+p,.sep+p{text-indent:0} .sep{text-align:center;text-indent:0;margin:1em 0} h2{font-size:1em;font-style:italic;font-weight:normal}</style></head><body>${body}</body></html>`
  const files: { name: string; data: string; store?: boolean }[] = [
    { name: 'mimetype', data: 'application/epub+zip', store: true }, // must come first, uncompressed
    { name: 'META-INF/container.xml', data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
  ]
  let manifest = '', spine = '', nav = ''
  b.chapters.forEach((c, i) => {
    const name = `c${i + 1}.xhtml`
    files.push({ name: 'OEBPS/' + name, data: page(c.title, `<h1>${esc(c.title)}</h1>\n${c.html}`) })
    manifest += `<item id="c${i + 1}" href="${name}" media-type="application/xhtml+xml"/>`
    spine += `<itemref idref="c${i + 1}"/>`
    nav += `<li><a href="${name}">${esc(c.title)}</a></li>`
  })
  files.push(
    { name: 'OEBPS/nav.xhtml', data: page(b.title, `<nav epub:type="toc"><h1>Contents</h1><ol>${nav}</ol></nav>`) },
    { name: 'OEBPS/book.opf', data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:canon:${now.getTime()}</dc:identifier><dc:title>${esc(b.title)}</dc:title><dc:creator>${esc(b.author || '')}</dc:creator><dc:language>en</dc:language>
<meta property="dcterms:modified">${now.toISOString().replace(/\.\d+Z$/, 'Z')}</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest}</manifest><spine>${spine}</spine></package>` },
  )
  return zip(files, now)
}

// ---------------- the finished book ----------------

export interface Cover { data: Uint8Array; mime: string }
const COVER_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' }
const CSS = `body{font-family:serif;line-height:1.5;margin:0 4%}
p{margin:0;text-indent:1.4em} p.first,h1+p,h2+p,h3+p,h4+p,.break+p,blockquote+p{text-indent:0}
h1,h2{font-weight:normal;text-align:center;margin:3em 0 2em;line-height:1.3} h1 span,h2 span{display:block} h1 .label,h2 .label{font-size:.8em;letter-spacing:.08em;text-transform:uppercase;margin-bottom:.4em}
h1 .title{font-size:1.4em} h2 .title{font-size:1.2em} h3,h4{font-size:1em;text-align:center;margin:1.5em 0 .5em} h3{font-weight:bold} h4{font-weight:normal;font-style:italic} h3.scene{text-align:left;font-style:italic;font-weight:normal}
blockquote{margin:1em 1.5em} blockquote p{text-indent:0;margin:.3em 0} .break{text-align:center;text-indent:0;margin:1em 0}
.cover{margin:0;padding:0;text-align:center} .cover img{max-width:100%;max-height:100vh}
.titlepage{text-align:center;margin-top:20%} .titlepage .book-title{font-size:2em;margin:0 0 .3em} .titlepage .subtitle{font-style:italic;margin-bottom:2em} .titlepage p{text-indent:0}
.copyright{font-size:.85em;margin-top:40%} .copyright p{text-indent:0;margin:.5em 0}
.dedication,.epigraph{margin-top:30%;text-align:center} .dedication p,.epigraph p{text-indent:0;margin:.5em 0} .dedication{font-style:italic}
.contents ol{list-style:none;padding-left:1.2em} .contents>ol{padding-left:0} .contents li{margin:.3em 0}
sup a{text-decoration:none} .notes li{margin:.5em 0} .notes p{text-indent:0}`

const uuid = (seed: string) => { const h = createHash('sha1').update(seed).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}` }
const EPUB_TYPE: Partial<Record<DocUnit['kind'], string>> = { copyright: 'copyright-page', dedication: 'dedication', epigraph: 'epigraph', body: 'bodymatter', story: 'part', part: 'part', chapter: 'chapter', acknowledgements: 'acknowledgments', about: 'backmatter' }

export function ebook(d: Doc, cover?: Cover, now = new Date()): Uint8Array {
  const lang = escHtml(d.language || 'en')
  const page = (title: string, body: string, cls = '') => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}"><head><meta charset="utf-8"/><title>${escHtml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body${cls ? ` class="${cls}"` : ''}>${body}</body></html>`
  const files: { name: string; data: string | Uint8Array; store?: boolean }[] = [
    { name: 'mimetype', data: 'application/epub+zip', store: true }, // must come first, uncompressed
    { name: 'META-INF/container.xml', data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { name: 'OEBPS/style.css', data: CSS },
  ]
  const manifest: string[] = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>', '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>', '<item id="css" href="style.css" media-type="text/css"/>']
  const spine: string[] = []
  const add = (id: string, href: string, html: string, linear = true) => { files.push({ name: 'OEBPS/' + href, data: html }); manifest.push(`<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="${id}"${linear ? '' : ' linear="no"'}/>`) }

  const ext = cover && COVER_EXT[cover.mime]
  if (cover && ext) {
    files.push({ name: `OEBPS/cover.${ext}`, data: cover.data })
    manifest.push(`<item id="cover-image" href="cover.${ext}" media-type="${cover.mime}" properties="cover-image"/>`)
    add('cover', 'cover.xhtml', page(d.title, `<section epub:type="cover" class="cover"><img src="cover.${ext}" alt="${escHtml(d.title)}"/></section>`))
  }

  const fileOf = new Map<DocUnit, string>(d.units.map((u, i) => [u, u.kind === 'titlepage' ? 'title.xhtml' : u.kind === 'contents' ? 'contents.xhtml' : `u${i + 1}.xhtml`]))
  const notes: { n: number; html: string; from: string }[] = []
  d.units.forEach((u, i) => {
    const file = fileOf.get(u)!
    const note = (runs: DocRun[]) => { const n = notes.length + 1; notes.push({ n, html: blocksHtml([{ type: 'p', runs, first: true }], '', () => ''), from: file }); return `<sup><a epub:type="noteref" role="doc-noteref" id="r${n}" href="notes.xhtml#n${n}">${n}</a></sup>` }
    let body: string
    if (u.kind === 'titlepage') body = `<section epub:type="titlepage" class="titlepage"><h1 class="book-title">${escHtml(d.title)}</h1>${d.subtitle ? `<p class="subtitle">${escHtml(d.subtitle)}</p>` : ''}<p class="author">${escHtml(d.author)}</p>${d.publisher ? `<p class="publisher">${escHtml(d.publisher)}</p>` : ''}</section>`
    else if (u.kind === 'contents') body = `<section class="contents"><h2>Contents</h2>${contentsHtml(d.units, x => fileOf.get(x)!)}</section>`
    else body = `<section epub:type="${EPUB_TYPE[u.kind] || 'bodymatter'}" class="${u.kind}">${headingHtml(u)}${blocksHtml(u.blocks, d.breakText, note)}</section>`
    add('u' + (i + 1), file, page(headingOf(u) || d.title, body))
  })
  if (notes.length) add('notes', 'notes.xhtml', page('Notes', `<section epub:type="endnotes" role="doc-endnotes" class="notes"><h2>Notes</h2><ol>${notes.map(n =>
    `<li id="n${n.n}" epub:type="endnote" role="doc-endnote">${n.html.replace(/<\/p>$/, ` <a href="${n.from}#r${n.n}" role="doc-backlink">↩</a></p>`)}</li>`).join('')}</ol></section>`))

  const toc = d.units.filter(inContents)
  const firstBody = d.units.find(u => ['body', 'story', 'part', 'chapter'].includes(u.kind))
  files.push({ name: 'OEBPS/nav.xhtml', data: page('Contents', `<nav epub:type="toc" id="toc" role="doc-toc"><h1>Contents</h1>${contentsHtml(d.units, x => fileOf.get(x)!) || `<ol><li><a href="${fileOf.get(d.units[0]) || 'title.xhtml'}">${escHtml(d.title)}</a></li></ol>`}</nav>
<nav epub:type="landmarks" hidden=""><ol>${cover && ext ? '<li><a epub:type="cover" href="cover.xhtml">Cover</a></li>' : ''}${d.units.some(u => u.kind === 'contents') ? '<li><a epub:type="toc" href="contents.xhtml">Contents</a></li>' : ''}${firstBody ? `<li><a epub:type="bodymatter" href="${fileOf.get(firstBody)}">Start reading</a></li>` : ''}</ol></nav>`) })

  // EPUB 2's NCX, for older readers: the same nesting as navPoints.
  let ncx = '', play = 0, open = 0
  const base = toc.length ? Math.min(...toc.map(u => u.depth)) : 0
  for (const u of toc) {
    const lvl = Math.min(Math.max(0, u.depth - base), open)
    for (; open > lvl; open--) ncx += '</navPoint>'
    ncx += `<navPoint id="p${++play}" playOrder="${play}"><navLabel><text>${escHtml(headingOf(u) || 'Untitled')}</text></navLabel><content src="${fileOf.get(u)}"/>`
    open++
  }
  for (; open > 0; open--) ncx += '</navPoint>'
  const id = d.isbn?.replace(/[^0-9Xx]/g, '') ? `urn:isbn:${d.isbn.replace(/[^0-9Xx]/g, '')}` : `urn:uuid:${uuid(d.title + '\n' + d.author)}`
  files.push({ name: 'OEBPS/toc.ncx', data: `<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${escHtml(id)}"/></head><docTitle><text>${escHtml(d.title)}</text></docTitle><navMap>${ncx}</navMap></ncx>` })

  const meta = [
    `<dc:identifier id="id">${escHtml(id)}</dc:identifier>`,
    `<dc:title id="title">${escHtml(d.title)}</dc:title><meta refines="#title" property="title-type">main</meta>`,
    d.subtitle && `<dc:title id="subtitle">${escHtml(d.subtitle)}</dc:title><meta refines="#subtitle" property="title-type">subtitle</meta>`,
    d.author && `<dc:creator id="author">${escHtml(d.author)}</dc:creator><meta refines="#author" property="role" scheme="marc:relators">aut</meta>`,
    `<dc:language>${lang}</dc:language>`,
    d.publisher && `<dc:publisher>${escHtml(d.publisher)}</dc:publisher>`,
    d.description && `<dc:description>${escHtml(d.description)}</dc:description>`,
    d.rights && `<dc:rights>${escHtml(d.rights)}</dc:rights>`,
    d.series && `<meta property="belongs-to-collection" id="series">${escHtml(d.series)}</meta><meta refines="#series" property="collection-type">series</meta>${d.seriesIndex ? `<meta refines="#series" property="group-position">${d.seriesIndex}</meta>` : ''}`,
    `<meta property="dcterms:modified">${now.toISOString().replace(/\.\d+Z$/, 'Z')}</meta>`,
    cover && ext && '<meta name="cover" content="cover-image"/>',
  ].filter(Boolean).join('\n')
  files.push({ name: 'OEBPS/book.opf', data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id" xml:lang="${lang}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${meta}</metadata>
<manifest>${manifest.join('')}</manifest><spine toc="ncx">${spine.join('')}</spine></package>` })
  return zip(files, now)
}
