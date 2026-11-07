// Imports. planTree/runImport: documents, folders and Scrivener projects, as converted by the main process (src/main/convert.ts),
// planned here (pure, so it is testable) and written as one undo step. planImport: sheets from .md frontmatter.
// importCanonFolder: the -root folder layout (canon/*.json, characters/, worldbuilding/, writer-skill guides).
import {
  baseline, uid, getState, typesOf, create, update, tx, nextOrder, stories, emptyProject, newScene, newFact, newQuestion, newNote, newSection, newResearch,
  flowOf, project, STATUSES, LABELS, type Kind, type Severity, type Link, type State, type StatusDef, type ResearchType,
} from './store.ts'
import { f, slug, DEFAULT_TYPES, type TypeDef } from './schema.ts'

// Types for the -root folder layout (characters/ + worldbuilding/ with a `type:` frontmatter key).
const FOLDER_TYPES: Record<string, TypeDef> = {
  character: DEFAULT_TYPES.character,
  place: { label: 'Places', one: 'Place', fields: [f('district', 'District / where', 'Neighborhood, building, floor', false), ...DEFAULT_TYPES.place.fields.slice(1)] },
  organization: { label: 'Organizations', one: 'Organization', fields: DEFAULT_TYPES.group.fields },
  technology: { label: 'Technology', one: 'Technology', fields: [f('description', 'What it is'), f('rules', 'Rules & limits', 'What it can and can’t do'), f('cost', 'Cost & side effects'), f('significance', 'Story significance', 'Why the story needs it')] },
  system: { label: 'Systems', one: 'System', fields: [f('description', 'How it works'), f('failure', 'How it fails'), f('significance', 'Story significance', 'Why the story needs it')] },
  culture: { label: 'Culture', one: 'Culture', fields: [f('description', 'Description', 'What it is'), f('usage', 'On the page', 'How and when it shows up in prose')] },
  concept: { label: 'Concepts & history', one: 'Concept', fields: DEFAULT_TYPES.lore.fields },
}
function typeFromFile(t: string, path: string) {
  if (path.startsWith('characters/')) return 'character'
  const m: Record<string, string> = { location: 'place', organization: 'organization', technology: 'technology', pharmaceutical: 'technology', infrastructure: 'system', culture: 'culture', currency: 'culture' }
  return m[t] || 'concept'
}
const SECTION_FIELDS: Record<string, string> = { personality: 'personality', background: 'background', 'physical description': 'physical', 'dialogue style': 'voice' }

let known = new Set<string>()
async function read(path: string) {
  if (!known.has(path)) return undefined // skip missing files instead of 404ing
  const r = await fetch('/api/file?path=' + encodeURIComponent(path))
  return r.ok ? r.text() : undefined
}
const readJSON = async (path: string) => { const t = await read(path); return t ? JSON.parse(t) : undefined }

/** Split "---\nfrontmatter\n---\nbody" into a flat map and the body. Handles `key: value` and `key: [a, b]`. */
export function frontmatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string | string[]> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (!kv) continue
    const v = kv[2].trim()
    meta[kv[1]] = v.startsWith('[') ? v.slice(1, -1).split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : v
  }
  return { meta, body: text.slice(m[0].length) }
}

/** Split a markdown body into the lead text and `## Heading` sections. */
export function sections(body: string) {
  const parts = body.split(/^## +(.+)$/m)
  const out: { heading: string; text: string }[] = []
  for (let i = 1; i < parts.length; i += 2) out.push({ heading: parts[i].trim(), text: parts[i + 1].trim() })
  return { lead: parts[0].trim(), sections: out }
}

const firstSentence = (t: string) => (t.match(/^[^.!?]*[.!?]/)?.[0] || t.split('\n')[0]).trim().slice(0, 240)
const asList = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : [])

export async function importCanonFolder(log: (msg: string) => void) {
  const tree: string[] = await (await fetch('/api/tree')).json()
  if (!tree.length) throw new Error('No story folder. Start Canon with -root pointing at your stories.')
  known = new Set(tree)

  const oldSeries = await readJSON('canon/series.json') || {}
  const oldEvents = await readJSON('canon/events.json') || { events: [], questions: [] }
  const oldKnow = await readJSON('canon/knowledge.json') || { characters: [], facts: [] }
  const storyFiles = tree.filter(p => p.startsWith('canon/stories/') && p.endsWith('.json'))
  const oldStories = await Promise.all(storyFiles.map(readJSON))

  const recs: { kind: Kind; id: string; data: Record<string, unknown> }[] = []
  const add = (kind: Kind, data: Record<string, unknown>, id = uid(kind)) => { recs.push({ kind, id, data }); return id }

  // Entities from character + worldbuilding files. Key by file basename (old canon referenced characters that way).
  const byKey: Record<string, string> = {}
  const byName: Record<string, string> = {}
  const pending: { id: string; related: string[] }[] = []
  for (const path of tree.filter(p => (p.startsWith('characters/') || p.startsWith('worldbuilding/')) && p.endsWith('.txt'))) {
    const text = (await read(path)) || ''
    const { meta, body } = frontmatter(text)
    const type = typeFromFile(String(meta.type || ''), path)
    const { lead, sections: secs } = sections(body)
    const fields: Record<string, string> = {}
    const notes: string[] = []
    if (meta.role) fields.role = String(meta.role)
    if (meta.pronouns) fields.pronouns = String(meta.pronouns)
    if (meta.location) fields[type === 'character' ? 'home' : 'district'] = String(meta.location)
    if (lead) { if (type === 'character') notes.push(lead); else fields.description = lead }
    for (const sct of secs) {
      const key = type === 'character' ? SECTION_FIELDS[sct.heading.toLowerCase()] : undefined
      if (key) fields[key] = sct.text
      else notes.push(`## ${sct.heading}\n\n${sct.text}`)
    }
    const name = String(meta.name || path.split('/').pop()!.replace('.txt', ''))
    const id = add('entity', {
      type, name, aliases: asList(meta.aliases), summary: firstSentence(fields.description || fields.personality || lead || ''),
      fields, notes: notes.join('\n\n'), relations: [],
    })
    byKey[path.split('/').pop()!.replace('.txt', '')] = id
    for (const n of [name, ...asList(meta.aliases)]) byName[n.toLowerCase()] = id
    pending.push({ id, related: asList(meta.related) })
  }
  for (const p of pending) {
    const rec = recs.find(r => r.id === p.id)!
    rec.data.relations = p.related.map(n => byName[n.toLowerCase()]).filter(Boolean).map(to => ({ to, label: '' }))
  }
  log(`${pending.length} entities`)
  const ent = (key?: string) => (key ? byKey[key] : undefined)

  // Project and guides
  const spec = (oldSeries.spec && await read(oldSeries.spec)) || ''
  add('project', { ...emptyProject(FOLDER_TYPES), title: oldSeries.title || 'Untitled project', background: spec, emDashCheck: true }, 'project')
  if (oldSeries.bannedPhrases?.length) add('guide', { use: 'banned', scope: 'project', title: 'Banned phrases', text: oldSeries.bannedPhrases.join('\n') })
  const guide = async (path: string, scope: string, use = 'style', title?: string) => {
    const text = await read(path)
    if (text) add('guide', { use, scope, title: title || path.split('/').pop()!.replace(/\.md$/, ''), text: text.replace(/^---\n[\s\S]*?\n---\n/, '') })
  }
  for (const p of oldSeries.styleGuide || []) await guide(p, 'project')
  for (const p of oldSeries.documentGuide || []) await guide(p, 'form:documents')
  for (const [k, p] of Object.entries(oldSeries.voices || {})) await guide(p as string, 'entity:' + (ent(k) || k), 'style', 'Voice')
  if (oldSeries.checkPrompt) await guide(oldSeries.checkPrompt, 'project', 'check', 'Continuity check')
  for (const r of oldSeries.rules || []) add('guide', { use: 'rule', scope: r.scope === 'series' ? 'project' : r.scope.replace(/^char:(.+)$/, (_: string, k: string) => 'entity:' + (ent(k) || k)), title: 'Rule', text: r.text })

  // Events become facts with a time; old questions attach to them; knowledge facts keep their cells.
  const order: string[] = oldSeries.readingOrder || []
  const evId: Record<string, string> = {}
  const cells: Record<string, Record<string, string>> = {}
  oldEvents.events.forEach((e: { id: string }) => { evId[e.id] = uid('fact') })
  oldEvents.events.forEach((e: { id: string; title: string; summary: string; causes: string[]; cells: Record<string, string> }, i: number) => {
    cells[evId[e.id]] = e.cells || {}
    add('fact', newFact({ text: e.title, detail: e.summary, at: i + 1, causes: e.causes.map(c => evId[c]).filter(Boolean) }), evId[e.id])
  })
  for (const q of oldEvents.questions) add('question', newQuestion({ text: q.text, about: q.events.map((c: string) => evId[c]).filter(Boolean), options: q.options || [], answer: q.answer || '' }))
  oldKnow.facts.forEach((f: { text: string; cells: Record<string, unknown> }) => add('fact', newFact({
    text: f.text, knows: Object.fromEntries(Object.entries(f.cells).map(([k, v]) => [ent(k) || k, v])) as never,
  })))

  for (const st of oldStories) {
    if (!st) continue
    add('story', { title: st.title, order: order.includes(st.id) ? order.indexOf(st.id) + 1 : 99, pov: ent(st.pov), form: st.kind, premise: st.premise, beats: st.beats }, st.id)
    let scenes = st.scenes
    if (!scenes.length && st.draft) { // never-imported draft: split into pinned scenes now
      const text = (await read(st.draft)) || ''
      scenes = text.split(/^\s*---\s*$/m).map((p: string) => p.trim()).filter(Boolean).map((prose: string, i: number) => ({ id: uid('scene'), title: `Scene ${i + 1}`, events: [], cast: st.pov ? [st.pov] : [], prose, pinned: true }))
    }
    type Old = { id: string; title: string; beat?: string; card?: string; wants?: string; mustLand?: string[]; events: string[]; cast: string[]; prose?: string; pinned?: boolean; takes?: { text: string; at: string }[]; status?: string; notes?: { kind: string; text: string; quote?: string; done?: boolean }[]; authorNotes?: string }
    scenes.forEach((sc: Old, i: number) => {
      const links: Record<string, Link> = {}
      for (const c of sc.events) if (evId[c]) links[evId[c]] = cells[evId[c]]?.[st.id] === 'felt' ? 'felt' : 'on'
      add('scene', newScene(st.id, i + 1, {
        title: sc.title, beat: sc.beat || '', card: sc.card || '', wants: sc.wants || '', mustLand: sc.mustLand || [], cast: sc.cast.map(ent).filter(Boolean) as string[], links,
        prose: sc.prose || '', pinned: !!sc.pinned, snapshots: sc.takes || [], status: (sc.status || (String(sc.prose || '').trim() ? 'draft' : 'todo')) as never,
      }), sc.id)
      for (const n of sc.notes || []) add('note', newNote(sc.id, { text: n.text, quote: n.quote || undefined, topic: n.kind, by: 'ai', done: n.done }))
      if (sc.authorNotes?.trim()) add('note', newNote(sc.id, { text: sc.authorNotes }))
    })
    const check = await readJSON(`canon/checks/${st.id}.json`)
    for (const f of check?.findings || []) {
      const sc = f.scene ? scenes[f.scene - 1] : undefined
      if (!sc) continue
      const sev = f.problem.match(/^(CRITICAL|ERROR|WARNING|NOTE)\s*:\s*/i)
      add('note', newNote(sc.id, { by: 'check', severity: (sev?.[1].toLowerCase() || 'warning') as Severity, quote: f.quote, text: sev ? f.problem.slice(sev[0].length) : f.problem, fix: f.fix, at: check.at }))
    }
  }
  log(`${oldStories.length} stories, ${oldEvents.events.length} events, ${oldKnow.facts.length} facts`)

  await baseline(recs)
  return recs.length
}

// ---------------- generic file import ----------------

/** Split prose into scenes on separator lines (---, ***, * * *, #) or markdown headings; headings become titles. */
export function splitScenes(text: string): { title: string; prose: string }[] {
  const out: { title: string; prose: string }[] = []
  let title = '', buf: string[] = []
  const push = () => { const prose = buf.join('\n').trim(); if (prose) out.push({ title: title || `Scene ${out.length + 1}`, prose }); buf = []; title = '' }
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const h = line.match(/^#{1,3}\s+(.+?)\s*#*$/)
    if (/^\s*(-{3,}|\*{3,}|(\*\s){2}\*|#)\s*$/.test(line)) push()
    else if (h) { push(); title = h[1] }
    else buf.push(line)
  }
  push()
  return out
}

export interface ImportPlan { stories: { title: string; scenes: { title: string; prose: string }[] }[]; entities: { type: string; name: string; aliases: string[]; summary: string; fields: Record<string, string>; notes: string }[]; types: Record<string, TypeDef> }

/** Work out what a set of files becomes, without writing anything. Pure, so it is testable. */
export function planImport(files: { path: string; text: string }[], existing: Record<string, TypeDef>): ImportPlan {
  const types: Record<string, TypeDef> = structuredClone(existing)
  const plan: ImportPlan = { stories: [], entities: [], types }
  const findType = (t: string) => {
    const k = t.toLowerCase().trim()
    const hit = Object.entries(types).find(([id, d]) => id === k || d.one.toLowerCase() === k || d.label.toLowerCase() === k || d.label.toLowerCase() === k + 's')
    if (hit) return hit[0]
    const id = slug(t)
    const one = t.trim().replace(/s$/i, '')
    types[id] = { label: one[0].toUpperCase() + one.slice(1) + 's', one: one[0].toUpperCase() + one.slice(1), fields: [] }
    return id
  }
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))) {
    const base = file.path.split('/').pop()!.replace(/\.(txt|md|markdown)$/i, '')
    const { meta, body } = frontmatter(file.text)
    const folder = file.path.split('/').slice(-2, -1)[0]
    if (meta.name || meta.type) { // a sheet: frontmatter marks it as an entity
      const type = findType(String(meta.type || folder || 'note'))
      const def = types[type]
      const { lead, sections: secs } = sections(body)
      const fields: Record<string, string> = {}
      for (const [k, v] of Object.entries(meta)) {
        const fd = def.fields.find(x => x.key === k || x.label.toLowerCase() === k.toLowerCase())
        if (fd && typeof v === 'string') fields[fd.key] = v
      }
      const notes: string[] = []
      for (const sct of secs) {
        let fd = def.fields.find(x => x.label.toLowerCase() === sct.heading.toLowerCase() || x.key === slug(sct.heading))
        if (!fd) { fd = f(slug(sct.heading), sct.heading); def.fields.push(fd) } // the sheet's headings teach the type its fields
        fields[fd.key] = sct.text
      }
      if (lead) notes.push(lead)
      plan.entities.push({ type, name: String(meta.name || base), aliases: Array.isArray(meta.aliases) ? meta.aliases : meta.aliases ? [String(meta.aliases)] : [], summary: firstSentence(lead || Object.values(fields)[0] || ''), fields, notes: notes.join('\n\n') })
    } else {
      const scenes = splitScenes(body)
      if (scenes.length) plan.stories.push({ title: base.replace(/^\d+[\s._-]+/, '').replace(/[-_]+/g, ' ') || base, scenes })
    }
  }
  return plan
}

// ---------------- documents, folders and Scrivener projects ----------------

/** What the main process's converters produce (src/main/convert.ts): text in Canon's prose syntax, plus Scrivener's metadata. */
export interface ImportNode {
  kind: 'folder' | 'text' | 'file'; title: string; text?: string; synopsis?: string; notes?: string; label?: string; status?: string; keywords?: string[]
  exclude?: boolean; whole?: boolean; file?: { path: string; name: string; mime: string; size: number }; children?: ImportNode[]; research?: boolean
}
/** "breaks": at scene breaks (headings make parts and chapters). "headings": every heading starts a scene too. "none": one scene per document. */
export type SplitAt = 'breaks' | 'headings' | 'none'
/** "story": one new story. "stories": a new story per top-level document or folder. Anything else: the id of a story to add chapters to. */
export type BringAs = 'story' | 'stories' | string
export interface TreeOpts { split: SplitAt; as: BringAs; title?: string }

export interface PlanScene { kind: 'scene'; title: string; prose: string; card: string; notes: string; label?: string; status?: string; tags: string[]; exclude?: boolean }
export interface PlanSection { kind: 'part' | 'chapter'; title: string; synopsis: string; exclude?: boolean }
export type PlanItem = PlanScene | PlanSection
export interface TreePlan {
  stories: { title: string; into?: string; items: PlanItem[] }[]
  research: { title: string; type: ResearchType; text: string; folder?: string; file?: ImportNode['file'] }[]
  entities: ImportPlan['entities']; types?: Record<string, TypeDef>
  /** Scrivener label and status names met, in order. */
  labels: string[]; statuses: string[]
}

const BREAK_LINE = /^\s*(\*\s*\*\s*\*|\*{3,}|-{3,}|_{3,}|~{3,}|#|⁂)\s*$/
const HEAD_LINE = /^(#{1,3})\s+(.+?)\s*#*$/
const isBreak = (l: string) => BREAK_LINE.test(l.replace(/\\\*/g, '*'))
/** A document whose frontmatter names it (name: / type:) is a sheet, not manuscript. */
const sheetOf = (n: ImportNode) => {
  if (n.kind !== 'text' || !n.whole || !n.text?.startsWith('---\n')) return
  const { meta } = frontmatter(n.text)
  return meta.name || meta.type ? n.text : undefined
}
/** The text without frontmatter, one paragraph per line. */
const bodyOf = (n: ImportNode) => (n.text?.startsWith('---\n') ? frontmatter(n.text).body : n.text || '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trimEnd()).filter(l => l.trim())
/** "The tide was out when Ines…": a title for a scene that has none. */
export function openingWords(prose: string, n = 6) {
  const line = prose.split('\n').find(l => l.trim() && !HEAD_LINE.test(l)) || ''
  const ws = line.replace(/\^\[[^\]]*\]/g, '').replace(/^>\s*/, '').replace(/\\?\*/g, '').split(/\s+/).filter(Boolean)
  return ws.length ? ws.slice(0, n).join(' ').replace(/[,;:.!?—–-]+$/, '') + (ws.length > n ? '…' : '') : 'Untitled scene'
}
const manuscript = (n: ImportNode) => !n.research && n.kind !== 'file' && !sheetOf(n)
/** A folder at the top of a story: a part when its name says so or it holds folders; otherwise a chapter. */
const isPart = (n: ImportNode) => /^(part|book|act|volume)\b/i.test(n.title) || (!/^chapter\b/i.test(n.title) && (n.children || []).some(c => c.kind === 'folder' && manuscript(c)))

/** What the picked nodes become. Pure: no records are written. */
export function planTree(nodes: ImportNode[], o: TreeOpts, types: Record<string, TypeDef>): TreePlan {
  const plan: TreePlan = { stories: [], research: [], entities: [], labels: [], statuses: [] }
  const sheets: { path: string; text: string }[] = []
  const meet = (list: string[], v?: string) => { if (v && !list.includes(v)) list.push(v) }
  const research = (n: ImportNode, folder: string[]) => {
    if (n.kind === 'folder') return (n.children || []).forEach(c => research(c, [...folder, n.title]))
    const where = folder.slice(1).join(' / ') || undefined // the research root's own name ("Research") says nothing
    const text = [n.kind === 'text' ? n.text : '', n.synopsis, n.notes].filter(Boolean).join('\n\n')
    if (n.file) plan.research.push({ title: n.title, type: researchType(n.file.mime, n.file.name), text: [n.synopsis, n.notes].filter(Boolean).join('\n\n'), folder: where, file: n.file })
    else if (text.trim()) plan.research.push({ title: n.title, type: 'note', text, folder: where })
  }
  /** One text as scenes and, where its headings say so, parts and chapters. */
  const expand = (n: ImportNode, level: 'story' | 'part' | 'chapter'): PlanItem[] => {
    const lines = bodyOf(n), out: PlanItem[] = []
    meet(plan.labels, n.label); meet(plan.statuses, n.status)
    const heads = o.split === 'none' ? [] : [...new Set(lines.map(l => HEAD_LINE.exec(l)?.[1].length).filter((x): x is number => !!x))].sort()
    // The role of each heading level: sections (when splitting at breaks, above chapter level), scene titles, or plain text.
    const role = (k: number): 'part' | 'chapter' | 'scene' | 'text' => {
      if (o.split === 'none') return 'text'
      if (o.split === 'headings' || level === 'chapter') return 'scene'
      const i = heads.indexOf(k)
      if (level === 'story' && heads.length > 1) return i === 0 ? 'part' : i === 1 ? 'chapter' : 'scene'
      return i === 0 ? 'chapter' : 'scene'
    }
    let cur: { title?: string; lines: string[] } | undefined, first = true
    const meta = { label: n.label, status: n.status, tags: n.keywords || [], exclude: n.exclude || undefined }
    const close = () => {
      if (!cur) return
      const prose = cur.lines.join('\n').trim()
      if (prose || cur.title || (first && !n.whole)) {
        out.push({ kind: 'scene', title: cur.title || (first && !n.whole ? n.title : openingWords(prose)), prose, card: first ? n.synopsis || '' : '', notes: first ? n.notes || '' : '', ...meta })
        first = false
      }
      cur = undefined
    }
    for (const l of lines) {
      const h = HEAD_LINE.exec(l), r = h ? role(h[1].length) : 'text'
      if (o.split !== 'none' && isBreak(l)) { close(); continue }
      if (h && (r === 'part' || r === 'chapter')) { close(); out.push({ kind: r, title: h[2], synopsis: '', exclude: n.exclude || undefined }); continue }
      if (h && r === 'scene') { close(); cur = { title: h[2], lines: [] }; continue }
      ;(cur ||= { lines: [] }).lines.push(l)
    }
    if (!cur && first && !n.whole) cur = { lines: [] } // an empty binder item still holds its place (and its card)
    close()
    return out
  }
  /** Items at one level of a story: folders become parts and chapters, documents their scenes. */
  const build = (items: ImportNode[], level: 'story' | 'part' | 'chapter', path: string[], into = false): PlanItem[] => {
    const out: PlanItem[] = []
    const many = items.filter(manuscript).length > 1
    for (const n of items) {
      const sheet = sheetOf(n)
      if (sheet) { sheets.push({ path: [...path, n.title].join('/') + '.md', text: sheet }); continue }
      if (n.research || n.kind === 'file') { research(n, ['', ...path]); continue }
      if (n.kind === 'folder') {
        if (level === 'chapter') { out.push(...build(n.children || [], 'chapter', [...path, n.title])); continue }
        const kind = level === 'story' && isPart(n) ? 'part' : 'chapter'
        out.push({ kind, title: n.title, synopsis: n.synopsis || '', exclude: n.exclude || undefined }, ...build(n.children || [], kind, [...path, n.title]))
        continue
      }
      const headed = o.split === 'breaks' && level !== 'chapter' && bodyOf(n).some(l => HEAD_LINE.test(l))
      // A whole document beside others (or added to a story) is a chapter of its own, unless its headings make the chapters.
      if (n.whole && level !== 'chapter' && !headed && (many || into) && !/^scene\b/i.test(n.title)) out.push({ kind: 'chapter', title: n.title, synopsis: n.synopsis || '' }, ...expand(n, 'chapter'))
      else out.push(...expand(n, level))
    }
    return out
  }
  for (const n of nodes.filter(x => x.kind === 'folder' && x.research)) research(n, [])
  let roots = nodes.filter(x => !(x.kind === 'folder' && x.research))
  let title = o.title?.trim() || ''
  // One folder (a Scrivener draft, a folder of chapters) is the story itself.
  const ms = roots.filter(manuscript)
  if (ms.length === 1 && ms[0].kind === 'folder') { title ||= ms[0].title; roots = [...roots.filter(x => x !== ms[0]), ...(ms[0].children || [])] }
  else if (ms.length === 1) title ||= ms[0].title
  const push = (t: string, items: PlanItem[], into?: string) => { if (items.length) plan.stories.push({ title: t, into, items }) }
  if (o.as === 'stories') {
    const loose: ImportNode[] = []
    for (const n of roots) {
      if (!manuscript(n)) loose.push(n)
      else push(n.title, n.kind === 'folder' ? build(n.children || [], 'story', [n.title]) : build([n], 'story', []))
    }
    build(loose, 'story', [])
  } else if (o.as === 'story') push(title || 'Untitled story', build(roots, 'story', []))
  else push(title, build(roots, 'story', [], true), o.as)
  if (sheets.length) { const p = planImport(sheets, types); plan.entities = p.entities; if (JSON.stringify(p.types) !== JSON.stringify(types)) plan.types = p.types }
  return plan
}

export const researchType = (mime: string, name: string): ResearchType =>
  mime === 'application/pdf' ? 'pdf' : mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : /\.(txt|md|markdown)$/i.test(name) ? 'note' : 'file'

/** A sensible title for a new story from several documents: their shared name ("Low Tide 01", "Low Tide 02" → "Low Tide"). */
export function commonTitle(nodes: ImportNode[]): string {
  const ms = nodes.filter(manuscript)
  if (ms.length === 1) return ms[0].title
  const ts = ms.map(n => n.title)
  let p = ts[0] || ''
  for (const t of ts) while (p && !t.startsWith(p)) p = p.slice(0, -1)
  p = p.replace(/[\s\d._:,-]+$/, '').trim()
  return p.length > 2 && !/^(part|chapter|scene|ch|book|draft|untitled)$/i.test(p) ? p : 'Untitled story'
}

const KNOWN_STATUS: [RegExp, string][] = [
  [/^(to ?do|not started|idea|planned|outlined?)$/i, 'todo'], [/^((first|rough) )?draft(ed)?$/i, 'draft'],
  [/^(revised( draft)?|second draft|edited|in revision)$/i, 'revised'], [/^(final( draft)?|done|complete(d)?|finished)$/i, 'final'],
]
const STATUS_COLORS = ['var(--l-purple)', 'var(--l-orange)', 'var(--l-red)', 'var(--l-green)', 'var(--l-blue)', 'var(--l-yellow)']
/** Scrivener's label and status names onto the project's: a label takes the colour already named so, or the next unnamed one
 * (none left: it becomes a tag); a status matches by name, then Scrivener's usual names, else it is added. */
export function mapMeta(labels: string[], statuses: string[], p: { labels?: Record<string, string>; statuses?: StatusDef[] }) {
  const names = { ...(p.labels || {}) }, labelOf: Record<string, string | undefined> = {}
  for (const l of labels) {
    let c: string | undefined = LABELS.find(k => (names[k] || '').trim().toLowerCase() === l.toLowerCase())
    if (!c) { c = LABELS.find(k => !names[k]?.trim()); if (c) names[c] = l }
    labelOf[l] = c
  }
  const list = [...(p.statuses?.length ? p.statuses : STATUSES)], statusOf: Record<string, string> = {}
  for (const n of statuses) {
    let st = list.find(x => x.label.toLowerCase() === n.toLowerCase().trim())
    const known = KNOWN_STATUS.find(([re]) => re.test(n.trim()))?.[1]
    if (!st && known) st = list.find(x => x.id === known)
    if (!st) { let id = slug(n); while (list.some(x => x.id === id)) id += '-2'; st = { id, label: n.trim(), color: STATUS_COLORS[list.length % STATUS_COLORS.length] }; list.push(st) }
    statusOf[n] = st.id
  }
  const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)
  return { labelOf, statusOf, labels: changed(names, p.labels || {}) ? names : undefined, statuses: changed(list, p.statuses?.length ? p.statuses : STATUSES) ? list : undefined }
}

type Rec = { kind: Kind; id: string; data: Record<string, unknown> }
/** The records a plan becomes in this project, the project changes it needs, and where to go afterwards. `stored`: picked path → stored file name. */
export function planRecords(plan: TreePlan, s: State, stored: Record<string, string> = {}) {
  const recs: Rec[] = []
  const add = (kind: Kind, data: object, id = uid(kind)) => { recs.push({ kind, id, data: data as Record<string, unknown> }); return id }
  const m = mapMeta(plan.labels, plan.statuses, s.recs.project ? project(s) : {})
  const ids = (m.statuses || (s.recs.project ? project(s).statuses : undefined) || STATUSES).map(x => x.id)
  const fallback = (prose: string) => (prose.trim() ? (ids.includes('draft') ? 'draft' : ids[1] || ids[0]) : ids.includes('todo') ? 'todo' : ids[0])
  let storyOrder = nextOrder(stories(s)), first = ''
  for (const st of plan.stories) {
    const story = st.into || add('story', { title: st.title, order: storyOrder++, form: 'prose', premise: '', beats: [] })
    first ||= story
    let order = st.into ? nextOrder(flowOf(s, story)) : 1
    for (const it of st.items) {
      if (it.kind !== 'scene') { add('section', newSection(story, order++, { type: it.kind, title: it.title, synopsis: it.synopsis, ...(it.exclude ? { exclude: true } : {}) })); continue }
      const color = it.label ? m.labelOf[it.label] : undefined
      const tags = [...it.tags, ...(it.label && !color ? [it.label] : [])]
      const id = add('scene', newScene(story, order++, {
        title: it.title, prose: it.prose, card: it.card, pinned: !!it.prose.trim(), status: it.status ? m.statusOf[it.status] : fallback(it.prose),
        ...(color ? { label: color } : {}), ...(tags.length ? { tags } : {}), ...(it.exclude ? { exclude: true } : {}),
      }))
      if (it.notes.trim()) add('note', newNote(id, { text: it.notes, by: 'you' }))
    }
  }
  for (const r of plan.research) {
    const f = r.file && stored[r.file.path]
    if (r.file && !f) continue
    add('research', newResearch({ title: r.title, type: r.type, text: r.text, ...(r.folder ? { folder: r.folder } : {}), ...(f ? { file: f, mime: r.file!.mime, size: r.file!.size } : {}) }))
  }
  for (const e of plan.entities) add('entity', { ...e, relations: [] })
  const patch: Record<string, unknown> = {}
  if (m.labels) patch.labels = m.labels
  if (m.statuses) patch.statuses = m.statuses
  if (plan.types) patch.types = plan.types
  const open = first ? 'story/' + first : plan.research.length ? 'research' : plan.entities.length ? 'world' : 'home'
  return { recs, patch, open }
}

/** Plan totals for the preview. */
export function countPlan(plan: TreePlan) {
  const items = plan.stories.flatMap(st => st.items), scenes = items.filter((x): x is PlanScene => x.kind === 'scene')
  return {
    stories: plan.stories.filter(x => !x.into).length, parts: items.filter(x => x.kind === 'part').length, chapters: items.filter(x => x.kind === 'chapter').length,
    scenes: scenes.length, words: scenes.reduce((n, x) => n + countWords(x.prose), 0), files: plan.research.filter(r => r.file).length,
    notes: plan.research.filter(r => !r.file).length, sheets: plan.entities.length,
  }
}
const countWords = (t: string) => { let n = 0; for (const w of t.match(/\S+/g) || []) if (/[\p{L}\p{N}]/u.test(w)) n++; return n }

/** Write a plan: research files are copied into the project, then everything lands as one undo step
 * ("Import Low Tide"), or as the project's starting point when there is no project yet. Returns the route to open. */
export async function runImport(plan: TreePlan, name: string): Promise<string> {
  const paths = plan.research.flatMap(r => (r.file ? [r.file.path] : []))
  let stored: Record<string, string> = {}
  if (paths.length) {
    const r = await fetch('/api/import/store', { method: 'POST', body: JSON.stringify({ paths }) })
    if (!r.ok) throw new Error(await r.text())
    stored = await r.json()
  }
  const s = getState(), { recs, patch, open } = planRecords(plan, s, stored)
  if (!s.recs.project) {
    recs.push({ kind: 'project', id: 'project', data: { ...emptyProject(plan.types), title: plan.stories[0]?.title || name || 'Untitled project', ...patch } })
    await baseline(recs)
  } else {
    tx(`Import ${name}`, () => {
      if (Object.keys(patch).length) update<'project'>('project', x => { Object.assign(x, patch) })
      for (const r of recs) create(r.kind, r.data as never, r.id)
    })
  }
  return open
}
