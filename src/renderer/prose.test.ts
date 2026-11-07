import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProse, parseInline, proseMarks, plainText, toggleWrap, isBreak } from './prose.ts'

const styled = (text: string, cls: string) => proseMarks(text).filter(m => m.cls === cls).map(m => text.slice(m.a, m.b))

test('italic, bold and bold italic', () => {
  assert.deepEqual(parseInline('a *b* c'), [{ text: 'a ' }, { text: 'b', em: true }, { text: ' c' }])
  assert.deepEqual(parseInline('**b** _i_'), [{ text: 'b', strong: true }, { text: ' ' }, { text: 'i', em: true }])
  assert.deepEqual(parseInline('***both***'), [{ text: 'both', em: true, strong: true }])
  assert.deepEqual(parseInline('*a **b** c*'), [{ text: 'a ', em: true }, { text: 'b', em: true, strong: true }, { text: ' c', em: true }])
})

test('things that are not emphasis', () => {
  assert.deepEqual(parseInline('5 * 3 * 2'), [{ text: '5 * 3 * 2' }])
  assert.deepEqual(parseInline('snake_case_name'), [{ text: 'snake_case_name' }])
  assert.deepEqual(parseInline('an *unclosed asterisk'), [{ text: 'an *unclosed asterisk' }])
  assert.deepEqual(parseInline('a \\*literal\\* star'), [{ text: 'a *literal* star' }])
})

test('footnotes', () => {
  assert.deepEqual(parseInline('Merrow.^[A real *town*.] Then'), [{ text: 'Merrow.' }, { note: [{ text: 'A real ' }, { text: 'town', em: true }, { text: '.' }] }, { text: ' Then' }])
  assert.deepEqual(styled('x^[n]', 'md-mark'), ['^[', ']'])
})

test('blocks: paragraphs, quotes, headings, breaks', () => {
  const b = parseProse('One.\n\n> Quoted *line*.\n* * *\n# Letter\nTwo.')
  assert.deepEqual(b.map(x => x.type), ['p', 'quote', 'break', 'h1', 'p'])
  assert.deepEqual(b[1].runs, [{ text: 'Quoted ' }, { text: 'line', em: true }, { text: '.' }])
  for (const l of ['***', '* * *', '#', '⁂', '---']) assert.ok(isBreak(l), l)
  for (const l of ['# Title', '*a*', '--', '-- said']) assert.ok(!isBreak(l), l)
})

test('editor marks keep the markers as their own ranges', () => {
  const t = 'He said *no* and **left**.'
  assert.deepEqual(styled(t, 'md-em'), ['no'])
  assert.deepEqual(styled(t, 'md-strong'), ['left'])
  assert.deepEqual(styled(t, 'md-mark'), ['*', '*', '**', '**'])
  const q = 'a\n> quote'
  assert.deepEqual(styled(q, 'md-quote'), ['quote'])
})

test('plain text drops markup and notes', () => {
  assert.equal(plainText('*A* b.^[note]\n***\nC **d**.'), 'A b.\n\n* * *\n\nC d.')
})

test('toggleWrap adds and removes markers around the selection', () => {
  const t = 'a big dog'
  const on = toggleWrap(t, 2, 5, '*')
  assert.deepEqual(on, { text: 'a *big* dog', a: 3, b: 6 })
  assert.deepEqual(toggleWrap(on.text, on.a, on.b, '*'), { text: t, a: 2, b: 5 })
  assert.equal(toggleWrap('a big dog', 1, 6, '**').text, 'a **big** dog') // spaces stay outside the markers
})
