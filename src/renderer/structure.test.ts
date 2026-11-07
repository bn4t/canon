import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arrange, flowOf, treeOf, contentsOf, scenesIn, chapterOf, partOf, sectionNumber, statusesOf, statusOf, matchScenes, writingDaysLeft, dailyGoal, today, STATUSES, type State } from './store.ts'

const sc = (id: string, order: number, more = {}) => [id, { id, kind: 'scene', story: 'st1', order, title: id, prose: '', card: '', wants: '', mustLand: [], beat: '', cast: [], links: {}, pinned: false, snapshots: [], ...more }]
const sec = (id: string, order: number, type: 'part' | 'chapter') => [id, { id, kind: 'section', story: 'st1', order, type, title: id, synopsis: '' }]
const project = (more = {}) => ['project', { id: 'project', kind: 'project', title: 'P', logline: '', thesis: '', background: '', types: {}, ...more }]
const state = (rows: unknown[][]): State => ({ loaded: true, save: 'saved', recs: Object.fromEntries([project(), ['st1', { id: 'st1', kind: 'story', title: 'S', order: 1, form: 'prose', premise: '', beats: [] }], ...rows]) })

/** a · PART P: b · CH C1: c d · CH C2 · PART Q: CH C3: e */
const book = () => state([sc('a', 1), sec('P', 2, 'part'), sc('b', 3), sec('C1', 4, 'chapter'), sc('c', 5), sc('d', 6), sec('C2', 7, 'chapter'), sec('Q', 8, 'part'), sec('C3', 9, 'chapter'), sc('e', 10)])
const ids = (xs: { id: string }[]) => xs.map(x => x.id)
/** What renumbering a story's flow does: the given order becomes 1..n. */
const renumber = (s: State, order: string[]): State => ({ ...s, recs: { ...s.recs, ...Object.fromEntries(order.map((id, i) => [id, { ...s.recs[id], order: i + 1 }])) } })

test('arrange takes items out and puts them back before a target, in their order', () => {
  const xs = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }))
  assert.deepEqual(ids(arrange(xs, [{ id: 'd' }], 'b')), ['a', 'd', 'b', 'c', 'e'])
  assert.deepEqual(ids(arrange(xs, [{ id: 'a' }, { id: 'b' }])), ['c', 'd', 'e', 'a', 'b'])
  assert.deepEqual(ids(arrange(xs, [{ id: 'c' }, { id: 'a' }], 'e')), ['b', 'd', 'c', 'a', 'e'])
  assert.deepEqual(ids(arrange(xs, [{ id: 'b' }], 'gone')), ['a', 'c', 'd', 'e', 'b'], 'an unknown target means the end')
})

test('the flow sorts a heading before a scene with the same order', () => {
  const s = state([sc('x', 2), sec('H', 2, 'chapter'), sc('y', 1)])
  assert.deepEqual(ids(flowOf(s, 'st1')), ['y', 'H', 'x'])
})

test('treeOf: scenes before any heading, a part’s own scenes, chapters inside parts', () => {
  const t = treeOf(book(), 'st1')
  assert.deepEqual(ids(t.scenes), ['a'])
  assert.deepEqual(t.kids.map(k => k.sec!.id), ['P', 'Q'])
  const [P, Q] = t.kids
  assert.deepEqual(ids(P.scenes), ['b'])
  assert.deepEqual(P.kids.map(k => [k.sec!.id, ids(k.scenes)]), [['C1', ['c', 'd']], ['C2', []]])
  assert.deepEqual(ids(Q.scenes), [])
  assert.deepEqual(Q.kids.map(k => [k.sec!.id, ids(k.scenes)]), [['C3', ['e']]])
})

test('a heading contains everything up to the next heading of its level or higher', () => {
  const s = book()
  assert.deepEqual(ids(contentsOf(s, 'P')), ['b', 'C1', 'c', 'd', 'C2'])
  assert.deepEqual(ids(contentsOf(s, 'C1')), ['c', 'd'])
  assert.deepEqual(ids(contentsOf(s, 'C2')), [])
  assert.deepEqual(ids(scenesIn(s, 'Q')), ['e'])
  assert.equal(chapterOf(s, 'c')?.id, 'C1')
  assert.equal(chapterOf(s, 'b'), undefined, 'a part’s own scenes are in no chapter')
  assert.equal(partOf(s, 'b')?.id, 'P')
  assert.equal(chapterOf(s, 'a'), undefined)
  assert.equal(partOf(s, 'e')?.id, 'Q')
  assert.equal(sectionNumber(s, 'C3'), 3, 'chapters count across parts')
})

test('moving a chapter with its scenes into another part', () => {
  const s = book(), flow = flowOf(s, 'st1')
  const moving = flow.filter(x => ['C1', ...ids(contentsOf(s, 'C1'))].includes(x.id))
  const t = treeOf(renumber(s, ids(arrange(flow, moving, 'C3'))), 'st1')
  assert.deepEqual(t.kids[0].kids.map(k => k.sec!.id), ['C2'])
  assert.deepEqual(t.kids[1].kids.map(k => [k.sec!.id, ids(k.scenes)]), [['C1', ['c', 'd']], ['C3', ['e']]])
})

test('custom statuses: defaults until set, unknown ids fall back to the first', () => {
  assert.deepEqual(statusesOf(book()), STATUSES)
  const custom = [{ id: 'idea', label: 'Idea', color: 'var(--line2)' }, { id: 'done', label: 'Done', color: 'var(--l-green)' }]
  const s: State = { ...book(), recs: { ...book().recs, project: { ...book().recs.project, statuses: custom } as State['recs'][string], a: { ...book().recs.a, status: 'done' } as State['recs'][string] } }
  assert.equal(statusOf(s, 'done').label, 'Done')
  assert.equal(statusOf(s, 'draft').id, 'idea', 'a status that no longer exists reads as the first')
  assert.equal(statusOf(s).id, 'idea', 'no status reads as the first')
  assert.deepEqual(ids(matchScenes(s, { status: 'idea' })), ['b', 'c', 'd', 'e'])
})

test('writing days left counts both ends and only the chosen weekdays', () => {
  // 2 Nov 2026 is a Monday; 8 Nov a Sunday.
  assert.equal(writingDaysLeft('2026-11-08', undefined, '2026-11-02'), 7)
  assert.equal(writingDaysLeft('2026-11-08', [1, 2, 3, 4, 5], '2026-11-02'), 5)
  assert.equal(writingDaysLeft('2026-11-02', undefined, '2026-11-02'), 1)
  assert.equal(writingDaysLeft('2026-11-01', undefined, '2026-11-02'), 0)
  assert.equal(writingDaysLeft('2026-11-30', [6], '2026-11-02'), 4, 'the Saturdays of November after the 2nd')
})

test('the daily goal from the deadline spreads what is left over the writing days, from the start of today', () => {
  const d = new Date(); d.setDate(d.getDate() + 9)
  const deadline = d.toLocaleDateString('sv')
  const prose = 'word '.repeat(2000)
  const mk = (p: object) => state([project({ target: 10000, deadline, sessionTarget: 500, ...p }), sc('a', 1, { prose }), ['day_' + today(), { id: 'day_' + today(), kind: 'day', date: today(), start: 1500, words: 2000 }]])
  // 10 days including today; 10,000 − (2,000 − 500 written today) = 8,500 left at the start of today.
  assert.equal(dailyGoal(mk({ goalFromDeadline: true })), 850)
  assert.equal(dailyGoal(mk({})), 500, 'off: the fixed goal')
  assert.equal(dailyGoal(mk({ goalFromDeadline: true, deadline: '2000-01-01' })), 500, 'a passed deadline falls back to the fixed goal')
  assert.equal(dailyGoal(mk({ goalFromDeadline: true, target: 1000 })), 0, 'target already reached')
})
