import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zip } from './epub.ts'
import { rtf, docx, odt, html, plain, scrivener, folder, unzip, runsToLine } from './convert.ts'

test('RTF: paragraphs, italic and bold, code-page and unicode characters, footnotes', () => {
  // (Plain strings, not String.raw: the TypeScript stripper cooks \u escapes in raw templates.)
  const src = '{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0 Times;}}{\\colortbl;\\red0\\green0\\blue0;}{\\*\\expandedcolortbl;;}\\f0 Plain {\\i italic} and \\b bold\\b0 .\\par\n' +
    "Caf\\'e9 \\u8212? dash.{\\super\\chftn}{\\footnote\\pard\\plain\\chftn  A {\\i note}.}\\par\n\\par\n# \\par\nAfter the break.}"
  assert.equal(rtf(src), 'Plain *italic* and **bold**.\nCafé — dash.^[A *note*.]\n* * *\nAfter the break.')
})

test('runs merge and keep markers tight around words', () => {
  assert.equal(runsToLine([{ text: 'a ' }, { text: 'big ', i: true }, { text: 'dog', i: true }, { text: '.' }]), 'a *big dog*.')
  assert.equal(runsToLine([{ text: '5 * 3' }]), '5 \\* 3')
})

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const p = (style: string, runs: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs}</w:p>`
const r = (t: string, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`

test('Word: title, headings, italics, scene breaks, page breaks and footnotes', () => {
  const doc = `<?xml version="1.0"?><w:document ${W}><w:body>
    ${p('Title', r('My Book'))}${p('Heading1', r('Chapter One'))}
    ${p('', r('She was ') + r('tired', '<w:i/>') + r('. Not ') + r('that', '<w:i w:val="0"/>') + r(' tired.'))}
    ${p('', r('#'))}
    ${p('', r('Next.') + '<w:r><w:footnoteReference w:id="2"/></w:r>')}
    <w:p><w:r><w:br w:type="page"/></w:r></w:p>
    ${p('ChapterHead', r('Chapter Two'))}${p('', r('End &amp; done.', '<w:b/>'))}
  </w:body></w:document>`
  const styles = `<w:styles ${W}><w:style w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
    <w:style w:styleId="ChapterHead"><w:name w:val="Chapter head"/><w:basedOn w:val="Heading1"/></w:style></w:styles>`
  const notes = `<w:footnotes ${W}><w:footnote w:type="separator" w:id="0"><w:p>${r('---')}</w:p></w:footnote><w:footnote w:id="2"><w:p>${r('A note.')}</w:p></w:footnote></w:footnotes>`
  const file = zip([{ name: 'word/document.xml', data: doc }, { name: 'word/styles.xml', data: styles }, { name: 'word/footnotes.xml', data: notes }])
  assert.equal(unzip(file).size, 3)
  const n = docx(file, 'draft.docx')
  assert.equal(n.title, 'My Book')
  assert.equal(n.text, '# Chapter One\nShe was *tired*. Not that tired.\n* * *\nNext.^[A note.]\n* * *\n# Chapter Two\n**End & done.**')
})

test('OpenDocument: headings, styled spans, notes', () => {
  const content = `<office:document-content xmlns:office="o" xmlns:text="t" xmlns:style="s" xmlns:fo="f"><office:automatic-styles>
    <style:style style:name="T1" style:family="text"><style:text-properties fo:font-style="italic"/></style:style></office:automatic-styles>
    <office:body><office:text><text:h text:outline-level="1">Part One</text:h>
    <text:p>A <text:span text:style-name="T1">slanted</text:span> word.<text:note><text:note-citation>1</text:note-citation><text:note-body><text:p>Why.</text:p></text:note-body></text:note></text:p>
    <text:p>* * *</text:p><text:p>Two<text:s text:c="2"/>spaces.</text:p></office:text></office:body></office:document-content>`
  const n = odt(zip([{ name: 'content.xml', data: content }]), 'book.odt')
  assert.equal(n.text, '# Part One\nA *slanted* word.^[Why.]\n* * *\nTwo spaces.')
})

test('HTML and hard-wrapped text', () => {
  assert.equal(html('<title>T</title><h1>One</h1><p>An <em>em</em> &amp; <b>b</b>.</p><hr><p>Two</p>', 'x.html').text, '# One\nAn *em* & **b**.\n* * *\nTwo')
  const wrapped = Array.from({ length: 4 }, (_, i) => `Paragraph ${i} starts here and runs on for a good while past the margin\nand finishes on its second line.`).join('\n\n')
  const t = plain(wrapped, '01 - My story.txt')
  assert.equal(t.title, 'My story')
  assert.equal(t.text!.split('\n\n').length, 4)
  assert.ok(t.text!.startsWith('Paragraph 0 starts here and runs on for a good while past the margin and finishes'))
  assert.equal(plain('Short line.\nAnother.\n\nThird.', 'a.md').text, 'Short line.\nAnother.\n\nThird.', 'short lines are left alone')
})

function fakeScriv() {
  const dir = join(mkdtempSync(join(tmpdir(), 'canon-scriv-')), 'Novel.scriv')
  const data = (id: string, files: Record<string, string>) => { mkdirSync(join(dir, 'Files', 'Data', id), { recursive: true }); for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, 'Files', 'Data', id, k), v) }
  data('T1', { 'content.rtf': String.raw`{\rtf1\ansi The tide was {\i out}.\par}`, 'synopsis.txt': 'Ines arrives.', 'notes.rtf': String.raw`{\rtf1 Check the tide tables.}` })
  data('T2', { 'content.rtf': String.raw`{\rtf1 Gone.}` })
  data('P1', { 'content.pdf': '%PDF-1.4' })
  data('T3', { 'content.rtf': String.raw`{\rtf1 Boats need licences.}` })
  const item = (type: string, id: string, title: string, inner = '') => `<BinderItem UUID="${id}" Type="${type}"><Title>${title}</Title>${inner}</BinderItem>`
  writeFileSync(join(dir, 'Novel.scrivx'), `<?xml version="1.0" encoding="UTF-8"?><ScrivenerProject Version="2.0"><Binder>
    ${item('DraftFolder', 'D', 'Draft', `<Children>${item('Folder', 'C1', 'Chapter 1', `<Children>
      ${item('Text', 'T1', 'Arrival', '<MetaData><LabelID>1</LabelID><StatusID>2</StatusID></MetaData><Keywords><KeywordID>0</KeywordID></Keywords>')}
      ${item('Text', 'T2', 'Departure', '<MetaData><IncludeInCompile>No</IncludeInCompile></MetaData>')}</Children>`)}</Children>`)}
    ${item('ResearchFolder', 'R', 'Research', `<Children>${item('PDF', 'P1', 'Map')}${item('Text', 'T3', 'Notes on boats')}</Children>`)}
    ${item('TrashFolder', 'X', 'Trash', `<Children>${item('Text', 'T9', 'Old')}</Children>`)}
  </Binder><LabelSettings><Labels><Label ID="-1">No Label</Label><Label ID="1" Color="0.5 0.5 0.9">Concept</Label></Labels></LabelSettings>
  <StatusSettings><StatusItems><Status ID="2">First Draft</Status></StatusItems></StatusSettings><Keywords><Keyword ID="0"><Title>harbour</Title></Keyword></Keywords></ScrivenerProject>`)
  return dir
}

test('Scrivener: the draft becomes the manuscript tree, research stays research, trash is skipped', () => {
  const dir = fakeScriv()
  const [draft, research, ...rest] = scrivener(dir)
  assert.equal(rest.length, 0, 'trash skipped')
  assert.equal(draft.title, 'Novel')
  const ch = draft.children![0]
  assert.deepEqual([ch.kind, ch.title], ['folder', 'Chapter 1'])
  const [a, b] = ch.children!
  assert.deepEqual({ t: a.title, text: a.text, syn: a.synopsis, notes: a.notes, label: a.label, status: a.status, kw: a.keywords },
    { t: 'Arrival', text: 'The tide was *out*.', syn: 'Ines arrives.', notes: 'Check the tide tables.', label: 'Concept', status: 'First Draft', kw: ['harbour'] })
  assert.equal(b.exclude, true)
  assert.equal(research.research, true)
  const [pdf, note] = research.children!
  assert.deepEqual([pdf.kind, pdf.file?.mime, pdf.file?.name, note.text], ['file', 'application/pdf', 'Map.pdf', 'Boats need licences.'])
  // Choosing the .scriv package as a folder works too.
  assert.equal(folder(dir).children![0].title, 'Novel')
})
