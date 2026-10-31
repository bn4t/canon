// Compile stories to Markdown, plain text, printable HTML or EPUB (zipped by the Go server).
import { project, scenesOf, get, type State } from './store.ts'

export type Format = 'md' | 'txt' | 'html' | 'epub'
export const FORMATS: { id: Format; label: string }[] = [
  { id: 'md', label: 'Markdown' }, { id: 'txt', label: 'Plain text' }, { id: 'html', label: 'Print / PDF' }, { id: 'epub', label: 'EPUB' },
]
export interface CompileOpts { sceneTitles: boolean; storyTitles: boolean; titlePage: boolean; separator: string }

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const paras = (t: string) => t.split(/\n{2,}|\n(?=\S)/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p).replace(/\n/g, '<br/>')}</p>`).join('\n')

function chapters(s: State, ids: string[]) {
  return ids.map(id => get(s, id, 'story')!).filter(Boolean).map(st => ({
    title: st.title,
    scenes: scenesOf(s, st.id).filter(sc => sc.prose.trim() && !sc.exclude).map(sc => ({ title: sc.title, prose: sc.prose.trim() })),
  }))
}

function save(name: string, blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export async function compile(s: State, ids: string[], format: Format, o: CompileOpts) {
  const se = project(s)
  const title = ids.length === 1 ? get(s, ids[0], 'story')!.title : se.title
  const author = se.author || ''
  const cs = chapters(s, ids)
  const file = title.replace(/[^\w\- ]+/g, '').trim() || 'canon'
  if (format === 'md' || format === 'txt') {
    const md = format === 'md'
    const body = cs.map(c => (!o.storyTitles ? '' : md ? `# ${c.title}\n\n` : `${c.title.toUpperCase()}\n\n`)
      + c.scenes.map(sc => (o.sceneTitles ? (md ? `## ${sc.title}\n\n` : `${sc.title}\n\n`) : '') + sc.prose).join(`\n\n${o.separator}\n\n`)).join('\n\n\n')
    const head = o.titlePage ? (md ? `# ${title}\n\n${author ? `*${author}*\n\n` : ''}` : `${title}\n${author}\n\n\n`) : ''
    return save(`${file}.${format}`, new Blob([head + body + '\n'], { type: 'text/plain;charset=utf-8' }))
  }
  const html = cs.map(c => ({
    title: c.title,
    html: c.scenes.map(sc => (o.sceneTitles ? `<h2>${esc(sc.title)}</h2>\n` : '') + paras(sc.prose)).join(`\n<p class="sep">${esc(o.separator)}</p>\n`),
  }))
  if (format === 'html') {
    const w = open('', '_blank')
    if (!w) throw new Error('The browser blocked the print window. Allow pop-ups for this page.')
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>
      body{font:12pt/1.6 Georgia,serif;max-width:34em;margin:2em auto;color:#111} h1{font-weight:normal;text-align:center;margin:3em 0 2em;page-break-before:always}
      h1:first-of-type{page-break-before:auto} h2{font-size:1em;font-style:italic;font-weight:normal;margin-top:2em} p{margin:0;text-indent:1.5em} h1+p,h2+p,.sep+p{text-indent:0}
      .sep{text-align:center;text-indent:0;margin:1.2em 0} .title{text-align:center;margin-top:30vh} @page{margin:2.2cm}</style>
      ${o.titlePage ? `<div class="title"><h1 style="page-break-before:auto">${esc(title)}</h1><p style="text-align:center">${esc(author)}</p></div>` : ''}
      ${html.map(c => (o.storyTitles ? `<h1>${esc(c.title)}</h1>\n` : '') + c.html).join('\n')}<script>onload=()=>print()</script>`)
    w.document.close()
    return
  }
  // EPUB always keeps chapter titles: readers build the table of contents from them.
  const r = await fetch('/api/compile/epub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, author, chapters: html }) })
  if (!r.ok) throw new Error(await r.text())
  save(`${file}.epub`, await r.blob())
}
