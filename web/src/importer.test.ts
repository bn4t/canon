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
