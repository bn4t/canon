import { test } from 'node:test'
import assert from 'node:assert/strict'
import { docx, rtf, rtfText, runningHead, aboutWords } from './docx.ts'
import { ebook } from './epub.ts'
import { unzip, docx as readDocx, rtf as readRtf } from './convert.ts'
import type { Doc } from './doc.ts'

const DOC: Doc = {
  title: 'The Quiet Ledger', subtitle: 'A Novel', author: 'Mara Okafor', contact: 'Mara Okafor\n12 Harbour Lane\nmara@example.com', words: 81_640,
  language: 'en-GB', publisher: 'Small Hours', isbn: '9780000000001', series: 'Harbour', seriesIndex: 2, rights: '© 2026 Mara Okafor',
  breakText: '#', paper: 'a4',
  units: [
    { kind: 'titlepage', depth: 0, blocks: [] },
    { kind: 'part', label: 'Part One', title: 'Low Tide', depth: 0, blocks: [] },
    { kind: 'chapter', label: 'Chapter One', title: 'The office at night', depth: 1, blocks: [
      { type: 'p', first: true, runs: [{ text: 'The ledger was ' }, { text: 'wrong', em: true }, { text: '.' }, { note: [{ text: 'It had been for years.' }] }] },
      { type: 'p', runs: [{ text: 'She closed it {carefully} \\ and left.' }] },
      { type: 'break', runs: [] },
      { type: 'quote', runs: [{ text: 'Nothing balances.' }] },
    ] },
    { kind: 'chapter', label: 'Chapter Two', depth: 1, blocks: [{ type: 'p', first: true, runs: [{ text: 'Morning. Café au lait.' }] }] },
  ],
}
const files = (b: Uint8Array) => new Map([...unzip(b)].map(([k, v]) => [k, new TextDecoder().decode(v)]))

test('docx: italics, footnotes, a new page per chapter, the running head', () => {
  const z = files(docx(DOC, new Date(0)))
  const doc = z.get('word/document.xml')!
  assert.match(doc, /<w:i\/>.*wrong/s)
  assert.match(doc, /<w:footnoteReference w:id="1"\/>/)
  assert.match(z.get('word/footnotes.xml')!, /It had been for years\./)
  assert.match(doc, /<w:pStyle w:val="Heading2"\/>[^]*?Chapter Two/)
  assert.ok(doc.indexOf('Chapter One') < doc.indexOf('Chapter Two'))
  assert.match(doc, /about 82,000 words/)
  assert.match(doc, /w:w="11906"/, 'A4 paper')
  assert.match(z.get('word/header1.xml')!, /Okafor \/ THE QUIET LEDGER \/ /)
  assert.match(z.get('word/header1.xml')!, /PAGE/)
  assert.match(z.get('docProps/core.xml')!, /<dc:title>The Quiet Ledger<\/dc:title>/)
  assert.match(doc, /\{carefully\} \\ and left/, 'braces and backslashes are plain text in Word')
})

test('docx and rtf open again in Canon (round trip through the importer)', () => {
  const fromWord = readDocx(docx(DOC), 'x.docx').text!
  assert.match(fromWord, /The ledger was \*wrong\*\.\^\[It had been for years\.\]/)
  assert.match(fromWord, /^> Nothing balances\./m)
  const fromRtf = readRtf(rtf(DOC))
  assert.match(fromRtf, /The ledger was \*wrong\*\.\^\[It had been for years\.\]/)
  assert.match(fromRtf, /She closed it \{carefully\} \\ and left\./)
  assert.match(fromRtf, /Café au lait/)
})

test('rtf: escapes, unicode, page numbers', () => {
  assert.equal(rtfText('a{b}\\c\tд'), 'a\\{b\\}\\\\c\\tab \\u1076?')
  assert.equal(rtfText('😀'), '\\u-10179?\\u-8704?', 'astral characters as two signed UTF-16 units')
  const r = rtf(DOC)
  assert.ok(r.startsWith('{\\rtf1'))
  assert.match(r, /\\i wrong/)
  assert.match(r, /\\footnote/)
  assert.match(r, /\\chpgn/)
  assert.match(r, /\\pgnrestart/)
  assert.equal(r.split('{').length, r.split('}').length, 'groups balance')
})

test('runningHead and aboutWords', () => {
  assert.equal(runningHead(DOC), 'Okafor / THE QUIET LEDGER / ')
  assert.equal(aboutWords(81_640), 'about 82,000 words')
  assert.equal(aboutWords(740), 'about 700 words')
})

test('ebook: cover, nested contents, endnotes, metadata', () => {
  const cover = { data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mime: 'image/jpeg' }
  const z = files(ebook({ ...DOC, units: DOC.units.filter(u => u.kind !== 'titlepage') }, cover, new Date(0)))
  const names = [...z.keys()]
  assert.equal(names[0], 'mimetype')
  const opf = z.get('OEBPS/book.opf')!
  assert.match(opf, /properties="cover-image"/)
  assert.match(opf, /<meta name="cover" content="cover-image"\/>/)
  assert.match(opf, /urn:isbn:9780000000001/)
  assert.match(opf, /<dc:language>en-GB<\/dc:language>/)
  assert.match(opf, /belongs-to-collection[^>]*>Harbour</)
  const nav = z.get('OEBPS/nav.xhtml')!
  assert.match(nav, /Part One: Low Tide<\/a><ol><li><a [^>]*>Chapter One: The office at night/, 'chapters nest under their part')
  const ch = names.map(n => z.get(n)!).find(t => t.includes('The ledger was'))!
  assert.match(ch, /<em>wrong<\/em>/)
  assert.match(ch, /epub:type="noteref"[^>]*href="notes.xhtml#n1"/)
  assert.match(z.get('OEBPS/notes.xhtml')!, /It had been for years\./)
  assert.match(z.get('OEBPS/toc.ncx')!, /<navPoint[^>]*>[^]*<navPoint/, 'NCX nests too')
})
