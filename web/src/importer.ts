// Imports. importFiles: any .txt/.md files (stories split into scenes; files with frontmatter become entities).
// importCanonFolder: the -root folder layout (canon/*.json, characters/, worldbuilding/, writer-skill guides).
import { baseline, uid, getState, typesOf, create, update, tx, nextOrder, stories, emptyProject, newScene, newFact, newQuestion, newNote, type Kind, type Severity, type Link } from './store.ts'
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

/** Import files into the open project (undoable), or into a new one when there is none yet. */
export async function importFiles(files: File[], log: (msg: string) => void) {
  const texts = await Promise.all(files.filter(x => /\.(txt|md|markdown)$/i.test(x.name)).map(async x => ({ path: x.webkitRelativePath || x.name, text: await x.text() })))
  if (!texts.length) throw new Error('No .txt or .md files found.')
  const fresh = !getState().recs.project
  const plan = planImport(texts, fresh ? DEFAULT_TYPES : typesOf(getState()))
  const recs: { kind: Kind; id: string; data: Record<string, unknown> }[] = []
  const add = (kind: Kind, data: Record<string, unknown>) => { const id = uid(kind); recs.push({ kind, id, data }); return id }
  let order = fresh ? 0 : nextOrder(stories(getState())) - 1
  for (const st of plan.stories) {
    const id = add('story', { title: st.title, order: ++order, form: 'prose', premise: '', beats: [] })
    st.scenes.forEach((sc, i) => add('scene', newScene(id, i + 1, { title: sc.title, prose: sc.prose, pinned: true, status: 'draft' }) as never))
  }
  for (const e of plan.entities) add('entity', { ...e, relations: [] })
  log(`${plan.stories.length} stories (${plan.stories.reduce((n, x) => n + x.scenes.length, 0)} scenes), ${plan.entities.length} sheets`)
  if (fresh) {
    recs.push({ kind: 'project', id: 'project', data: { ...emptyProject(plan.types), title: plan.stories[0]?.title || 'Untitled project' } })
    await baseline(recs)
  } else {
    tx(`Import ${texts.length} file${texts.length === 1 ? '' : 's'}`, () => {
      if (JSON.stringify(plan.types) !== JSON.stringify(typesOf(getState()))) update<'project'>('project', x => { x.types = plan.types })
      for (const r of recs) create(r.kind, r.data as never, r.id)
    })
  }
}
