import { useSyncExternalStore } from 'react'
import { DEFAULT_TYPES, type EntityType, type TypeDef } from './schema.ts'

// ---------------- the primitives ----------------
// World: entity, fact (an event is a fact with a time), question. Manuscript: story, section (part or chapter), scene.
// Craft: guide. Feedback: note (about the text), question (about the world and story). Research: files, pages and notes.
// Supporting: project (singleton, id "project"), chat, day (writing history, outside undo).

/** A scene's status id. The project can rename, recolour, reorder and add statuses; these four are the defaults. */
export type SceneStatus = string
export interface StatusDef { id: SceneStatus; label: string; color: string }
export const STATUSES: StatusDef[] = [
  { id: 'todo', label: 'To do', color: 'var(--line2)' }, { id: 'draft', label: 'First draft', color: 'var(--l-yellow)' },
  { id: 'revised', label: 'Revised', color: 'var(--l-blue)' }, { id: 'final', label: 'Final', color: 'var(--l-green)' },
]
export const LABELS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const

/** How a scene touches a fact: shown on the page, or felt (the effect without the cause). */
export type Link = 'on' | 'felt'
export type KState = '' | 'knows' | 'almost' | 'believes' | 'never'
/** What one entity knows of a fact. `from`: the story or scene where they learn it. */
export interface KCell { state: KState; note?: string; from?: string }
export interface Snapshot { text: string; at: string; name?: string }
export type FieldKind = 'text' | 'check' | 'list' | 'date'
export interface MetaField { key: string; label: string; kind: FieldKind; options?: string[] }
export interface Filter { q?: string; story?: string; label?: string; status?: string; tag?: string; cast?: string; fact?: string; exclude?: boolean }
/** A collection is smart (a saved filter) unless it has `ids`: then it is a hand-picked, hand-ordered list of scenes. */
export interface Collection { id: string; name: string; filter: Filter; ids?: string[] }
/** Front and back matter, and the metadata ebooks and title pages need. Every field is optional. */
export interface BookInfo {
  subtitle?: string; series?: string; seriesIndex?: number; publisher?: string; isbn?: string; language?: string; description?: string
  copyright?: string; dedication?: string; epigraph?: string; acknowledgements?: string; about?: string
  /** A research item (an image) used as the ebook cover. */
  cover?: string
}
export type ResearchType = 'pdf' | 'image' | 'web' | 'note' | 'audio' | 'video' | 'file'
export interface Message { role: 'user' | 'assistant'; text: string; proposals?: Proposal[] }
/** A change the AI suggests; nothing happens until the author applies it. */
export interface Proposal { op: 'update' | 'create' | 'edit'; id?: string; kind?: Kind; set?: Record<string, unknown>; data?: Record<string, unknown>; why?: string; newId?: string
  /** op "edit": replace one exact passage of a scene's prose. */
  find?: string; replace?: string }

export type QKind = 'question' | 'hole' | 'contradiction'
export const QKINDS: { id: QKind; label: string; many: string }[] = [
  { id: 'question', label: 'Open question', many: 'Open questions' }, { id: 'hole', label: 'Plot hole', many: 'Plot holes' }, { id: 'contradiction', label: 'Contradiction', many: 'Contradictions' },
]
export type GuideKind = 'style' | 'rule' | 'banned' | 'check'
export const GUIDE_KINDS: { id: GuideKind; label: string; hint: string }[] = [
  { id: 'style', label: 'Style', hint: 'How to write: tone, voice, conventions. Sent with every draft in its scope.' },
  { id: 'rule', label: 'Rule', hint: 'A short instruction drafts and checks must follow.' },
  { id: 'banned', label: 'Banned phrases', hint: 'One per line. Flagged in the text and kept out of drafts.' },
  { id: 'check', label: 'Check instructions', hint: 'Replaces the default instructions for Check continuity.' },
]
export type Severity = 'critical' | 'error' | 'warning' | 'note'

interface Data {
  project: { title: string; author?: string; logline: string; thesis: string; background: string
    types: Record<string, TypeDef>; labels?: Record<string, string>; sceneFields?: MetaField[]; collections?: Collection[]
    emDashCheck?: boolean; scratch?: string; target?: number; deadline?: string; sessionTarget?: number
    /** Work the daily goal out from the target and the deadline (see dailyGoal), counting only `writingDays` (0 = Sunday; all when unset). */
    goalFromDeadline?: boolean; writingDays?: number[]
    /** Custom scene statuses, in order; STATUSES when unset. */
    statuses?: StatusDef[]
    /** Records pinned to the sidebar (bookmarks): scenes, sections, entities, research. */
    pins?: string[]
    book?: BookInfo
    /** Export settings and saved profiles, owned by compile.ts. */
    exportPrefs?: Record<string, unknown> }
  entity: { type: EntityType; name: string; aliases: string[]; summary: string; fields: Record<string, string>; notes: string; relations: { to: string; label: string }[] }
  /** Something true. With `at` it is an event: it happens at that place in world order, caused by earlier events. */
  fact: { text: string; detail: string; at?: number; causes: string[]; knows: Record<string, KCell>
    /** An event's stable number (E3): given once when it gets a date, kept when events move. */
    n?: number }
  question: { type: QKind; text: string; about: string[]; options: { title: string; detail: string; proposal?: Proposal }[]; answer: string; by: 'you' | 'ai' | 'check'; dismissed?: boolean; at: string }
  story: { title: string; order: number; pov?: string; form: 'prose' | 'documents'; premise: string; beats: string[]; target?: number }
  /** A part or chapter heading inside a story. It shares the scenes' `order` space: it starts before the scenes that follow it,
   * and runs until the next section of the same or a higher level (a part holds chapters; a chapter holds scenes). */
  section: { story: string; order: number; type: 'part' | 'chapter'; title: string; synopsis: string; exclude?: boolean }
  scene: { story: string; order: number; title: string; card: string; wants: string; mustLand: string[]; beat: string; cast: string[]; links: Record<string, Link>
    prose: string; pinned: boolean; builtHash?: string; snapshots: Snapshot[]
    status?: SceneStatus; label?: string; tags?: string[]; target?: number; exclude?: boolean; meta?: Record<string, string> }
  /** `scope`: "project", "story:<id>", "type:<id>", "entity:<id>" or "form:documents". */
  guide: { use: GuideKind; scope: string; title: string; text: string }
  note: { scene: string; quote?: string; text: string; by: 'you' | 'ai' | 'check'; topic?: string; severity?: Severity; fix?: string; done?: boolean; at: string }
  chat: { mode: 'assistant' | 'interview'; entity?: string; asOf?: string; title: string; messages: Message[]; at: string }
  /** Writing history: total words at the first and latest save of a day (outside undo). */
  day: { date: string; start: number; words: number }
  /** Reference material. `file`: the stored file's name in the project's files folder (served at /api/files?name=…).
   * `text`: your notes (a note's whole body). `clip`: a web page's readable text, kept so it can be read and searched offline.
   * `about`: linked entities, scenes, sections, stories. */
  research: { title: string; type: ResearchType; file?: string; mime?: string; size?: number; url?: string; text: string; clip?: string; about: string[]; folder?: string; at: string }
}
export type Kind = keyof Data
export type R<K extends Kind> = Data[K] & { id: string; kind: K }
export type Project = R<'project'>; export type Entity = R<'entity'>; export type Fact = R<'fact'>; export type Question = R<'question'>
export type Story = R<'story'>; export type Scene = R<'scene'>; export type Guide = R<'guide'>; export type Note = R<'note'>; export type Chat = R<'chat'>
export type Section = R<'section'>; export type Research = R<'research'>
type AnyRec = { [K in Kind]: R<K> }[Kind]

export interface State {
  loaded: boolean
  error?: string
  recs: Record<string, AnyRec>
  save: 'saved' | 'saving' | 'error'
  toast?: { text: string; undo?: boolean; action?: { label: string; run: () => void }; at: number }
  /** Records left by an older version of Canon (hidden; the author can remove them). */
  legacy?: { id: string; kind: string; name?: string }[]
}

let state: State = { loaded: false, recs: {}, save: 'saved' }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())
export const getState = () => state
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; emit() }
export function useCanon() {
  return useSyncExternalStore(l => (listeners.add(l), () => listeners.delete(l)), () => state)
}

// ---------------- selectors ----------------

const byOrder = (a: { order: number }, b: { order: number }) => a.order - b.order
export function list<K extends Kind>(s: State, kind: K): R<K>[] {
  return Object.values(s.recs).filter(r => r.kind === kind) as unknown as R<K>[]
}
export function get<K extends Kind>(s: State, id: string | undefined, kind?: K): R<K> | undefined {
  const r = id ? s.recs[id] : undefined
  return r && (!kind || r.kind === kind) ? (r as unknown as R<K>) : undefined
}
export const emptyProject = (types: Record<string, TypeDef> = DEFAULT_TYPES): Data['project'] => ({ title: 'Untitled project', logline: '', thesis: '', background: '', types })
export const project = (s: State): Project => get(s, 'project', 'project') || { id: 'project', kind: 'project', ...emptyProject() }
export const stories = (s: State) => list(s, 'story').sort(byOrder)
export const scenesOf = (s: State, story: string) => list(s, 'scene').filter(x => x.story === story).sort(byOrder)
/** Every scene in reading order. */
export const allScenes = (s: State) => stories(s).flatMap(st => scenesOf(s, st.id))

// ---------------- manuscript structure: parts and chapters ----------------
// A story's scenes and sections share one `order` space and read as one flow. A section starts before the items after it.
// Rank: a part (1) contains chapters (2); a chapter contains scenes. Scenes before the first section belong to no chapter.

export type FlowItem = Section | Scene
const rank = (x: FlowItem) => (x.kind === 'section' ? (x.type === 'part' ? 1 : 2) : 3)
export const sectionsOf = (s: State, story: string) => list(s, 'section').filter(x => x.story === story).sort(byOrder)
/** A story's sections and scenes in reading order (a section sorts before a scene with the same order). */
export const flowOf = (s: State, story: string): FlowItem[] =>
  [...sectionsOf(s, story), ...scenesOf(s, story)].sort((a, b) => a.order - b.order || rank(a) - rank(b))
/** Everything a section contains, in order: up to the next section of the same or a higher level. */
export function contentsOf(s: State, sectionId: string): FlowItem[] {
  const sec = get(s, sectionId, 'section')
  if (!sec) return []
  const flow = flowOf(s, sec.story), i = flow.findIndex(x => x.id === sec.id), out: FlowItem[] = []
  for (const x of flow.slice(i + 1)) { if (x.kind === 'section' && rank(x) <= rank(sec)) break; out.push(x) }
  return out
}
export const scenesIn = (s: State, sectionId: string) => contentsOf(s, sectionId).filter((x): x is Scene => x.kind === 'scene')
/** The section of a type that a scene (or section) falls under, if any. */
export function sectionAbove(s: State, id: string, type: 'part' | 'chapter'): Section | undefined {
  const r = s.recs[id] as FlowItem | undefined
  if (!r || (r.kind !== 'scene' && r.kind !== 'section')) return
  const flow = flowOf(s, r.story), i = flow.findIndex(x => x.id === id)
  for (let j = i - 1; j >= 0; j--) {
    const x = flow[j]
    if (x.kind !== 'section') continue
    if (x.type === type) return x
    if (type === 'chapter' && x.type === 'part') return // a part boundary ends the search for a chapter
  }
}
export const chapterOf = (s: State, id: string) => sectionAbove(s, id, 'chapter')
export const partOf = (s: State, id: string) => sectionAbove(s, id, 'part')
/** A chapter's number in its story, counting every chapter (across parts) from 1; parts count separately. */
export const sectionNumber = (s: State, id: string) => { const sec = get(s, id, 'section'); return sec ? sectionsOf(s, sec.story).filter(x => x.type === sec.type).findIndex(x => x.id === id) + 1 : 0 }
/** The flow as a tree, for the sidebar, the outline and export. `scenes`: scenes directly under this node, before its first child section. */
export interface TreeNode { sec?: Section; scenes: Scene[]; kids: TreeNode[] }
export function treeOf(s: State, story: string): TreeNode {
  const root: TreeNode = { scenes: [], kids: [] }
  let part: TreeNode | undefined, chap: TreeNode | undefined
  for (const x of flowOf(s, story)) {
    if (x.kind === 'section' && x.type === 'part') { part = { sec: x, scenes: [], kids: [] }; chap = undefined; root.kids.push(part) }
    else if (x.kind === 'section') { chap = { sec: x, scenes: [], kids: [] }; (part || root).kids.push(chap) }
    else (chap || part || root).scenes.push(x)
  }
  return root
}

/** Pure: `flow` with `moving` taken out and put back, in their given order, just before `beforeId` (or at the end). */
export function arrange<T extends { id: string }>(flow: T[], moving: T[], beforeId?: string): T[] {
  const ids = new Set(moving.map(x => x.id))
  const out = flow.filter(x => !ids.has(x.id))
  const at = beforeId ? out.findIndex(x => x.id === beforeId) : -1
  out.splice(at < 0 ? out.length : at, 0, ...moving)
  return out
}

/** Custom statuses, or the defaults. */
export const statusesOf = (s: State): StatusDef[] => project(s).statuses?.length ? project(s).statuses! : STATUSES
export const statusOf = (s: State, id?: string): StatusDef => { const all = statusesOf(s); return all.find(x => x.id === (id || 'todo')) || all[0] || STATUSES[0] }
/** Research items, newest first; `about` narrows to items linked to a record. */
export const researchOf = (s: State, about?: string) => list(s, 'research').filter(r => !about || r.about.includes(about)).sort((a, b) => b.at.localeCompare(a.at))
/** Facts with a time, in world order. */
export const events = (s: State) => list(s, 'fact').filter(f => f.at !== undefined).sort((a, b) => a.at! - b.at!)
/** Facts without a time: secrets, states of the world. */
export const plainFacts = (s: State) => list(s, 'fact').filter(f => f.at === undefined).sort((a, b) => a.text.localeCompare(b.text))
export const eventCode = (s: State, id: string) => { const f = get(s, id, 'fact'); return !f || f.at === undefined ? '' : 'E' + (f.n ?? events(s).indexOf(f) + 1) }
const nextN = (recs: Record<string, AnyRec>) => Object.values(recs).reduce((m, r) => (r.kind === 'fact' && r.n ? Math.max(m, r.n) : m), 0) + 1
export const typesOf = (s: State): Record<string, TypeDef> => project(s).types || DEFAULT_TYPES
export const typeIds = (s: State) => { const ids = Object.keys(typesOf(s)); for (const e of list(s, 'entity')) if (!ids.includes(e.type)) ids.push(e.type); return ids }
export const typeDef = (s: State, id: string): TypeDef => typesOf(s)[id] || { label: id, one: id, fields: [] }
export const entities = (s: State, type?: EntityType) => list(s, 'entity').filter(e => !type || e.type === type).sort((a, b) => a.name.localeCompare(b.name))
/** A display name for any record. */
export function nameOf(s: State, id?: string): string {
  const r = id ? s.recs[id] : undefined
  if (!r) return ''
  if (r.kind === 'entity') return r.name
  if (r.kind === 'story' || r.kind === 'scene' || r.kind === 'research') return r.title
  if (r.kind === 'section') return r.title || (r.type === 'part' ? 'Untitled part' : 'Untitled chapter')
  if (r.kind === 'fact') return (r.at !== undefined ? eventCode(s, r.id) + ' ' : '') + r.text
  if (r.kind === 'question') return r.text
  if (r.kind === 'guide') return r.title
  return ''
}
export const storyLabel = (s: State, id: string) => { const st = get(s, id, 'story'); if (!st) return '?'; const i = stories(s).filter(x => x.form === 'prose').indexOf(st); return st.form === 'documents' ? st.title.split(/[\s:]/)[0] : `S${i + 1}` }
export const sceneRef = (s: State, sc: Scene) => `${storyLabel(s, sc.story)} · ${scenesOf(s, sc.story).findIndex(x => x.id === sc.id) + 1}`
/** Reading-order position of a story or scene id, for "as of" comparisons. Stories sort before their scenes. */
export function position(s: State, id?: string): number {
  if (!id) return -1
  const st = stories(s)
  const i = st.findIndex(x => x.id === id)
  if (i >= 0) return i * 10000
  const sc = get(s, id, 'scene')
  if (!sc) return -1
  return st.findIndex(x => x.id === sc.story) * 10000 + 1 + scenesOf(s, sc.story).findIndex(x => x.id === sc.id)
}
/** The first scene, in reading order, that shows a fact on the page: where the reader learns it. */
export const readerLearns = (s: State, factId: string) => allScenes(s).find(sc => sc.links[factId] === 'on')
/** Entities that have any knowledge cell, plus story POVs. */
export const knowers = (s: State) => {
  const ids = new Set<string>(stories(s).map(x => x.pov).filter(Boolean) as string[])
  for (const f of list(s, 'fact')) for (const [k, c] of Object.entries(f.knows)) if (c.state || c.note) ids.add(k)
  return entities(s).filter(e => ids.has(e.id))
}
export const guidesFor = (s: State, scope: string, kind?: GuideKind) => list(s, 'guide').filter(g => g.scope === scope && (!kind || g.use === kind))
export const bannedPhrases = (s: State) => list(s, 'guide').filter(g => g.use === 'banned').flatMap(g => g.text.split('\n').map(x => x.trim()).filter(Boolean))
export const notesFor = (s: State, sceneId: string) => list(s, 'note').filter(n => n.scene === sceneId).sort((a, b) => Number(!!a.done) - Number(!!b.done) || b.at.localeCompare(a.at))
export const openQuestions = (s: State) => list(s, 'question').filter(q => !q.answer && !q.dismissed)
export const questionsAbout = (s: State, id: string) => list(s, 'question').filter(q => q.about.includes(id))

/** Scenes matching a collection filter. */
export function matchScenes(s: State, f: Filter) {
  const q = f.q?.toLowerCase().trim()
  return allScenes(s).filter(sc => (!f.story || sc.story === f.story) && (!f.label || sc.label === f.label) && (!f.status || statusOf(s, sc.status).id === f.status)
    && (!f.tag || (sc.tags || []).some(t => t.toLowerCase() === f.tag!.toLowerCase())) && (!f.cast || sc.cast.includes(f.cast)) && (!f.fact || !!sc.links[f.fact])
    && (!f.exclude || !!sc.exclude) && (!q || (sc.title + '\n' + sc.card + '\n' + sc.prose).toLowerCase().includes(q)))
}

// ---------------- mutations ----------------

export const uid = (prefix: string) => prefix + '_' + Math.random().toString(36).slice(2, 10)
const newGroup = () => uid('g')

type Change = { kind: Kind; data: Record<string, unknown> | null }
const queue: { group: string; label: string; changes: Map<string, Change> }[] = []
let group = newGroup(), groupLabel = '', lastEdit = 0, inTx = false
let timer: ReturnType<typeof setTimeout> | undefined
let flushing: Promise<void> = Promise.resolve()

function enqueue(id: string, ch: Change) {
  // Typing bursts coalesce into one undo step; a pause of 2s starts a new one.
  if (!inTx && Date.now() - lastEdit > 2000) { group = newGroup(); groupLabel = 'Edit' }
  lastEdit = Date.now()
  let q = queue[queue.length - 1]
  if (!q || q.group !== group) { q = { group, label: groupLabel, changes: new Map() }; queue.push(q) }
  q.changes.set(id, ch)
  clearTimeout(timer)
  timer = setTimeout(flush, 500)
  if (state.save !== 'saving') set({ save: 'saving' })
}

export function flush(): Promise<void> {
  clearTimeout(timer)
  flushing = flushing.then(async () => {
    while (queue.length) {
      const q = queue[0]
      const body = { group: q.group, label: q.label, changes: [...q.changes].map(([id, c]) => ({ id, kind: c.kind, data: c.data })) }
      try {
        const r = await fetch('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        if (!r.ok) throw new Error(await r.text())
        queue.shift()
      } catch (e) {
        set({ save: 'error', error: 'Saving failed: ' + String(e) })
        timer = setTimeout(flush, 3000) // keep retrying; nothing is dropped
        return
      }
    }
    set({ save: 'saved' })
  })
  return flushing
}

const strip = (r: AnyRec) => { const { id: _i, kind: _k, ...data } = r; return data }

/** Change one record in place. */
export function update<K extends Kind>(id: string, fn: (d: R<K>) => void) {
  const cur = state.recs[id]
  if (!cur) return
  const d = structuredClone(cur) as unknown as R<K>
  fn(d)
  if (d.kind === 'fact') { const f = d as unknown as Fact; if (f.at !== undefined && !f.n) f.n = nextN(state.recs) }
  state = { ...state, recs: { ...state.recs, [id]: d as unknown as AnyRec } }
  enqueue(id, { kind: d.kind, data: strip(d as unknown as AnyRec) })
  if (d.kind === 'scene') trackWords()
  emit()
}
export function create<K extends Kind>(kind: K, data: Data[K], id = uid(kind)): string {
  const r = { ...structuredClone(data), id, kind } as unknown as AnyRec
  if (r.kind === 'fact' && r.at !== undefined && !r.n) r.n = nextN(state.recs)
  state = { ...state, recs: { ...state.recs, [id]: r } }
  enqueue(id, { kind, data: strip(r) })
  emit()
  return id
}
export function remove(id: string) {
  const cur = state.recs[id]
  if (!cur) return
  const { [id]: _, ...rest } = state.recs
  state = { ...state, recs: rest }
  enqueue(id, { kind: cur.kind, data: null })
  emit()
}

/** Group several changes into one labelled undo step, and show an Undo toast. */
export function tx(label: string, fn: () => void, toast = true) {
  group = newGroup(); groupLabel = label; inTx = true
  try { fn() } finally { inTx = false; lastEdit = 0 }
  if (toast) showToast(label, true)
  flush()
}

export function showToast(text: string, undo = false, action?: { label: string; run: () => void }) { set({ toast: { text, undo, action, at: Date.now() } }) }
export function clearError() { set({ error: undefined }) }

/** Words, not markup: tokens with no letter or digit (a scene break "* * *", a quote's ">") don't count. */
export const words = (t: string) => { let n = 0; for (const w of t.match(/\S+/g) || []) if (/[\p{L}\p{N}]/u.test(w)) n++; return n }
export const totalWords = (s: State) => list(s, 'scene').reduce((n, sc) => n + words(sc.prose), 0)
export const today = () => new Date().toLocaleDateString('sv') // YYYY-MM-DD, local

/** Keep today's writing-history record current (its own group, so it never lands in an undo step). */
let dayTimer: ReturnType<typeof setTimeout> | undefined
function trackWords() {
  clearTimeout(dayTimer)
  dayTimer = setTimeout(() => {
    const id = 'day_' + today(), n = totalWords(state), cur = get(state, id, 'day')
    if (cur?.words === n) return
    // Today starts where the last writing day ended, so the first edit of the day counts too.
    const prev = list(state, 'day').filter(d => d.date < today()).sort((a, b) => b.date.localeCompare(a.date))[0]
    const data: Data['day'] = { date: today(), start: cur?.start ?? prev?.words ?? n, words: n }
    state = { ...state, recs: { ...state.recs, [id]: { ...data, id, kind: 'day' } } }
    queue.push({ group: newGroup(), label: 'Writing history', changes: new Map([[id, { kind: 'day', data }]]) })
    flush()
  }, 3000)
}
/** Words written today, from the day record (0 before the first save). */
export const sessionWords = (s: State) => { const d = get(s, 'day_' + today(), 'day'); return d ? d.words - d.start : 0 }

const localDate = (d: string) => { const [y, m, n] = d.split('-').map(Number); return new Date(y, m - 1, n) }
/** Writing days from `from` through `deadline`, both included, counting only the given weekdays (0 = Sunday). */
export function writingDaysLeft(deadline: string, days: number[] = [0, 1, 2, 3, 4, 5, 6], from = today()) {
  const end = localDate(deadline), d = localDate(from)
  let n = 0
  for (let i = 0; d <= end && i < 4000; i++, d.setDate(d.getDate() + 1)) if (days.includes(d.getDay())) n++
  return n
}
/** Today's goal in words. Worked out from the target and the deadline when the author chose that (from the words at the start of
 * today, so it doesn't shrink while they write); otherwise the fixed daily goal. Undefined: no goal. */
export function dailyGoal(s: State): number | undefined {
  const p = project(s)
  if (!p.goalFromDeadline || !p.target || !p.deadline || p.deadline < today()) return p.sessionTarget
  const left = Math.max(0, p.target - (totalWords(s) - Math.max(0, sessionWords(s))))
  const days = writingDaysLeft(p.deadline, p.writingDays?.length ? p.writingDays : undefined)
  return Math.ceil(left / Math.max(1, days))
}

export async function load() {
  try {
    const recs: { id: string; kind: Kind; data: Record<string, unknown>; updated: number }[] = await (await fetch('/api/records')).json()
    // Older versions stored other kinds and shapes; an entity is stale when a newer one has the same name (a second import).
    const newest: Record<string, number> = {}
    for (const r of recs) if (r.kind === 'entity') newest[String(r.data.name)] = Math.max(newest[String(r.data.name)] || 0, r.updated)
    const old = (r: typeof recs[number]) => !['project', 'entity', 'fact', 'question', 'story', 'section', 'scene', 'guide', 'note', 'chat', 'day', 'research'].includes(r.kind)
      || (r.kind === 'question' && !('type' in r.data)) || (r.kind === 'fact' && !('knows' in r.data)) || (r.kind === 'scene' && !('links' in r.data))
      || (r.kind === 'guide' && !('use' in r.data)) || (r.kind === 'entity' && r.updated < newest[String(r.data.name)])
    const m: Record<string, AnyRec> = {}
    const legacy: State['legacy'] = []
    for (const r of recs) if (old(r)) legacy.push({ id: r.id, kind: r.kind, name: r.kind === 'entity' ? String(r.data.name) : undefined }); else m[r.id] = { ...r.data, id: r.id, kind: r.kind } as unknown as AnyRec
    set({ loaded: true, recs: m, legacy })
    numberEvents()
  } catch (e) {
    set({ loaded: true, error: String(e) })
  }
}

/** Events from before stable numbering keep their current position as their number (a baseline write: not an undo step). */
function numberEvents() {
  let n = nextN(state.recs)
  const recs = { ...state.recs }
  const changes: { kind: Kind; id: string; data: Record<string, unknown> }[] = []
  for (const f of events(state)) if (!f.n) { const r = { ...f, n: n++ }; recs[f.id] = r; changes.push({ kind: 'fact', id: f.id, data: strip(r) }) }
  if (!changes.length) return
  state = { ...state, recs }
  emit()
  fetch('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group: newGroup(), label: 'Number events', baseline: true, changes }) })
}

/** Delete the hidden records of an older version (one undoable step); interviews follow their character by name. */
export function removeLegacy() {
  const names = Object.fromEntries((state.legacy || []).filter(r => r.name).map(r => [r.id, r.name!]))
  tx('Remove records from an older version', () => {
    for (const r of state.legacy || []) enqueue(r.id, { kind: r.kind as Kind, data: null })
    for (const c of list(state, 'chat')) if (c.entity && !state.recs[c.entity] && names[c.entity]) {
      const e = entities(state).find(x => x.name === names[c.entity!])
      if (e) update<'chat'>(c.id, x => { x.entity = e.id })
    }
  })
  set({ legacy: [] })
}

/** Write records outside the undo history (import, first-run setup), then reload. */
export async function baseline(recs: { kind: Kind; id: string; data: Record<string, unknown> }[]) {
  await flush()
  const r = await fetch('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group: newGroup(), label: 'Baseline', baseline: true, changes: recs }) })
  if (!r.ok) throw new Error(await r.text())
  await load()
}

export async function undoRedo(undo: boolean) {
  await flush()
  const r = await fetch(undo ? '/api/undo' : '/api/redo', { method: 'POST' })
  const { label } = await r.json()
  await load()
  showToast(label ? `${undo ? 'Undid' : 'Redid'}: ${label}` : `Nothing to ${undo ? 'undo' : 'redo'}`)
}

/** Apply an AI proposal. `set` keys may be dotted ("fields.wants"). */
export function applyProposal(p: Proposal): string | undefined {
  if (p.op === 'edit' && p.id && p.find !== undefined) {
    const sc = get(state, p.id, 'scene')
    if (!sc || !sc.prose.includes(p.find)) return
    update<'scene'>(p.id, x => { pushSnapshot(x); x.prose = x.prose.replace(p.find!, p.replace ?? '') })
    return p.id
  }
  if (p.op === 'create' && p.kind && p.data) return create(p.kind, p.data as never, p.newId)
  if (p.op === 'update' && p.id && p.set && state.recs[p.id]) {
    update(p.id, d => {
      for (const [k, v] of Object.entries(p.set!)) {
        const path = k.split('.')
        let o = d as unknown as Record<string, unknown>
        for (const part of path.slice(0, -1)) o = (o[part] ??= {}) as Record<string, unknown>
        o[path[path.length - 1]] = v
      }
    })
    return p.id
  }
}

export const nextOrder = (xs: { order: number }[]) => (xs.length ? Math.max(...xs.map(x => x.order)) : 0) + 1

const at = (o: unknown, path: string) => path.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o)
/** Derived from the canon, so undo/redo keep proposal cards honest. */
export function isApplied(s: State, p: Proposal) {
  if (p.op === 'edit') { const pr = get(s, p.id, 'scene')?.prose ?? ''; return !!p.find && !pr.includes(p.find) && pr.includes(p.replace ?? '') }
  if (p.op === 'create') return !!(p.newId && s.recs[p.newId])
  const rec = p.id ? s.recs[p.id] : undefined
  return !!rec && Object.entries(p.set || {}).every(([k, v]) => JSON.stringify(at(rec, k)) === JSON.stringify(v))
}

/** Keep the current prose as a snapshot before replacing it (newest first, at most 20 unnamed). */
export function pushSnapshot(x: Scene, name?: string) {
  if (!x.prose.trim() || x.snapshots[0]?.text === x.prose) return
  let auto = 0
  x.snapshots = [{ text: x.prose, at: new Date().toISOString(), name }, ...x.snapshots].filter(t => t.name || ++auto <= 20)
}

// ---------------- record factories (one place for defaults) ----------------

export const newScene = (story: string, order: number, patch: Partial<Data['scene']> = {}): Data['scene'] =>
  ({ story, order, title: 'New scene', card: '', wants: '', mustLand: [], beat: '', cast: [], links: {}, prose: '', pinned: false, snapshots: [], status: 'todo', ...patch })
export const newFact = (patch: Partial<Data['fact']> = {}): Data['fact'] => ({ text: '', detail: '', causes: [], knows: {}, ...patch })
export const newQuestion = (patch: Partial<Data['question']> = {}): Data['question'] =>
  ({ type: 'question', text: '', about: [], options: [], answer: '', by: 'you', at: new Date().toISOString(), ...patch })
export const newNote = (scene: string, patch: Partial<Data['note']> = {}): Data['note'] => ({ scene, text: '', by: 'you', at: new Date().toISOString(), ...patch })
export const newEntityData = (type: string, name: string): Data['entity'] => ({ type, name, aliases: [], summary: '', fields: {}, notes: '', relations: [] })
export const newSection = (story: string, order: number, patch: Partial<Data['section']> = {}): Data['section'] => ({ story, order, type: 'chapter', title: '', synopsis: '', ...patch })
export const newResearch = (patch: Partial<Data['research']> = {}): Data['research'] => ({ title: 'Untitled', type: 'note', text: '', about: [], at: new Date().toISOString(), ...patch })
/** Next free "at" for a new event: after the last one. */
export const nextAt = (s: State) => { const e = events(s); return e.length ? e[e.length - 1].at! + 1 : 1 }
