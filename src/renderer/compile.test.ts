import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDoc, defaultsFor, toMarkdown, toText, toHtml, scenesFor, numberWord, numberLabel } from './compile.ts'
import type { State } from './store.ts'

/** A small project: one story, a part with two chapters, a left-out chapter, a left-out scene, an empty scene. */
function state(extra: Record<string, object> = {}): State {
  const sc = (id: string, order: number, title: string, prose: string, more = {}) => [id, { id, kind: 'scene', story: 'st1', order, title, prose, card: '', wants: '', mustLand: [], beat: '', cast: [], links: {}, pinned: false, snapshots: [], ...more }]
  const sec = (id: string, order: number, type: string, title: string, more = {}) => [id, { id, kind: 'section', story: 'st1', order, type, title, synopsis: '', ...more }]
  const recs = Object.fromEntries([
    ['project', { id: 'project', kind: 'project', title: 'The Quiet Ledger', author: 'Mara Okafor', logline: '', thesis: '', background: '', types: {},
      book: { subtitle: 'A Novel', dedication: 'For *R.*', about: 'Mara lives by the sea.' } }],
    ['st1', { id: 'st1', kind: 'story', title: 'Ledger', order: 1, form: 'prose', premise: '', beats: [] }],
    sec('p1', 1, 'part', 'Low Tide'),
    sec('c1', 2, 'chapter', 'Chapter 1'),
    sc('s1', 3, 'Night', 'The ledger was *wrong*.^[For years.]\nShe left.'),
    sc('s2', 4, 'Dawn', 'Morning came.'),
    sc('s3', 5, 'Cut', 'A scene left out.', { exclude: true }),
    sc('s4', 6, 'Empty', '   '),
    sec('c2', 7, 'chapter', 'The harbour'),
    sc('s5', 8, 'Harbour', '> A quoted sign.\nShe read it.'),
    sec('c3', 9, 'chapter', 'Deleted chapter', { exclude: true }),
    sc('s6', 10, 'Gone', 'Not exported.'),
    ...Object.entries(extra),
  ])
  return { loaded: true, recs, save: 'saved' } as unknown as State
}

test('numbers in words', () => {
  assert.equal(numberWord(1), 'One')
  assert.equal(numberWord(21), 'Twenty-One')
  assert.equal(numberWord(114), 'One Hundred Fourteen')
  assert.equal(numberLabel('Chapter', 3, 'word'), 'Chapter Three')
  assert.equal(numberLabel('Chapter', 3, 'bare-number'), '3')
  assert.equal(numberLabel('Part', 2, 'none'), undefined)
})

test('buildDoc: parts hold chapters, numbering, titles, left-out and empty scenes skipped', () => {
  const s = state()
  assert.deepEqual(scenesFor(s, []).map(x => x.id), ['s1', 's2', 's5'])
  const d = buildDoc(s, [], { ...defaultsFor('ebook'), dedication: true, about: true })
  assert.deepEqual(d.units.map(u => [u.kind, u.label, u.title, u.depth]), [
    ['titlepage', undefined, undefined, 0],
    ['copyright', undefined, undefined, 0],
    ['dedication', undefined, undefined, 0],
    ['contents', undefined, undefined, 0],
    ['part', 'Part One', 'Low Tide', 0],
    ['chapter', 'Chapter One', undefined, 1], // "Chapter 1" is only the number: no title of its own
    ['chapter', 'Chapter Two', 'The harbour', 1],
    ['about', undefined, 'About the author', 0],
  ])
  const c1 = d.units[5]
  assert.deepEqual(c1.blocks.map(b => [b.type, !!b.first]), [['p', true], ['p', false], ['break', false], ['p', true]])
  assert.deepEqual(c1.blocks[0].runs, [{ text: 'The ledger was ' }, { text: 'wrong', em: true }, { text: '.' }, { note: [{ text: 'For years.' }] }])
  assert.equal(d.words, 7 + 2 + 6) // counted as the editor counts them
  assert.equal(d.subtitle, 'A Novel')
  assert.match(d.rights!, /^© \d{4} Mara Okafor$/)
})

test('buildDoc: a chosen chapter, scene titles instead of breaks, manuscript has no copyright page', () => {
  const s = state()
  const d = buildDoc(s, ['c1'], { ...defaultsFor('manuscript'), sceneTitles: true, chapters: 'number', copyright: true })
  assert.deepEqual(d.units.map(u => u.kind), ['titlepage', 'part', 'chapter'])
  assert.equal(d.units[2].label, 'Chapter 1')
  assert.deepEqual(d.units[2].blocks.filter(b => b.type === 'scene').map(b => b.runs), [[{ text: 'Night' }], [{ text: 'Dawn' }]])
  assert.equal(d.breakText, '#')
  assert.equal(buildDoc(s, ['s5'], defaultsFor('text')).words, 6)
})

test('several stories: each opens with its title, chapters nest under it', () => {
  const s = state({ st2: { id: 'st2', kind: 'story', title: 'Coda', order: 2, form: 'prose', premise: '', beats: [] },
    s9: { id: 's9', kind: 'scene', story: 'st2', order: 1, title: 'End', prose: 'The end.', card: '', wants: '', mustLand: [], beat: '', cast: [], links: {}, pinned: false, snapshots: [] } })
  const d = buildDoc(s, [], { ...defaultsFor('reading'), titlePage: false })
  assert.deepEqual(d.units.map(u => [u.kind, u.label, u.depth]), [['story', 'Ledger', 0], ['part', 'Part One', 1], ['chapter', 'Chapter One', 2], ['chapter', 'Chapter Two', 2], ['story', 'Coda', 0]])
  assert.equal(buildDoc(s, ['st2'], defaultsFor('reading')).title, 'Coda', 'one story out of several: its own title')
})

test('Markdown, text and HTML', () => {
  const d = buildDoc(state(), [], { ...defaultsFor('markdown'), dedication: true })
  const md = toMarkdown(d)
  assert.match(md, /^# The Quiet Ledger\n\n\*A Novel\*\n\nby Mara Okafor/)
  assert.match(md, /\n# Part One: Low Tide\n/)
  assert.match(md, /\n## Chapter One\n\nThe ledger was \*wrong\*\.\[\^1\]\n\nShe left\.\n\n\* \* \*\n\nMorning came\./)
  assert.match(md, /\n> A quoted sign\.\n/)
  assert.match(md, /\n\[\^1\]: For years\.\n$/)
  const txt = toText(d)
  assert.match(txt, /The ledger was wrong\.\[1\]/)
  assert.match(txt, /Notes\n1\. For years\./)
  const html = toHtml(d, { ...defaultsFor('paperback') }, 'paperback')
  assert.match(html, /@page\{size:5\.5in 8\.5in/)
  assert.match(html, /@top-right\{content:"The Quiet Ledger"/)
  assert.match(html, /<p class="first">The ledger was <em>wrong<\/em>\.<sup>1<\/sup><\/p>/)
  assert.match(html, /<ol class="notes"><li><p class="first">For years\.<\/p><\/li><\/ol>/)
})
