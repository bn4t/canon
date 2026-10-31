import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lint } from './lint.ts'

test('em dash rules', () => {
  assert.equal(lint('She waited — the train was late.').length, 1, 'appositive dash in narration')
  assert.equal(lint('"I just—" He stopped.').length, 0, 'interrupted speech')
  assert.equal(lint('"I—I don\'t know," she said.').length, 0, 'stutter inside dialogue')
  assert.equal(lint('Prism — xBD Creator').length, 0, 'record field separator')
  assert.equal(lint('Analyst — A. Volkov, Compliance').length, 0, 'record field separator with period inside')
  assert.equal(lint('He said nothing and left the room, slow as anything—').length, 0, 'cut off at line end')
})

test('banned phrases', () => {
  assert.equal(lint('Laughing, forgetting what it cost.', ['forgetting what it cost'])[0].msg, 'Banned phrase: “forgetting what it cost”')
})
