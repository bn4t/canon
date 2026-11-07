import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  update, create, remove, tx, get, list, getState, stories, scenesOf, nextOrder, showToast, applyProposal, isApplied, pushSnapshot, newScene, newNote, newQuestion,
  type State, type Story, type Scene, type Proposal, type Severity, type Link,
} from './store.ts'
import { complete, completeJSON } from './ai.ts'
import { buildScene, inputHash, directPassage, deriveCard, critiqueScene, continuityCheck } from './prompts.ts'
import { go } from './ui.tsx'

// Scene operations shared by the editor, the outline and the shell. They read fresh state, so they are safe to run in batches.

// ---------------- suggestions: text edits not yet accepted ----------------
// Local ones (rewrites, drafts, fixes) live here until accepted or rejected; "edit" proposals in chats join them.

/** What a local suggestion is. `whole`: a new draft of the entire text (from the card). */
export interface SuggestionMeta { whole?: boolean; hash?: string; who?: string; source?: string }
const pending = new Map<string, Proposal[]>()
const meta = new WeakMap<Proposal, SuggestionMeta>()
const subs = new Set<() => void>()
let ver = 0
const bump = () => { ver++; subs.forEach(f => f()) }
/** Open local suggestions for a scene. */
export const pendingFor = (id: string) => pending.get(id) || []
export function addPending(p: Proposal, m: SuggestionMeta = {}) {
  meta.set(p, m)
  // A new whole-scene draft replaces the previous one.
  const keep = (pending.get(p.id!) || []).filter(x => !(m.whole && meta.get(x)?.whole))
  pending.set(p.id!, [...keep, p]); bump()
}
export const dropPending = (p: Proposal) => { pending.set(p.id!, (pending.get(p.id!) || []).filter(x => x !== p)); bump() }
/** Change what a local suggestion would write ("Edit before accepting"). */
export const editPending = (p: Proposal, replace: string) => { p.replace = replace; bump() }
export const usePendingVer = () => useSyncExternalStore(f => (subs.add(f), () => subs.delete(f)), () => ver)

export interface Hunk {
  p: Proposal; at: number; reject: () => void; who: string
  /** Where it came from: a conversation's title, a note, a rewrite direction. */
  source?: string
  /** A new draft of the whole scene: not anchored to one passage. */
  whole?: boolean
  /** Change the replacement text before accepting. */
  edit?: (replace: string) => void
}
/** Every open suggestion for a scene: whole-scene drafts first, then passage edits in text order (local ones plus "edit" proposals in chats). */
export function hunksFor(s: State, sc: Scene): Hunk[] {
  const local = pendingFor(sc.id).map(p => {
    const m = meta.get(p) || {}
    return { p, at: m.whole ? 0 : sc.prose.indexOf(p.find!), reject: () => dropPending(p), who: m.who || 'Assistant', source: m.source, whole: m.whole, edit: (r: string) => editPending(p, r) } as Hunk
  })
  const out: Hunk[] = local.filter(h => !h.whole)
  for (const c of list(s, 'chat')) c.messages.forEach((m, i) => (m.proposals || []).forEach((p, j) => {
    if (p.op === 'edit' && p.id === sc.id && !isApplied(s, p)) out.push({
      p, at: sc.prose.indexOf(p.find!), who: 'Assistant', source: `from “${c.title}”`,
      reject: () => update<'chat'>(c.id, x => { x.messages[i].proposals = x.messages[i].proposals!.filter((_, k) => k !== j) }),
      edit: r => update<'chat'>(c.id, x => { const q = x.messages[i].proposals?.[j]; if (q) q.replace = r }),
    })
  }))
  // Drop edits whose passage is gone; keep the first of any overlapping pair.
  const ok = out.filter(h => h.p.find && h.at >= 0).sort((a, b) => a.at - b.at)
  return [...local.filter(h => h.whole), ...ok.filter((h, i) => i === 0 || h.at >= ok[i - 1].at + ok[i - 1].p.find!.length)]
}
/** Apply one suggestion's text (inside a tx). */
function applyHunk(h: Hunk) {
  const m = meta.get(h.p)
  if (h.whole) update<'scene'>(h.p.id!, x => { pushSnapshot(x, 'Before the new draft'); x.prose = h.p.replace || ''; if (m?.hash) x.builtHash = m.hash; if (!x.status || x.status === 'todo') x.status = 'draft' })
  else applyProposal(h.p)
}
const settle = (h: Hunk) => { if (pendingFor(h.p.id!).includes(h.p)) dropPending(h.p) }
export const accept = (h: Hunk) => { tx(h.whole ? 'Accept the new draft' : 'Accept suggestion', () => applyHunk(h)); settle(h) }
/** Accept several at once: later passages first, so earlier positions stay valid. */
export function acceptAll(hs: Hunk[]) {
  if (!hs.length) return
  tx(hs.length === 1 ? 'Accept suggestion' : `Accept ${hs.length} suggestions`, () => { const w = hs.find(h => h.whole); if (w) applyHunk(w); else [...hs].reverse().forEach(applyHunk) })
  hs.forEach(settle)
}
export const rejectAll = (hs: Hunk[]) => hs.forEach(h => h.reject())

// ---------------- AI operations (read fresh state; safe to run in batches) ----------------

export type Built = 'empty' | 'manual' | 'built' | 'stale'
export const builtState = (sc: Scene, hash?: string): Built => (!sc.prose.trim() ? 'empty' : !sc.builtHash ? 'manual' : hash && hash !== sc.builtHash ? 'stale' : 'built')
export const BUILT: Record<Built, { label: string; cls: string; hint: string }> = {
  empty: { label: 'No text', cls: '', hint: 'Nothing written or drafted yet' },
  manual: { label: '', cls: '', hint: 'Written or imported by you' },
  built: { label: 'Drafted from card', cls: 'ok', hint: 'Drafted by the assistant from the current card and canon' },
  stale: { label: 'Card changed since draft', cls: 'warn', hint: 'The card or the canon changed after the assistant drafted this' },
}

/** Input hashes per scene of a story, recomputed (debounced) when the canon changes. */
export function useHashes(s: State, storyId?: string) {
  const [h, setH] = useState<Record<string, string>>({})
  useEffect(() => {
    let live = true
    const t = setTimeout(async () => {
      const st = get(s, storyId, 'story')
      if (!st) return
      const out: Record<string, string> = {}
      for (const sc of scenesOf(s, st.id)) out[sc.id] = await inputHash(s, st, sc)
      if (live) setH(out)
    }, 400)
    return () => { live = false; clearTimeout(t) }
  }, [s, storyId])
  return h
}

export const fresh = (id: string) => { const s = getState(); const sc = get(s, id, 'scene')!; return { s, sc, st: get(s, sc.story, 'story')! } }

export async function buildOne(id: string, signal: AbortSignal, onText?: (t: string) => void) {
  const { s, sc, st } = fresh(id)
  const p = buildScene(s, st, sc)
  const hash = await inputHash(s, st, sc)
  const out = (await complete('build', p.system, p.prompt, onText, signal)).trim()
  if (!out) throw new Error('The model returned no text.')
  const now = get(getState(), id, 'scene')!
  // Over existing text, a new draft is a suggestion to review; into an empty scene it is written (and undoable).
  if (now.prose.trim()) { addPending({ op: 'edit', id, find: now.prose, replace: out, why: 'A new draft from the scene card.' }, { whole: true, hash, who: 'Draft from card' }); return 'suggested' as const }
  tx(`Draft “${sc.title}” from its card`, () => update<'scene'>(id, x => { x.prose = out; x.builtHash = hash; if (!x.status || x.status === 'todo') x.status = 'draft' }))
  return 'written' as const
}

/** What "Fill card from text" would change on a scene, without changing it. */
export interface CardFill { title?: string; beat?: string; card?: string; wants?: string; mustLand?: string[]; links?: Record<string, Link>; cast?: string[] }
export async function deriveCardChanges(id: string, signal: AbortSignal): Promise<CardFill> {
  const { s, sc, st } = fresh(id)
  const d = await completeJSON<CardFill>('assist', deriveCard(s, st, sc), signal)
  const out: CardFill = {}
  if (d.title && (!sc.title.trim() || /^(Scene \d+|New scene)$/.test(sc.title)) && d.title !== sc.title) out.title = d.title
  if (d.beat && st.beats.includes(d.beat) && d.beat !== sc.beat) out.beat = d.beat
  if (d.card && d.card !== sc.card) out.card = d.card
  if (d.wants && d.wants !== sc.wants) out.wants = d.wants
  if (d.mustLand?.length && d.mustLand.join('\n') !== sc.mustLand.join('\n')) out.mustLand = d.mustLand
  const links = Object.fromEntries(Object.entries(d.links || {}).filter(([k, v]) => get(s, k, 'fact') && (v === 'on' || v === 'felt') && sc.links[k] !== v))
  if (Object.keys(links).length) out.links = links as Record<string, Link>
  const cast = (d.cast || []).filter(e => get(s, e, 'entity') && !sc.cast.includes(e))
  if (cast.length) out.cast = [...new Set(cast)]
  return out
}
/** Write (part of) a card fill into the scene, inside a tx. */
export function applyCardFill(id: string, d: CardFill) {
  update<'scene'>(id, x => {
    if (d.title) x.title = d.title
    if (d.beat) x.beat = d.beat
    if (d.card) x.card = d.card
    if (d.wants) x.wants = d.wants
    if (d.mustLand) x.mustLand = d.mustLand
    for (const [k, v] of Object.entries(d.links || {})) x.links[k] = v
    x.cast = [...new Set([...x.cast, ...(d.cast || [])])]
  })
}
/** Fill the card from the text straight away (batches on the outline). */
export async function deriveOne(id: string, signal: AbortSignal) {
  const d = await deriveCardChanges(id, signal)
  const sc = get(getState(), id, 'scene')
  if (sc) tx(`Fill card for “${d.title || sc.title}”`, () => applyCardFill(id, d), false)
}

/** Rewrite prose[start:end] following a direction; the result arrives as a tracked change. */
export async function direct(id: string, start: number, end: number, direction: string, signal: AbortSignal) {
  const { s, sc, st } = fresh(id)
  const p = directPassage(s, st, sc, start, end, direction)
  const out = (await complete('build', p.system, p.prompt, undefined, signal)).trim()
  if (!out) throw new Error('The model returned no text.')
  addPending({ op: 'edit', id, find: sc.prose.slice(start, end), replace: out }, { who: 'Rewrite', source: direction.length > 70 ? direction.slice(0, 68) + '…' : direction })
}

/** Locate a quoted passage in prose. ponytail: exact, then case-insensitive; paraphrased quotes aren't found. */
export function locate(prose: string, quote?: string): [number, number] | undefined {
  const q = quote?.trim().replace(/^["“]|["”]$/g, '')
  if (!q) return
  let i = prose.indexOf(q)
  if (i < 0) i = prose.toLowerCase().indexOf(q.toLowerCase())
  return i < 0 ? undefined : [i, i + q.length]
}

export async function critique(id: string, signal: AbortSignal) {
  const { s, sc, st } = fresh(id)
  const out = await completeJSON<{ topic?: string; text: string; quote?: string }[]>('check', critiqueScene(s, st, sc), signal)
  tx('Get feedback', () => {
    for (const n of list(getState(), 'note')) if (n.scene === id && n.by === 'ai' && !n.done) remove(n.id) // replace the previous open critique
    for (const n of out) create('note', newNote(id, { by: 'ai', topic: n.topic, text: n.text, quote: n.quote || undefined }))
  }, false)
  return out.length
}

export async function continuity(storyId: string, signal: AbortSignal) {
  const s = getState(), st = get(s, storyId, 'story')!
  const out = await completeJSON<{ severity?: Severity; scene?: number; quote?: string; problem: string; fix?: string; canon?: 'hole' | 'contradiction'; about?: string[] }[]>('check', continuityCheck(s, st), signal)
  const ids = scenesOf(getState(), storyId).map(x => x.id)
  let notes = 0, qs = 0
  tx('Check continuity', () => {
    for (const n of list(getState(), 'note')) if (ids.includes(n.scene) && n.by === 'check' && !n.done) remove(n.id)
    for (const f of out) {
      if (f.canon) { qs++; create('question', newQuestion({ type: f.canon, text: f.problem, about: (f.about || []).filter(x => getState().recs[x]), by: 'check' })) }
      else if (f.scene && ids[f.scene - 1]) { notes++; create('note', newNote(ids[f.scene - 1], { by: 'check', severity: (['critical', 'error', 'warning', 'note'] as const).includes(f.severity!) ? f.severity : 'warning', quote: f.quote, text: f.problem, fix: f.fix })) }
    }
  }, false)
  showToast(out.length ? `Continuity: ${notes} note${notes === 1 ? '' : 's'} in the margin${qs ? `, ${qs} question${qs === 1 ? '' : 's'} in Questions` : ''}` : 'Continuity: no problems found')
}

export function newStory() {
  let id = ''
  tx('New story', () => { id = create('story', { title: 'Untitled story', order: nextOrder(stories(getState())), form: 'prose', premise: '', beats: [] }) })
  go('story/' + id)
}
export function addScene(st: Story, order?: number) {
  let id = ''
  tx('New scene', () => { id = create('scene', newScene(st.id, order ?? nextOrder(scenesOf(getState(), st.id)), { cast: st.pov ? [st.pov] : [] })) })
  go('scene/' + id)
  return id
}
export function reorder(scs: Scene[], dragId: string, beforeId?: string) {
  const ids = scs.map(x => x.id).filter(x => x !== dragId)
  const at = beforeId ? ids.indexOf(beforeId) : ids.length
  ids.splice(at < 0 ? ids.length : at, 0, dragId)
  tx('Reorder scenes', () => ids.forEach((id, i) => { if (get(getState(), id, 'scene')!.order !== i + 1) update<'scene'>(id, x => { x.order = i + 1 }) }))
}
export function splitAt(sc: Scene, at: number) {
  const scs = scenesOf(getState(), sc.story), next = scs[scs.findIndex(x => x.id === sc.id) + 1]
  let id = ''
  tx('Split scene', () => {
    id = create('scene', newScene(sc.story, next ? (sc.order + next.order) / 2 : sc.order + 1, { title: sc.title + ' (2)', cast: sc.cast, links: { ...sc.links }, prose: sc.prose.slice(at).trimStart(), status: sc.status, label: sc.label }))
    update<'scene'>(sc.id, x => { pushSnapshot(x, 'Before split'); x.prose = x.prose.slice(0, at).trimEnd() })
  })
  go('scene/' + id)
}
export function mergeNext(sc: Scene) {
  const scs = scenesOf(getState(), sc.story), next = scs[scs.findIndex(x => x.id === sc.id) + 1]
  if (!next) return showToast('This is the last scene of the story.')
  tx(`Merge “${next.title}” into “${sc.title}”`, () => {
    update<'scene'>(sc.id, x => { pushSnapshot(x, 'Before merge'); x.prose = [x.prose.trimEnd(), next.prose.trim()].filter(Boolean).join('\n\n'); x.cast = [...new Set([...x.cast, ...next.cast])]; x.links = { ...next.links, ...x.links }; x.mustLand = [...x.mustLand, ...next.mustLand].filter(Boolean) })
    for (const n of list(getState(), 'note')) if (n.scene === next.id) update<'note'>(n.id, y => { y.scene = sc.id })
    remove(next.id)
  })
}
