import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { epub } from './epub.ts'

/** Read a zip from its central directory (enough to check what we write). */
function unzip(b: Uint8Array) {
  const buf = Buffer.from(b)
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const n = buf.readUInt16LE(end + 10)
  let p = buf.readUInt32LE(end + 16)
  const out: { name: string; method: number; text: string }[] = []
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString()
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28)
    const data = buf.subarray(start, start + size)
    out.push({ name, method, text: (method === 8 ? inflateRawSync(data) : data).toString() })
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return out
}

test('epub: mimetype first and stored, chapters escaped and in the spine', () => {
  const files = unzip(epub({ title: 'Wrong People', author: 'Ben', chapters: [{ title: 'Kira & Co', html: '<p>Rain.</p>' }] }, new Date(0)))
  assert.equal(files[0].name, 'mimetype')
  assert.equal(files[0].method, 0)
  assert.equal(files[0].text, 'application/epub+zip')
  const by = Object.fromEntries(files.map(f => [f.name, f.text]))
  assert.match(by['OEBPS/c1.xhtml'], /<h1>Kira &amp; Co<\/h1>/)
  assert.match(by['OEBPS/book.opf'], /idref="c1"/)
  assert.match(by['OEBPS/nav.xhtml'], /href="c1.xhtml"/)
})
