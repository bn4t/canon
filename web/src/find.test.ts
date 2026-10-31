import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findMatches, replaceAll, replaceOne } from './find.ts'

test('findMatches: case, whole word, regex', () => {
  const t = 'The cat sat. Cat category, cat.'
  assert.equal(findMatches(t, 'cat').length, 4)
  assert.equal(findMatches(t, 'cat', { matchCase: true }).length, 3)
  assert.equal(findMatches(t, 'cat', { wholeWord: true }).length, 3)
  assert.deepEqual(findMatches(t, 's.t', {}).length, 0, 'dots are literal without regex')
  assert.equal(findMatches(t, 's.t', { regex: true })[0].text, 'sat')
  assert.throws(() => findMatches(t, '(', { regex: true }))
  assert.deepEqual(findMatches('aaa', 'x*', { regex: true }), [], 'zero-length matches skipped')
})

test('replaceAll and replaceOne', () => {
  assert.equal(replaceAll('a $ b $', '$', '$&!'), 'a $&! b $&!', 'literal mode ignores $ patterns')
  assert.equal(replaceAll('Ann met ann', 'ann', 'Bo', { wholeWord: true }), 'Bo met Bo')
  assert.equal(replaceAll('x1 y2', '(\\w)(\\d)', '$2$1', { regex: true }), '1x 2y')
  const t = 'one two one'
  const m = findMatches(t, 'one')[1]
  assert.equal(replaceOne(t, m, 'one', '1'), 'one two 1')
})
