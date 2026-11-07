import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frontmatter, sections } from './importer.ts'

test('frontmatter parses scalars and lists', () => {
  const { meta, body } = frontmatter('---\nname: Kira Sato\naliases: [K, "the Kid"]\nrole: protagonist\n---\nLead.\n')
  assert.equal(meta.name, 'Kira Sato')
  assert.deepEqual(meta.aliases, ['K', 'the Kid'])
  assert.equal(body, 'Lead.\n')
  assert.deepEqual(frontmatter('no frontmatter').meta, {})
})

test('sections split lead and ## headings', () => {
  const r = sections('Lead line.\n\n## Personality\nDry.\n\n## Background\nBorn in Watson.')
  assert.equal(r.lead, 'Lead line.')
  assert.deepEqual(r.sections, [{ heading: 'Personality', text: 'Dry.' }, { heading: 'Background', text: 'Born in Watson.' }])
})

import { splitScenes, planImport } from './importer.ts'
import { DEFAULT_TYPES } from './schema.ts'

test('splitScenes splits on separators and headings', () => {
  const r = splitScenes('One.\n\n---\n\nTwo.\n\n## The Turn\nThree.\n* * *\nFour.')
  assert.deepEqual(r.map(x => x.title), ['Scene 1', 'Scene 2', 'The Turn', 'Scene 4'])
  assert.equal(r[2].prose, 'Three.')
})

test('planImport: manuscripts become stories, frontmatter files become typed sheets', () => {
  const p = planImport([
    { path: 'book/02-the-end.md', text: 'B.' },
    { path: 'book/01_the-start.md', text: 'A.\n---\nA2.' },
    { path: 'cast/mara.md', text: '---\nname: Mara\ntype: character\npronouns: she/her\n---\nA thief.\n\n## Wants\nOut.\n\n## Favorite song\nNone.' },
    { path: 'world/ship.md', text: '---\nname: Halcyon\ntype: vessel\n---\nA ship.' },
  ], DEFAULT_TYPES)
  assert.deepEqual(p.stories.map(s => [s.title, s.scenes.length]), [['the start', 2], ['the end', 1]])
  const mara = p.entities.find(e => e.name === 'Mara')!
  assert.equal(mara.type, 'character')
  assert.equal(mara.fields.pronouns, 'she/her')
  assert.equal(mara.fields.wants, 'Out.')
  assert.ok(p.types.character.fields.some(f => f.label === 'Favorite song'), 'unknown heading becomes a field')
  assert.equal(p.types.vessel.one, 'Vessel')
  assert.equal(DEFAULT_TYPES.character.fields.some(f => f.label === 'Favorite song'), false, 'defaults untouched')
})

test('lint em dash rule is optional', async () => {
  const { lint } = await import('./lint.ts')
  assert.equal(lint('She ran — fast.', [], false).length, 0)
  assert.equal(lint('She ran — and then she stopped running.', [], true).length, 1)
})

import { planTree, planRecords, mapMeta, commonTitle, countPlan, openingWords, type ImportNode, type PlanItem } from './importer.ts'
import type { State } from './store.ts'

const shape = (items: PlanItem[]) => items.map(x => (x.kind === 'scene' ? x.title : `[${x.kind}] ${x.title}`))
const doc = (title: string, text: string): ImportNode => ({ kind: 'text', whole: true, title, text })

test('a Word file: headings make chapters, scene breaks split scenes, untitled scenes take their opening words', () => {
  const book = doc('My Book', '# Chapter One\nShe was *tired* of the harbour and its gulls.\n* * *\nNext.\n# Chapter Two\nEnd.')
  const p = planTree([book], { split: 'breaks', as: 'story' }, DEFAULT_TYPES)
  assert.equal(p.stories[0].title, 'My Book')
  assert.deepEqual(shape(p.stories[0].items), ['[chapter] Chapter One', 'She was tired of the harbour…', 'Next', '[chapter] Chapter Two', 'End'])
  assert.deepEqual(shape(planTree([book], { split: 'headings', as: 'story' }, DEFAULT_TYPES).stories[0].items), ['Chapter One', 'Next', 'Chapter Two'])
  const whole = planTree([book], { split: 'none', as: 'story' }, DEFAULT_TYPES).stories[0].items
  assert.equal(whole.length, 1)
  assert.ok((whole[0] as { prose: string }).prose.includes('* * *'), 'nothing split')
  // Two heading levels: parts and chapters.
  assert.deepEqual(shape(planTree([doc('B', '# Part One\n## Arrival\nA.\n## Storm\nB.\n# Part Two\n## Home\nC.')], { split: 'breaks', as: 'story' }, DEFAULT_TYPES).stories[0].items),
    ['[part] Part One', '[chapter] Arrival', 'A', '[chapter] Storm', 'B', '[part] Part Two', '[chapter] Home', 'C'])
  assert.equal(openingWords('> *One* two^[n] three four five six seven'), 'One two three four five six…')
})

test('several documents: chapters of one story, a story each, or chapters added to an existing story', () => {
  const files = [doc('Low Tide 01', 'One.'), doc('Low Tide 02', 'Two.\n* * *\nThree.'), { kind: 'file', title: 'Map', file: { path: '/m.pdf', name: 'm.pdf', mime: 'application/pdf', size: 4 } } as ImportNode]
  assert.equal(commonTitle(files), 'Low Tide')
  const one = planTree(files, { split: 'breaks', as: 'story', title: 'Low Tide' }, DEFAULT_TYPES)
  assert.deepEqual(shape(one.stories[0].items), ['[chapter] Low Tide 01', 'One', '[chapter] Low Tide 02', 'Two', 'Three'])
  assert.deepEqual(one.research.map(r => [r.title, r.type]), [['Map', 'pdf']])
  const each = planTree(files, { split: 'breaks', as: 'stories' }, DEFAULT_TYPES)
  assert.deepEqual(each.stories.map(x => [x.title, shape(x.items)]), [['Low Tide 01', ['One']], ['Low Tide 02', ['Two', 'Three']]])
  const into = planTree([doc('Epilogue', 'Last.')], { split: 'breaks', as: 'story_1' }, DEFAULT_TYPES)
  assert.deepEqual([into.stories[0].into, shape(into.stories[0].items)], ['story_1', ['[chapter] Epilogue', 'Last']])
})

const scriv: ImportNode[] = [
  { kind: 'folder', title: 'Novel', children: [
    { kind: 'folder', title: 'Chapter 1', synopsis: 'Arrivals.', children: [
      { kind: 'text', title: 'Arrival', text: 'The tide was *out*.', synopsis: 'Ines arrives.', notes: 'Check the tide tables.', label: 'Concept', status: 'First Draft', keywords: ['harbour'] },
      { kind: 'text', title: 'Departure', text: '', exclude: true, status: 'Revised Draft' },
      { kind: 'text', title: 'Gulls', text: 'Gulls.', label: 'Gulls', status: 'Needs work' },
    ] },
  ] },
  { kind: 'folder', title: 'Research', research: true, children: [
    { kind: 'folder', title: 'Places', research: true, children: [{ kind: 'file', title: 'Map', research: true, file: { path: '/p/map.pdf', name: 'Map.pdf', mime: 'application/pdf', size: 8 } }] },
    { kind: 'text', title: 'Notes on boats', text: 'Boats need licences.', research: true },
  ] },
]

test('Scrivener: the draft is the story, binder items are scenes with their card, notes, label, status and keywords', () => {
  const p = planTree(scriv, { split: 'breaks', as: 'story' }, DEFAULT_TYPES)
  assert.equal(p.stories.length, 1)
  assert.equal(p.stories[0].title, 'Novel')
  const [ch, a, d] = p.stories[0].items
  assert.deepEqual([ch.kind, ch.title, (ch as { synopsis: string }).synopsis], ['chapter', 'Chapter 1', 'Arrivals.'])
  assert.deepEqual(a, { kind: 'scene', title: 'Arrival', prose: 'The tide was *out*.', card: 'Ines arrives.', notes: 'Check the tide tables.', label: 'Concept', status: 'First Draft', tags: ['harbour'], exclude: undefined })
  assert.deepEqual([d.title, (d as { prose: string }).prose, (d as { exclude?: boolean }).exclude], ['Departure', '', true], 'an empty binder item keeps its place')
  assert.deepEqual(p.research.map(r => [r.title, r.type, r.folder]), [['Map', 'pdf', 'Places'], ['Notes on boats', 'note', undefined]])
  assert.deepEqual(countPlan(p), { stories: 1, parts: 0, chapters: 1, scenes: 3, words: 5, files: 1, notes: 1, sheets: 0 })

  // Labels take free colours (or the one already named so); statuses map onto Canon's, or are added.
  const m = mapMeta(p.labels, p.statuses, { labels: { red: 'Gulls' } })
  assert.deepEqual(m.labelOf, { Concept: 'orange', Gulls: 'red' })
  assert.deepEqual(m.statusOf, { 'First Draft': 'draft', 'Revised Draft': 'revised', 'Needs work': 'needs-work' })
  assert.equal(m.statuses?.at(-1)?.label, 'Needs work')
  assert.equal(mapMeta([], ['Done'], {}).statuses, undefined, 'nothing to add')
})

test('records: one story with sections and scenes in flow order, notes, research with stored files, project changes', () => {
  const s = { loaded: true, save: 'saved', recs: {
    project: { id: 'project', kind: 'project', title: 'P', logline: '', thesis: '', background: '', types: DEFAULT_TYPES },
    story_a: { id: 'story_a', kind: 'story', title: 'A', order: 1, form: 'prose', premise: '', beats: [] },
  } } as unknown as State
  const { recs, patch, open } = planRecords(planTree(scriv, { split: 'breaks', as: 'story' }, DEFAULT_TYPES), s, { '/p/map.pdf': 'map-1a2b3c4d.pdf' })
  const story = recs.find(r => r.kind === 'story')!
  assert.equal(story.data.order, 2)
  assert.equal(open, 'story/' + story.id)
  const flow = recs.filter(r => r.kind === 'section' || r.kind === 'scene').map(r => [r.data.order, r.data.title])
  assert.deepEqual(flow, [[1, 'Chapter 1'], [2, 'Arrival'], [3, 'Departure'], [4, 'Gulls']])
  const arrival = recs.find(r => r.data.title === 'Arrival')!.data
  assert.deepEqual([arrival.label, arrival.status, arrival.tags, arrival.pinned, arrival.card], ['red', 'draft', ['harbour'], true, 'Ines arrives.'])
  assert.equal(recs.find(r => r.data.title === 'Departure')!.data.status, 'revised')
  assert.equal(recs.find(r => r.kind === 'note')!.data.text, 'Check the tide tables.')
  assert.deepEqual(recs.filter(r => r.kind === 'research').map(r => [r.data.title, r.data.file]), [['Map', 'map-1a2b3c4d.pdf'], ['Notes on boats', undefined]])
  assert.deepEqual(patch.labels, { red: 'Concept', orange: 'Gulls' })
  assert.ok((patch.statuses as { id: string }[]).some(x => x.id === 'needs-work'))
})
