// A minimal EPUB 3 (mimetype, container, OPF, nav, one XHTML file per chapter) and the zip writer it needs.
import { crc32, deflateRawSync } from 'node:zlib'

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
