// Word (.docx) and RTF in standard manuscript format: 12 pt Times New Roman, double spaced, 1-inch margins, first-line indents,
// a "Surname / TITLE / page" header from the first page of text, chapters on a new page a third of the way down, scene breaks as "#".
// OOXML is written by hand: a few XML parts in a zip (no dependency), with real footnotes.
import { zip } from './epub.ts'
import { inContents, headingOf, isNote, type Doc, type DocBlock, type DocPiece, type DocRun, type DocUnit } from './doc.ts'

const PAGE = { letter: { w: 12240, h: 15840 }, a4: { w: 11906, h: 16838 } } // twips
const surname = (author: string) => author.trim().split(/\s+/).pop() || ''
/** "Surname / SHORT TITLE / " for the running header (the title cut to a few words, as agents expect). */
export function runningHead(d: Doc) {
  const t = d.title.trim().split(/\s+/).slice(0, 4).join(' ').toUpperCase()
  return [surname(d.author), t].filter(Boolean).join(' / ') + ' / '
}
/** "about 82,000 words": to the nearest thousand (hundred below 1,000). */
export const aboutWords = (n: number) => `about ${(n < 1000 ? Math.max(100, Math.round(n / 100) * 100) : Math.round(n / 1000) * 1000).toLocaleString('en-US')} words`

// ---------------- Word ----------------

const x = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const run = (r: DocRun, extra = '') => {
  const pr = `${r.strong ? '<w:b/>' : ''}${r.em ? '<w:i/>' : ''}${extra}`
  return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${x(r.text)}</w:t></w:r>`
}
const para = (style: string, inner: string, pPr = '') => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${pPr}</w:pPr>${inner}</w:p>`

const STYLES = (size = 24) => `${XML}<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="480" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:firstLine="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="FirstParagraph"><w:name w:val="First Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Title"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="FirstParagraph"/><w:qFormat/><w:pPr><w:keepNext/><w:pageBreakBefore/><w:spacing w:before="2880" w:after="480"/><w:ind w:firstLine="0"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Heading1"/><w:next w:val="FirstParagraph"/><w:qFormat/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="ChapterTitle"><w:name w:val="Chapter Title"/><w:basedOn w:val="Normal"/><w:next w:val="FirstParagraph"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:after="480"/><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="FirstParagraph"/><w:qFormat/><w:pPr><w:keepNext/><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Heading3"/><w:next w:val="FirstParagraph"/><w:qFormat/><w:rPr><w:b w:val="0"/><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="SceneTitle"><w:name w:val="Scene Title"/><w:basedOn w:val="Normal"/><w:next w:val="FirstParagraph"/><w:qFormat/><w:pPr><w:keepNext/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720" w:right="720" w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="SceneBreak"><w:name w:val="Scene Break"/><w:basedOn w:val="Normal"/><w:next w:val="FirstParagraph"/><w:qFormat/><w:pPr><w:keepNext/><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Centered"><w:name w:val="Centered"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Contact"><w:name w:val="Contact"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/><w:jc w:val="right"/></w:pPr></w:style>
</w:styles>`

const BLOCK_STYLE: Record<DocBlock['type'], string> = { p: '', quote: 'Quote', h1: 'Heading3', h2: 'Heading4', break: 'SceneBreak', scene: 'SceneTitle' }

export function docx(d: Doc, now = new Date()): Uint8Array {
  const notes: string[] = []
  const pieces = (ps: DocPiece[]) => ps.map(p => {
    if (!isNote(p)) return run(p)
    const id = notes.length + 1
    notes.push(`<w:footnote w:id="${id}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>${p.note.map(r => run(r)).join('')}</w:p></w:footnote>`)
    return `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`
  }).join('')
  let breakNext = false // a new page before the next paragraph (a story or body without a heading of its own)
  const block = (b: DocBlock) => {
    const pb = breakNext ? '<w:pageBreakBefore/>' : ''
    breakNext = false
    return b.type === 'break' ? para('SceneBreak', run({ text: d.breakText || '#' }), pb)
      : para(b.type === 'p' ? (b.first ? 'FirstParagraph' : '') : BLOCK_STYLE[b.type], pieces(b.runs), pb)
  }
  const page = PAGE[d.paper || 'letter']
  // Child order matters to Word (schema order): headerReference, pgSz, pgMar, pgNumType, cols.
  const sect = (header: boolean) => `<w:sectPr>${header ? '<w:headerReference w:type="default" r:id="rIdHeader"/>' : ''}<w:pgSz w:w="${page.w}" w:h="${page.h}"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>${header ? '<w:pgNumType w:start="1"/>' : ''}<w:cols w:space="720"/></w:sectPr>`

  const out: string[] = []
  let top = true // at the top of a page: the next heading needs no page break of its own
  const startPage = (style: string, inner: string, extra = '') => { out.push(para(style, inner, (top ? '' : '<w:pageBreakBefore/>') + extra)); top = false }
  const contents = d.units.filter(inContents)
  for (const u of d.units) {
    if (u.kind === 'titlepage') {
      const [first = d.author, ...rest] = (d.contact?.trim() || d.author).split('\n').map(l => l.trim()).filter(Boolean)
      out.push(para('Contact', `${run({ text: first })}<w:r><w:tab/></w:r>${run({ text: aboutWords(d.words) })}`, '<w:tabs><w:tab w:val="right" w:pos="' + (page.w - 2880) + '"/></w:tabs>'))
      for (const l of rest) out.push(para('Contact', run({ text: l })))
      out.push(para('Title', run({ text: d.title }), '<w:spacing w:before="4320"/>'))
      if (d.subtitle) out.push(para('Subtitle', run({ text: d.subtitle })))
      // The title page is its own section, so the header and the page numbers start on the first page of text.
      out.push(para('Title', run({ text: 'by ' + d.author }), sect(false)))
      top = true
      continue
    }
    if (u.kind === 'contents') {
      startPage('Centered', run({ text: 'Contents' }), '<w:spacing w:before="2880" w:after="480"/>')
      for (const c of contents) out.push(para('Contact', run({ text: headingOf(c) }), `<w:ind w:left="${c.depth * 360}" w:firstLine="0"/>`))
      continue
    }
    if (u.kind === 'copyright' || u.kind === 'dedication' || u.kind === 'epigraph') {
      u.blocks.forEach((b, i) => { const inner = pieces(b.runs); if (i === 0) startPage('Centered', inner, '<w:spacing w:before="2880"/>'); else out.push(para('Centered', inner)) })
      continue
    }
    if (u.kind === 'body') { breakNext = !top && u.blocks.length > 0; top = false }
    else {
      const style = u.kind === 'chapter' ? 'Heading2' : 'Heading1'
      const h = u.label || u.title || ''
      out.push(para(style, run({ text: h }), top ? '<w:pageBreakBefore w:val="0"/>' : ''))
      top = false
      if (u.label && u.title) out.push(para('ChapterTitle', run({ text: u.title })))
    }
    for (const b of u.blocks) out.push(block(b))
  }

  const head = `${XML}<w:hdr ${W}><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr>${run({ text: runningHead(d) })}<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:hdr>`
  const footnotes = `${XML}<w:footnotes ${W}>
<w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote>
<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
${notes.join('\n')}</w:footnotes>`
  const ct = 'application/vnd.openxmlformats-officedocument.wordprocessingml'
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z')
  return zip([
    { name: '[Content_Types].xml', data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="${ct}.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="${ct}.styles+xml"/><Override PartName="/word/settings.xml" ContentType="${ct}.settings+xml"/>
<Override PartName="/word/footnotes.xml" ContentType="${ct}.footnotes+xml"/><Override PartName="/word/header1.xml" ContentType="${ct}.header+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${rel}/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: 'docProps/core.xml', data: `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${x(d.title)}</dc:title><dc:creator>${x(d.author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>` },
    { name: 'docProps/app.xml', data: `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Canon</Application><Words>${d.words}</Words></Properties>` },
    { name: 'word/_rels/document.xml.rels', data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="${rel}/styles" Target="styles.xml"/>
<Relationship Id="rIdSettings" Type="${rel}/settings" Target="settings.xml"/><Relationship Id="rIdNotes" Type="${rel}/footnotes" Target="footnotes.xml"/><Relationship Id="rIdHeader" Type="${rel}/header" Target="header1.xml"/></Relationships>` },
    { name: 'word/styles.xml', data: STYLES() },
    { name: 'word/settings.xml', data: `${XML}<w:settings ${W}><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>
<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>` },
    { name: 'word/footnotes.xml', data: footnotes },
    { name: 'word/header1.xml', data: head },
    { name: 'word/document.xml', data: `${XML}<w:document ${W}><w:body>${out.join('\n')}${sect(true)}</w:body></w:document>` },
  ], now)
}

// ---------------- RTF ----------------

/** RTF text: escape the control characters, and write everything outside ASCII as \uN? (signed 16-bit units, so emoji go as surrogate pairs). */
export function rtfText(t: string) {
  let o = ''
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    if (c === 92 || c === 123 || c === 125) o += '\\' + t[i]
    else if (c === 9) o += '\\tab '
    else if (c < 32) continue
    else if (c < 128) o += t[i]
    else o += `\\u${c > 32767 ? c - 65536 : c}?`
  }
  return o
}
const rtfRun = (r: DocRun) => (r.em || r.strong ? `{${r.strong ? '\\b' : ''}${r.em ? '\\i' : ''} ${rtfText(r.text)}}` : rtfText(r.text))

export function rtf(d: Doc): string {
  const page = PAGE[d.paper || 'letter']
  const base = '\\pard\\plain\\f0\\fs24\\sl480\\slmult1'
  const pieces = (ps: DocPiece[]) => ps.map(p => isNote(p)
    ? `{\\super\\chftn}{\\footnote\\pard\\plain\\f0\\fs20\\sl240\\slmult1 {\\super\\chftn} ${p.note.map(rtfRun).join('')}}`
    : rtfRun(p)).join('')
  const P = (fmt: string, inner: string) => `${base}${fmt} ${inner}\\par\n`
  const FMT: Record<DocBlock['type'], string> = { p: '\\fi720', quote: '\\li720\\ri720\\fi0', h1: '\\qc\\fi0\\keepn\\b', h2: '\\qc\\fi0\\keepn\\i', break: '\\qc\\fi0\\keepn', scene: '\\fi0\\keepn\\i' }
  const out: string[] = []
  let top = true
  const heading = (inner: string) => { out.push(P(`\\qc\\fi0\\keepn\\sb2880\\sa480${top ? '' : '\\pagebb'}`, inner)); top = false }
  const contents = d.units.filter(inContents)
  for (const u of d.units) {
    if (u.kind === 'titlepage') {
      const [first = d.author, ...rest] = (d.contact?.trim() || d.author).split('\n').map(l => l.trim()).filter(Boolean)
      out.push(`\\pard\\plain\\f0\\fs24\\tqr\\tx${page.w - 2880} ${rtfText(first)}\\tab ${rtfText(aboutWords(d.words))}\\par\n`)
      for (const l of rest) out.push(`\\pard\\plain\\f0\\fs24 ${rtfText(l)}\\par\n`)
      out.push(P('\\qc\\fi0\\sb4320', rtfText(d.title)))
      if (d.subtitle) out.push(P('\\qc\\fi0', rtfText(d.subtitle)))
      out.push(P('\\qc\\fi0', rtfText('by ' + d.author)))
      // A new section for the text: its header and page numbers start at 1 on the first page of text.
      out.push(`\\sect\\sectd\\pgnrestart\\pgnstarts1{\\header\\pard\\plain\\f0\\fs24\\qr ${rtfText(runningHead(d))}\\chpgn\\par}\n`)
      top = true
      continue
    }
    if (u.kind === 'contents') { heading('Contents'); for (const c of contents) out.push(`\\pard\\plain\\f0\\fs24\\li${c.depth * 360} ${rtfText(headingOf(c))}\\par\n`); continue }
    if (u.kind === 'copyright' || u.kind === 'dedication' || u.kind === 'epigraph') {
      u.blocks.forEach((b, i) => out.push(P(`\\qc\\fi0${i === 0 ? `\\sb2880${top ? '' : '\\pagebb'}` : ''}`, pieces(b.runs))))
      top = false
      continue
    }
    if (u.kind === 'body') { if (!top && u.blocks.length) out.push('\\page\n'); top = false }
    else { heading(rtfText(u.label || u.title || '')); if (u.label && u.title) out.push(P('\\qc\\fi0\\keepn\\sa480', rtfText(u.title))) }
    for (const b of u.blocks) out.push(b.type === 'break' ? P(FMT.break, rtfText(d.breakText || '#')) : P(b.type === 'p' && b.first ? '\\fi0' : FMT[b.type], pieces(b.runs)))
  }
  const head = d.units.some(u => u.kind === 'titlepage') ? '' : `{\\header\\pard\\plain\\f0\\fs24\\qr ${rtfText(runningHead(d))}\\chpgn\\par}\n`
  return `{\\rtf1\\ansi\\ansicpg1252\\deff0\\deflang1033{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}}
{\\info{\\title ${rtfText(d.title)}}{\\author ${rtfText(d.author)}}}
\\paperw${page.w}\\paperh${page.h}\\margl1440\\margr1440\\margt1440\\margb1440\\headery720\\ftnbj\\sectd
${head}${out.join('')}}`
}

/** For tests: the headings in reading order. */
export const headings = (units: DocUnit[]) => units.filter(inContents).map(headingOf)
