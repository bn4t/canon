import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffWords, diffText } from './diff.ts'

const join = (ps: { t: string; s: string }[], keep: string) => ps.filter(p => p.t === 'eq' || p.t === keep).map(p => p.s).join('')

test('diffWords marks only the changed words and round-trips', () => {
  const a = 'He had said it twice already.', b = 'He had said it three times already.'
  const d = diffWords(a, b)
  assert.equal(join(d, 'del'), a)
  assert.equal(join(d, 'ins'), b)
  assert.deepEqual(d.filter(p => p.t !== 'eq').map(p => p.s), ['twice', 'three times'])
})

test('diffText handles added paragraphs and long texts', () => {
  const a = 'One.\nTwo.\nThree.', b = 'One.\nTwo, changed.\nNew.\nThree.'
  const d = diffText(a, b)
  assert.equal(join(d, 'del'), a)
  assert.equal(join(d, 'ins'), b)
  const long = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ')
  const d2 = diffText(long, long + ' end')
  assert.equal(join(d2, 'ins'), long + ' end')
})
