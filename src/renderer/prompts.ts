import {
  type State, type Story, type Scene, type Entity, type Fact, type Question, type Proposal, type Message, type Kind,
  project, stories, events, plainFacts, entities, scenesOf, list, get, nameOf, eventCode, uid, typeDef, typesOf, position, readerLearns,
  guidesFor, bannedPhrases, notesFor, nextAt, newScene, newFact, newQuestion, newEntityData, sceneRef, type GuideKind,
} from './store.ts'
import { sha256 } from './ai.ts'

const section = (title: string, body: string) => (body.trim() ? `\n\n# ${title}\n\n${body.trim()}` : '')
const bullets = (xs: string[]) => xs.filter(Boolean).map(x => `- ${x}`).join('\n')

// ---------------- canon rendering ----------------

export function projectBlock(s: State) {
  const p = project(s)
  return [`Project: ${p.title}`, p.logline && `Logline: ${p.logline}`, p.thesis && `Thesis: ${p.thesis}`].filter(Boolean).join('\n')
}

export function entityText(s: State, e: Entity, full = true) {
  const def = typeDef(s, e.type)
  const fields = def.fields.filter(f => e.fields[f.key]?.trim()).map(f => `${f.label}: ${e.fields[f.key].trim()}`)
  const extra = Object.entries(e.fields).filter(([k, v]) => v?.trim() && !def.fields.some(f => f.key === k)).map(([k, v]) => `${k}: ${v}`)
  const rel = e.relations.map(r => `${nameOf(s, r.to)}${r.label ? ` (${r.label})` : ''}`).filter(Boolean)
  return [
    `## ${e.name} [${e.id}] · ${def.one}${e.aliases.length ? ` · also: ${e.aliases.join(', ')}` : ''}`,
    e.summary, ...(full ? [...fields, ...extra] : fields.slice(0, 6)), rel.length ? `Related: ${rel.join(', ')}` : '',
    full && e.notes.trim() ? `Notes:\n${e.notes.trim()}` : '',
  ].filter(Boolean).join('\n')
}

const qLine = (q: Question) => `${q.type === 'question' ? 'Open question' : q.type === 'hole' ? 'Plot hole' : 'Contradiction'}: ${q.text} → ${q.answer ? `DECIDED: ${q.answer}` : 'UNDECIDED. Do not resolve it.'}`

/** The timeline: events in world order with causes; optionally how a story touches each. */
export function eventsBlock(s: State, only?: string[], story?: Story) {
  return events(s).filter(e => !only || only.includes(e.id)).map(e => {
    const scs = story ? scenesOf(s, story.id).filter(sc => sc.links[e.id]) : []
    const how = story ? (scs.length ? scs.map(sc => `${sc.title} (${sc.links[e.id] === 'on' ? 'on the page' : 'felt: the effect, the cause stays off the page'})`).join('; ') : '') : ''
    const qs = list(s, 'question').filter(q => q.about.includes(e.id) && !q.dismissed).map(q => '  ' + qLine(q))
    return [`- ${eventCode(s, e.id)} ${e.text} [${e.id}]${e.detail ? `: ${e.detail}` : ''}`, e.causes.length ? `  Caused by: ${e.causes.map(c => eventCode(s, c)).join(', ')}` : '', how && `  In this story: ${how}`, ...qs].filter(Boolean).join('\n')
  }).join('\n')
}

const KSAY = (c: { state: string; note?: string }) => ({ knows: 'knows', almost: `almost realizes${c.note ? ` (${c.note})` : ''}, never quite`, believes: `believes something else${c.note ? `: ${c.note}` : ''}`, never: 'never knows. Must not reveal or imply it.' } as Record<string, string>)[c.state]

/** What one entity knows at a point in reading order (later knowledge doesn't leak backward). */
export function knowledgeBlock(s: State, who?: string, asOf?: string) {
  if (!who) return ''
  const now = asOf ? position(s, asOf) : Infinity
  return list(s, 'fact').map(f => {
    const c = f.knows[who]
    const label = (f.at !== undefined ? eventCode(s, f.id) + ' ' : '') + f.text
    if (!c?.state) return f.at === undefined ? `- ${label}: UNDECIDED. Keep it ambiguous.` : ''
    if (c.state !== 'never' && c.from && position(s, c.from) > now) return `- ${label}: does NOT know yet. Must not reveal or imply it.`
    return `- ${label}: ${KSAY(c)}`
  }).filter(Boolean).join('\n')
}

function factsDigest(s: State) {
  return plainFacts(s).map(f => {
    const who = Object.entries(f.knows).filter(([, c]) => c.state).map(([k, c]) => `${nameOf(s, k)} ${c.state}${c.from ? ` from ${nameOf(s, c.from)}` : ''}`).join('; ')
    const r = readerLearns(s, f.id)
    return `- ${f.text} [${f.id}]${f.detail ? `: ${f.detail}` : ''}${who ? ` · ${who}` : ''}${r ? ` · reader learns in ${sceneRef(s, r)}` : ''}`
  }).join('\n')
}

/** Scopes that apply to a scene: the project, its story, its form, its POV and cast and their types. */
function scopesFor(s: State, story?: Story, scene?: Scene) {
  const ents = [story?.pov, ...(scene?.cast || [])].filter(Boolean) as string[]
  return ['project', story && `story:${story.id}`, story?.form === 'documents' && 'form:documents',
    ...ents.map(k => `entity:${k}`), ...ents.map(k => get(s, k, 'entity')?.type).filter(Boolean).map(t => `type:${t}`)].filter(Boolean) as string[]
}
function guideText(s: State, scopes: string[], kind: GuideKind, skipProjectStyle = false) {
  return scopes.flatMap(sc => guidesFor(s, sc, kind).filter(g => !(skipProjectStyle && sc === 'project'))).map(g => (kind === 'rule' ? `- ${g.text}` : `## ${g.title}\n\n${g.text}`)).join(kind === 'rule' ? '\n' : '\n\n')
}

/** A compact overview of the whole canon with record ids, for assistant-style prompts. */
export function canonDigest(s: State, full = false) {
  return section('Project', projectBlock(s))
    + section('Entities', entities(s).map(e => entityText(s, e, full)).join('\n\n'))
    + section('Timeline (events, world order)', eventsBlock(s))
    + section('Facts and who knows them', factsDigest(s))
    + section('Stories (reading order)', stories(s).map((st, i) => `${i + 1}. ${st.title} [${st.id}] · ${st.form}${st.pov ? ` · POV ${nameOf(s, st.pov)}` : ''}: ${st.premise}\n${scenesOf(s, st.id).map((sc, j) => `   ${j + 1}. ${sc.title} [${sc.id}]: ${sc.card}`).join('\n')}`).join('\n'))
    + section('Questions', list(s, 'question').filter(q => !q.dismissed).map(q => `- [${q.id}] ${qLine(q)}`).join('\n'))
    + section('Project rules', guideText(s, ['project'], 'rule'))
}

// ---------------- proposals ----------------

/** How the AI should phrase canon changes. Field keys come from the project's own entity types. */
export function proposalFormat(s: State, edits = false) {
  const types = typesOf(s)
  const fieldList = Object.entries(types).map(([id, t]) => `${id}: ${t.fields.map(f => f.key).join(', ')}`).join('; ')
  return `Each proposal is one JSON object:
{"op":"update","id":"<existing record id>","set":{"<field path>": <value>},"why":"<one sentence>"}
{"op":"create","kind":"entity|fact|question|scene|guide","data":{...},"why":"<one sentence>"}${edits ? `
{"op":"edit","id":"<scene id>","find":"<exact passage from the scene, long enough to be unique>","replace":"<new passage>","why":"<one sentence>"}  (to change prose; keep each edit to a sentence or paragraph)` : ''}
Field paths: entity "summary", "name", "fields.<key>" (keys per type: ${fieldList}); fact "text", "detail", "knows.<entity id>"; question "answer"; scene "title", "card", "wants", "mustLand".
Create data: entity {"type":"${Object.keys(types).join('|')}","name":"","summary":"","fields":{}}; fact {"text":"short statement","detail":"","event":true|false,"causes":[event ids],"knows":{"<entity id>":{"state":"knows|almost|believes|never","from":"<story or scene id>","note":""}}} (event true = it happens at a point in time, after the existing events); question {"type":"question|hole|contradiction","text":"","about":[record ids]}; scene {"story":"<story id>","after":"<scene id or empty for first>","title":"","card":"","wants":""}; guide {"use":"style|rule|banned","scope":"project|story:<id>|entity:<id>|type:<id>","title":"","text":""}.
Use only ids that appear in the canon. Keep values in the author's register: concrete, terse.`
}

/** Fill required defaults so an AI-created record always has the full shape. */
export function normalizeProposal(s: State, p: Proposal): Proposal {
  if (p.op !== 'create' || !p.kind || !p.data) return p
  const newId = p.newId || uid(p.kind)
  const d = { ...p.data } as Record<string, unknown>
  const defaults: Partial<Record<Kind, Record<string, unknown>>> = {
    entity: { ...newEntityData('character', 'Unnamed') },
    question: { ...newQuestion({ by: 'ai' }) },
    fact: { ...newFact() },
    guide: { use: 'rule', scope: 'project', title: 'Rule', text: '' },
    scene: { ...newScene('', 0) },
  }
  if (p.kind === 'fact') { if (d.event) d.at = nextAt(s); delete d.event }
  const data = { ...defaults[p.kind], ...d }
  if (p.kind === 'scene') { // place after the given scene using a fractional order
    const scs = scenesOf(s, String(data.story))
    const i = scs.findIndex(x => x.id === data.after)
    const a = i >= 0 ? scs[i].order : 0, b = scs[i + 1]?.order ?? a + 2
    data.order = (a + b) / 2
    delete data.after
  }
  return { ...p, data, newId }
}

export function parseProposals(s: State, text: string): Proposal[] {
  const block = text.match(/```(?:proposals|json)?\s*(\[[\s\S]*?\])\s*```/)
  const raw = block ? block[1] : text.trim().startsWith('[') ? text.trim() : ''
  if (!raw) return []
  try { return (JSON.parse(raw) as Proposal[]).filter(p => p && ['update', 'create', 'edit'].includes(p.op)).map(p => normalizeProposal(s, p)) } catch { return [] }
}
export const stripProposals = (text: string) => text.replace(/```(?:proposals|json)?\s*\[[\s\S]*?\]\s*```/g, '').trim()

/** Human summary of a proposal for cards. */
export function describe(s: State, p: Proposal) {
  if (p.op === 'edit') return { title: `Edit in “${nameOf(s, p.id)}”`, body: `${p.find} → ${p.replace}` }
  if (p.op === 'create') {
    const d = p.data as Record<string, string>
    const what = p.kind === 'fact' ? ((p.data as { at?: number }).at !== undefined ? 'event' : 'fact') : p.kind
    return { title: `New ${what}: ${d.name || d.title || d.text || ''}`, body: d.summary || d.card || d.detail || (p.kind === 'guide' ? d.text : '') || '' }
  }
  return { title: nameOf(s, p.id) || String(p.id), body: Object.entries(p.set || {}).map(([k, v]) => `${k.replace('fields.', '').replace(/^knows\.(.+)$/, (_, id) => `${nameOf(s, id)} knows`)} → ${typeof v === 'string' ? v : Array.isArray(v) && v.every(x => typeof x === 'string') ? v.join(' · ') : JSON.stringify(v)}`).join('\n') }
}

// ---------------- builds ----------------

function storyOutline(s: State, story: Story, current?: Scene) {
  return [
    `Title: ${story.title}`, story.pov ? `POV: ${nameOf(s, story.pov)}` : '', story.premise ? `Premise: ${story.premise}` : '',
    story.beats.length ? `Beat pattern: ${story.beats.join(' → ')}` : '', '', 'Scenes:',
    ...scenesOf(s, story.id).map((sc, i) => `${i + 1}. ${sc.id === current?.id ? '[THIS SCENE] ' : ''}${sc.beat ? `(${sc.beat}) ` : ''}${sc.title}: ${sc.card}`),
  ].filter(l => l !== '').join('\n')
}

function cardBlock(s: State, scene: Scene) {
  const meta = (project(s).sceneFields || []).filter(f => scene.meta?.[f.key]).map(f => `${f.label}: ${scene.meta![f.key]}`)
  return [`Title: ${scene.title}`, scene.beat && `Beat: ${scene.beat}`, `What happens: ${scene.card}`, scene.wants && `What each person wants here: ${scene.wants}`,
    scene.mustLand.filter(Boolean).length ? `Must land:\n${bullets(scene.mustLand)}` : '', ...meta].filter(Boolean).join('\n')
}

function sceneContext(s: State, story: Story, scene: Scene) {
  const scs = scenesOf(s, story.id)
  const prev = scs[scs.findIndex(x => x.id === scene.id) - 1]?.prose
  const cast = [...new Set([story.pov, ...scene.cast].filter(Boolean) as string[])].map(id => get(s, id, 'entity')).filter(Boolean) as Entity[]
  const linked = Object.keys(scene.links)
  const reveals = plainFacts(s).filter(f => scene.links[f.id]).map(f => `- ${f.text}${f.detail ? `: ${f.detail}` : ''} (${scene.links[f.id] === 'on' ? 'revealed on the page' : 'hinted, never stated'})`)
  return section('Project', projectBlock(s))
    + section('Background (structured canon below overrides it)', project(s).background)
    + section('People, places and things in this scene', cast.map(e => entityText(s, e)).join('\n\n'))
    + section('Events this scene touches', eventsBlock(s, linked.filter(id => get(s, id, 'fact')?.at !== undefined), story))
    + section('Facts this scene reveals', reveals.join('\n'))
    + section(`What ${story.pov ? nameOf(s, story.pov) : 'the POV'} knows at this point`, knowledgeBlock(s, story.pov, scene.id))
    + section('Story outline', storyOutline(s, story, scene))
    + section('End of the previous scene (for continuity)', prev ? prev.slice(-6000) : '')
}

export function buildScene(s: State, story: Story, scene: Scene) {
  const docs = story.form === 'documents'
  const scopes = scopesFor(s, story, scene)
  const banned = bannedPhrases(s)
  const system = (docs
    ? 'You produce in-world documents (notices, memos, listings, reports) for a work of fiction. The author writes the parameters; you render one document that honors every parameter. Output only the document text.'
    : 'You are the prose engine for a work of fiction. The author shapes the parameters: project, entities, events, knowledge boundaries, scene cards. Render one scene as finished prose that honors every parameter, especially knowledge boundaries. Output only the scene prose: no title, no notes, no markdown headings.')
    + section('Style guide', guideText(s, scopes, 'style', docs))
    + section('Rules from the author', guideText(s, scopes, 'rule'))
    + section('Never use these phrases', banned.map(b => `"${b}"`).join(', '))
  return { system, prompt: sceneContext(s, story, scene) + section(docs ? 'Document to write' : 'Scene to write', cardBlock(s, scene)) }
}

export const inputHash = (s: State, story: Story, scene: Scene) => {
  const { system, prompt } = buildScene(s, story, scene)
  return sha256(system + '\n\u0000\n' + prompt)
}

export function directPassage(s: State, story: Story, scene: Scene, start: number, end: number, direction: string) {
  const { system } = buildScene(s, story, scene)
  const marked = scene.prose.slice(0, start) + '<<<SELECTED>>>' + scene.prose.slice(start, end) + '<<<END>>>' + scene.prose.slice(end)
  return {
    system: system + '\n\nYou are now revising. Rewrite ONLY the passage between <<<SELECTED>>> and <<<END>>> following the author\'s direction. It must flow into the surrounding text. Return only the replacement passage, without markers or commentary.',
    prompt: sceneContext(s, story, scene) + section('Scene card', cardBlock(s, scene)) + section('Current scene text', marked) + section('Direction', direction),
  }
}

export function deriveCard(s: State, story: Story, scene: Scene) {
  return {
    system: 'You reverse-engineer scene cards from finished prose for a fiction-writing tool. Be concrete and terse. Reply with JSON only.',
    prompt: section('Events', events(s).map(e => `${e.id}: ${eventCode(s, e.id)} ${e.text}. ${e.detail}`).join('\n'))
      + section('Facts', plainFacts(s).map(f => `${f.id}: ${f.text}`).join('\n'))
      + section('Entities (id: name)', entities(s).map(e => `${e.id}: ${e.name}`).join('\n'))
      + section('Story beats', story.beats.join(', '))
      + section('Scene prose', scene.prose)
      + section('Reply format', '{"title": "2-4 words", "beat": "one of the story beats or empty", "card": "what happens and what changes, 1-2 sentences", "wants": "what each person present wants in this scene", "mustLand": ["2-4 concrete things the scene must deliver"], "links": {"<event or fact id>": "on|felt"}, "cast": ["entity ids present or named: people, places, groups, things"]}'),
  }
}

export function critiqueScene(s: State, story: Story, scene: Scene) {
  const { system } = buildScene(s, story, scene)
  return {
    system: system + '\n\nYou are now an editor, not the writer. Critique the scene against its card, the project, the style guide, the voice and the knowledge boundaries. Be specific and brief; skip praise. Reply with JSON only: [{"topic":"card|voice|pacing|canon|style|knowledge","text":"the problem and the smallest fix","quote":"exact short quote from the scene, or empty"}], at most 6 items, most important first.',
    prompt: sceneContext(s, story, scene) + section('Scene card', cardBlock(s, scene)) + section('Scene text', scene.prose),
  }
}

export function continuityCheck(s: State, story: Story) {
  const scs = scenesOf(s, story.id)
  const custom = list(s, 'guide').filter(g => g.use === 'check').map(g => g.text).join('\n\n')
  return {
    system: (custom || 'Review the prose for continuity errors, knowledge leaks, inconsistent details and canon violations.')
      + '\n\nAll project knowledge is included in the message; you cannot read files.'
      + '\n\nOutput format (overrides any format above): reply with a JSON array only. Problems in the prose: {"severity":"critical|error|warning|note","scene":<scene number>,"quote":"<short exact quote>","problem":"<what is wrong and which canon it breaks>","fix":"<smallest fix>"}. Problems in the canon itself (two records that contradict each other, a gap in cause and effect): {"canon":"hole|contradiction","problem":"","about":["record ids"]}. Reply [] if there are no problems.',
    prompt: canonDigest(s, true) + section('Background', project(s).background)
      + section(`Story under review: ${story.title}`, scs.map((sc, i) => `[Scene ${i + 1}: ${sc.title}]\n${sc.prose}`).join('\n\n')),
  }
}

// ---------------- the feedback loop: questions ----------------

const assist = (task: string) => `You help an author craft a work of fiction (one or more connected stories). The author decides; you propose. ${task}`

export function questionOptions(s: State, q: Question) {
  return {
    system: assist(`Offer distinct ways to resolve a ${q.type === 'question' ? 'open question' : q.type === 'hole' ? 'plot hole' : 'contradiction'} that fit the canon and the project. Each option comes with the proposals that would write it into the canon. Reply with JSON only.\n\n${proposalFormat(s)}`),
    prompt: canonDigest(s) + section('Background', project(s).background)
      + section('To resolve', `${q.text}\nAbout: ${q.about.map(id => `${nameOf(s, id)} [${id}]`).join(', ') || 'the whole project'}`)
      + section('Reply format', '[{"title": "short option name", "detail": "one or two sentences: what happens and what it does for the story", "proposal": {one proposal, or omit if it needs no canon change}}] with exactly 3 options'),
  }
}

/** After the author decides, turn the decision into canon changes. */
export function resolveQuestion(s: State, q: Question) {
  return {
    system: assist(`The author has resolved a question about their canon. Propose the smallest set of canon changes that write the decision in: field updates, new facts or events, knowledge changes, guide rules. Skip anything already true. Reply with a JSON array of proposals only (may be empty).\n\n${proposalFormat(s)}`),
    prompt: canonDigest(s, true) + section('Question', `${q.text}\nAbout: ${q.about.map(id => `${nameOf(s, id)} [${id}]`).join(', ')}`) + section('Decision', q.answer),
  }
}

export interface FoundQ { kind: 'question' | 'hole' | 'contradiction'; text: string; about: string[]; options: { title: string; detail: string; proposal?: Proposal }[] }
/** Look for plot holes, contradictions and open questions; across the canon, or around one record. */
export function findProblems(s: State, focusId?: string) {
  const rec = focusId ? s.recs[focusId] : undefined
  const focus = !rec ? '' : rec.kind === 'entity' ? entityText(s, rec) : rec.kind === 'fact' ? (rec.at !== undefined ? eventsBlock(s, [rec.id]) : `${rec.text}: ${rec.detail}`) : rec.kind === 'story' ? storyOutline(s, rec) : ''
  return {
    system: assist(`Find the weakest points ${rec ? 'around one part of the canon' : 'in the canon'}: plot holes (an effect without a cause, a choice that is too convenient, motivation that doesn't hold), contradictions (two records that can't both be true), and open questions the reader will ask that the canon doesn't answer. At most 5, most important first. Skip anything already listed under Questions. For each, offer 2-3 concrete resolutions; each comes with one proposal that writes it into the canon. Reply with JSON only: [{"kind":"hole|contradiction|question","text":"the problem, one or two sentences","about":["record ids"],"options":[{"title":"","detail":"","proposal":{...}}]}].\n\n${proposalFormat(s)}`),
    prompt: canonDigest(s) + section('Background', project(s).background) + (focus ? section('Focus on this', focus) : ''),
  }
}

export function suggestScenes(s: State, story: Story) {
  return {
    system: assist(`Propose up to 4 new scene cards that the story is missing: uncovered beats, events with no scene that shows them, setups for later payoffs, or quieter scenes the story needs before its turns. Reply with a JSON array of proposals only.\n\n${proposalFormat(s)}`),
    prompt: canonDigest(s) + section('Story to extend', storyOutline(s, story) + `\nStory id: ${story.id}`),
  }
}

export function fillGaps(s: State, e: Entity, only?: string) {
  const def = typeDef(s, e.type)
  const empty = def.fields.filter(f => (only ? f.key === only : !e.fields[f.key]?.trim())).map(f => `${f.key} (${f.label}${f.hint ? `: ${f.hint}` : ''})`)
  return {
    system: assist(only
      ? `Offer 3 distinct values for one field of a ${def.one.toLowerCase()}, each consistent with the canon. Reply with a JSON array of 3 update proposals for that field only; "why" says what each choice does for the story.\n\n${proposalFormat(s)}`
      : `Fill the empty fields of one ${def.one.toLowerCase()} from what the canon already implies (the background, the notes, other entities, events). Only propose a value when the canon supports it; mark inventions in "why". Also propose a one-sentence "summary" if it's empty or weak. Reply with a JSON array of update proposals only.\n\n${proposalFormat(s)}`),
    prompt: canonDigest(s) + section('Background', project(s).background) + section('Entity', entityText(s, e)) + section(only ? 'Field' : 'Empty fields', empty.join('\n') || 'none; suggest improvements to thin fields instead'),
  }
}

export function draftEntity(s: State, type: string, idea: string) {
  return {
    system: assist(`Draft one new ${type} for the canon from the author's idea, consistent with the project. Reply with a JSON array containing one create proposal (kind "entity", type "${type}") with name, summary and as many fields as the idea supports.\n\n${proposalFormat(s)}`),
    prompt: canonDigest(s) + section('Idea', idea),
  }
}

export function projectFromBackground(s: State) {
  const p = project(s)
  const empty = (['logline', 'thesis'] as const).filter(k => !p[k])
  return {
    system: assist(`Extract the project's core parameters from the author's background notes. Reply with a JSON array of proposals: one update {"op":"update","id":"project","set":{${empty.map(k => `"${k}": "one sentence"`).join(', ')}}} if any of those fields are empty, plus up to 3 guide creates (kind "style", scope "project") for tone, motifs and writing conventions the notes state. Use the notes' own words.\n\n${proposalFormat(s)}`),
    prompt: section('Background', p.background) + section('Existing project guides', guidesFor(s, 'project').map(g => `${g.title}: ${g.text.slice(0, 200)}`).join('\n')),
  }
}

export function suggestFacts(s: State) {
  return {
    system: assist(`Find dramatic-irony facts the canon is missing: secrets, misbeliefs, things the reader learns before or after a character. Reply with a JSON array of up to 5 create proposals (kind "fact", event false) with "knows" for the relevant characters.\n\n${proposalFormat(s)}`),
    prompt: canonDigest(s, true) + section('Background', project(s).background),
  }
}

// ---------------- conversations ----------------

export function interviewSystem(s: State, e: Entity, asOf?: string) {
  return `You are ${e.name}, a character in a work of fiction. The author is interviewing you to discover who you are. Stay fully in character: answer in your own voice, from your own point of view, with your own evasions. You only know what you would know${asOf ? ` as of "${nameOf(s, asOf)}"` : ''}. You may improvise small new details consistent with the canon; the author decides what becomes true. Keep answers short (under 150 words) unless asked to go on. Occasional stage directions in *italics* are fine.`
    + section('Who you are', entityText(s, e))
    + section('Your voice', guideText(s, [`entity:${e.id}`], 'style'))
    + section('What you know', knowledgeBlock(s, e.id, asOf))
    + section('People and places around you', e.relations.map(r => get(s, r.to, 'entity')).filter(Boolean).map(x => entityText(s, x as Entity, false)).join('\n\n'))
    + section('Project', projectBlock(s))
    + section('Background (for your world; do not quote it)', project(s).background)
}

export function discoveries(s: State, e: Entity, messages: Message[]) {
  return {
    system: assist(`From an interview transcript with a character, extract what's NEW: details, motives, secrets or relationships that aren't in the canon yet. Propose them as updates to the character's fields (append to existing text rather than replacing it), new facts, or open questions. Skip anything already in the canon. Reply with a JSON array of proposals only (may be empty).\n\n${proposalFormat(s)}`),
    prompt: section('Character', entityText(s, e)) + section('Canon', canonDigest(s))
      + section('Transcript', messages.map(m => `${m.role === 'user' ? 'Author' : e.name}: ${m.text}`).join('\n\n')),
  }
}

export function directorSystem(s: State, context: string) {
  return assist(`You are the writing assistant: the author's collaborator inside Canon. Answer questions about the canon, brainstorm, critique, and propose concrete changes. Be brief and specific. When a change would help, end your reply with a fenced \`\`\`proposals block containing a JSON array of proposals. To change prose, use "edit" proposals: the author sees them as tracked changes in the text. When you notice a plot hole, contradiction or open question, propose creating a question record rather than silently fixing it. Don't propose changes the author didn't ask for unless they clearly fix a problem.\n\n${proposalFormat(s, true)}`)
    + canonDigest(s) + section('Background', project(s).background) + section('The author is looking at', context)
}

/** What the assistant sees of the current screen, plus records the author pinned to the context. */
export function screenContext(s: State, route: string, pinned: string[] = []) {
  const [view, a, b] = route.split('/')
  const out: string[] = []
  if (view === 'write') {
    const sc = get(s, b, 'scene'), st = get(s, a, 'story')
    if (st) out.push(`Story "${st.title}" [${st.id}]`)
    if (sc) {
      const notes = notesFor(s, sc.id).filter(n => !n.done).map(n => `- ${n.quote ? `“${n.quote}”: ` : ''}${n.text}`)
      out.push(`Scene "${sc.title}" [${sc.id}]\nCard: ${sc.card}\nMust land: ${sc.mustLand.join('; ')}\n\nProse:\n${sc.prose.slice(0, 12000)}` + (notes.length ? `\n\nOpen notes on this scene:\n${notes.join('\n')}` : ''))
    }
  } else if (view === 'story') { const st = get(s, a, 'story'); if (st) out.push(storyOutline(s, st)) }
  else if (view === 'world') { const e = get(s, a, 'entity'); out.push(e ? entityText(s, e) : 'The world index.') }
  else if (view === 'timeline') { const f = get(s, a, 'fact'); out.push('The timeline (events × stories) and the knowledge grid.' + (f ? `\nSelected: ${nameOf(s, f.id)} [${f.id}]: ${f.detail}` : '')) }
  else if (view === 'questions') out.push('The questions inbox: open questions, plot holes, contradictions.')
  else out.push(view || 'home')
  for (const id of pinned) {
    const r = s.recs[id]
    if (!r) continue
    if (r.kind === 'entity') out.push(entityText(s, r))
    else if (r.kind === 'scene') out.push(`Scene "${r.title}" [${r.id}]: ${r.card}\n${r.prose.slice(0, 4000)}`)
    else if (r.kind === 'fact') out.push(`${nameOf(s, r.id)} [${r.id}]: ${r.detail}`)
    else out.push(`${nameOf(s, id)} [${id}]`)
  }
  return out.join('\n\n')
}

export type { Fact }
