// A small but complete sample project, for screenshots and for trying Canon out:
// node scripts/seed.ts <data-dir>   (then start Canon with CANON_DATA_DIR=<data-dir>)
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../src/main/db.ts'

const day = (n: number) => new Date(Date.now() - n * 864e5).toLocaleDateString('sv')
const iso = (n: number) => new Date(Date.now() - n * 36e5).toISOString()

const P1 = `The harbour office smelled of wet wool and lamp oil, and of something under both that Ines had never been able to name. Her father's chair still held the shape of him. She did not sit in it.

The ledger lay where Tomas had said it would, wrapped in oilcloth at the back of the bottom drawer, behind the tide tables nobody had consulted since the new buoys went in. She unwrapped it slowly. The cover was soft with handling.

"You don't have to read it tonight," Tomas said from the doorway. He had not taken off his coat.

"Then why did you bring me here tonight?"

He didn't answer. Outside, the bell on the north marker rang twice and went quiet, the way it did when the water turned.`

const P2 = `The entries began in her father's hand, small and upright, every column ruled. Vessel, tonnage, master, cargo, fee. She knew the names of half the boats. The Agnes Ray. The Second Chance. The Merrow Belle, which had gone down off the point in the winter she turned nine.

Then, in the spring of that same year, a second hand appeared. Looser. Leaning. It recorded boats she had never heard of, arriving at night, paying fees that were far too large for their tonnage.

She turned the page toward the lamp. The second hand had written a name in the margin and then crossed it out so hard the nib had torn the paper.

What was left of it began with a D.`

const P3 = `Aunt Delphine poured the tea before Ines had taken off her boots, which meant she already knew why Ines had come.

"He kept it, then," Delphine said. "I told him to burn it."

"You knew."

"I knew there was a book. I never read it." She set the pot down. Her hands were steady. "Some things you leave in the drawer, love. Not because they're lies. Because they're true and there's nothing to be done with them."`

const records: { kind: string; id: string; data: Record<string, unknown> }[] = []
const add = (kind: string, id: string, data: Record<string, unknown>) => { records.push({ kind, id, data }); return id }

const types = {
  character: { label: 'Characters', one: 'Character', fields: [
    { key: 'role', label: 'Role', hint: 'protagonist, antagonist, supporting…', long: false }, { key: 'pronouns', label: 'Pronouns', hint: '', long: false },
    { key: 'wants', label: 'Wants', hint: 'What they consciously pursue', long: true }, { key: 'needs', label: 'Needs', hint: 'What they actually need, often against the want', long: true },
    { key: 'secret', label: 'Secret', hint: 'What they hide, and from whom', long: true }, { key: 'voice', label: 'Voice & dialogue style', hint: 'How they talk; what they never say', long: true },
    { key: 'background', label: 'Background', hint: 'Where they come from', long: true },
  ] },
  place: { label: 'Places', one: 'Place', fields: [{ key: 'description', label: 'Description', hint: 'What it is and what it is like', long: true }, { key: 'sensory', label: 'Sensory texture', hint: 'Sound, light, smell, temperature', long: true }] },
  object: { label: 'Objects', one: 'Object', fields: [{ key: 'description', label: 'What it is', hint: '', long: true }, { key: 'significance', label: 'Story significance', hint: 'Why the story needs it', long: true }] },
}

add('project', 'project', {
  title: 'Low Tide at Merrow', author: 'B. Nater', logline: 'A harbourmaster’s daughter finds the ledger her father kept for smugglers, and has to decide what the town is owed.',
  thesis: 'What we inherit includes what we were protected from.', background: 'Merrow is a fishing town on a tidal estuary. The harbour office records every vessel. The lighthouse was automated twenty years ago.',
  types, labels: { blue: 'Ines', purple: 'Delphine', green: 'Present day', orange: 'Flashback' }, target: 60000, sessionTarget: 800, deadline: day(-75), emDashCheck: true,
  scratch: 'Maybe the bell is the last scene. The north marker rings twice when the water turns.',
})

const ines = add('entity', 'ent_ines', { type: 'character', name: 'Ines Calder', aliases: ['Ines'], summary: 'The harbourmaster’s daughter, back in Merrow for the first time in eleven years.',
  fields: { role: 'protagonist', pronouns: 'she/her', wants: 'To close up her father’s house and leave by the end of the month.', needs: 'To stop treating Merrow as something that happened to her.', secret: 'She left the night of the Belle’s sinking and never told anyone she saw a second boat.', voice: 'Short sentences. Asks questions instead of answering them.' }, notes: '', relations: [{ to: 'ent_tomas', label: 'childhood friend' }, { to: 'ent_delphine', label: 'niece' }] })
const tomas = add('entity', 'ent_tomas', { type: 'character', name: 'Tomas Reyne', aliases: ['Tomas'], summary: 'Runs the estuary ferry. Knew Ines’s father better than she did.',
  fields: { role: 'supporting', pronouns: 'he/him', wants: 'For the ledger to be someone else’s problem.', secret: 'His father crewed one of the night boats.' }, notes: '', relations: [] })
const delphine = add('entity', 'ent_delphine', { type: 'character', name: 'Delphine Calder', aliases: ['Aunt Delphine', 'Delphine'], summary: 'Ines’s aunt. Has lived her whole life within sight of the lighthouse.',
  fields: { role: 'supporting', pronouns: 'she/her', voice: 'Calls everyone “love”. Never raises her voice.' }, notes: '', relations: [] })
add('entity', 'ent_office', { type: 'place', name: 'The Harbour Office', aliases: [], summary: 'One room above the fish market, with a window onto the channel.', fields: { sensory: 'Wet wool, lamp oil, the north marker bell.' }, notes: '', relations: [] })
add('entity', 'ent_light', { type: 'place', name: 'Merrow Light', aliases: ['the lighthouse'], summary: 'Automated, unvisited, still painted every spring.', fields: {}, notes: '', relations: [] })
const ledger = add('entity', 'ent_ledger', { type: 'object', name: 'The Ledger', aliases: [], summary: 'Her father’s harbour book, with a second set of entries in another hand.', fields: { significance: 'The proof, and the question of what proof is for.' }, notes: '', relations: [] })

const ev = (id: string, at: number, text: string, detail: string, causes: string[] = [], knows: Record<string, unknown> = {}) =>
  add('fact', id, { text, detail, at, causes, knows })
ev('ev1', 1, 'Night boats begin using Merrow', 'Unregistered boats land after dark; the fees go in a second set of columns.', [], { [tomas]: { state: 'knows' } })
ev('ev2', 2, 'The Merrow Belle sinks off the point', 'Four crew lost. The inquiry blames the weather.', ['ev1'], { [ines]: { state: 'almost', note: 'she saw a second boat' }, [delphine]: { state: 'believes', note: 'an accident' } })
ev('ev3', 3, 'Ines leaves Merrow', 'The same week. She doesn’t come back for eleven years.', ['ev2'])
ev('ev4', 4, 'Her father dies', 'Heart. Found at his desk in the harbour office.', [])
ev('ev5', 5, 'Tomas gives Ines the ledger', '', ['ev4'], { [ines]: { state: 'knows', from: 'st_ledger' } })
ev('ev6', 6, 'The town meeting about the old pier', 'Where Ines has to decide whether to speak.', ['ev5'])
add('fact', 'fact_d', { text: 'Delphine wrote the second hand', detail: '', causes: [], knows: { [delphine]: { state: 'knows' }, [ines]: { state: 'never' }, [tomas]: { state: 'believes', note: 'thinks it was his father' } } })

add('story', 'st_ledger', { title: 'The Ledger', order: 1, pov: ines, form: 'prose', premise: 'Ines comes home to bury her father and is handed the book he kept for the night boats.', beats: ['Arrival', 'Discovery', 'Pressure', 'Turn', 'Choice'], target: 9000 })
add('story', 'st_salt', { title: 'Salt Year', order: 2, pov: delphine, form: 'prose', premise: 'Delphine, the winter the Belle went down.', beats: ['Before', 'The night', 'After'] })
add('story', 'st_minutes', { title: 'Minutes of the Pier Committee', order: 3, form: 'documents', premise: 'The town meeting, as recorded.', beats: [] })

const sc = (id: string, story: string, order: number, title: string, card: string, prose: string, extra: Record<string, unknown> = {}) =>
  add('scene', id, { story, order, title, card, wants: '', mustLand: [], beat: '', cast: [], links: {}, prose, pinned: false, snapshots: [], status: prose ? 'draft' : 'todo', ...extra })
sc('sc1', 'st_ledger', 1, 'The office at night', 'Tomas brings Ines to the harbour office and shows her where the ledger is hidden. She asks why tonight; he won’t say.', P1,
  { beat: 'Arrival', cast: [ines, tomas, 'ent_office'], links: { ev5: 'on', ev4: 'felt' }, label: 'blue', status: 'revised', target: 1200, wants: 'Ines wants to get it over with. Tomas wants her to see it before the meeting.', mustLand: ['The bell rings twice when the water turns'] })
sc('sc2', 'st_ledger', 2, 'Two hands', 'Alone, Ines reads the ledger and finds the second hand, the night boats, and a crossed-out name beginning with D.', P2,
  { beat: 'Discovery', cast: [ines, ledger], links: { ev1: 'on', ev2: 'felt' }, label: 'blue', target: 1500 })
sc('sc3', 'st_ledger', 3, 'Tea at Delphine’s', 'Ines confronts Delphine, who admits she knew about the book but claims she never read it.', P3,
  { beat: 'Pressure', cast: [ines, delphine], links: { fact_d: 'felt' }, label: 'purple' })
sc('sc4', 'st_ledger', 4, 'The ferry crossing', 'Tomas tells Ines what his father did on the night boats. She tells him about the second boat.', '', { beat: 'Turn', cast: [ines, tomas], links: { ev2: 'on' } })
sc('sc5', 'st_ledger', 5, 'The pier meeting', '', '', { beat: 'Choice' })
sc('sc6', 'st_salt', 1, 'Lamp oil', 'Delphine fills the lamps in the office for her brother, and sees the first night boat come in.', '', { beat: 'Before', cast: [delphine], links: { ev1: 'on' }, label: 'orange' })
sc('sc7', 'st_salt', 2, 'The point', 'The night the Belle goes down, from the shore.', '', { beat: 'The night', cast: [delphine], links: { ev2: 'on' }, label: 'orange' })

add('question', 'q1', { type: 'contradiction', text: 'Delphine says she never read the ledger, but the crossed-out name starts with D and the second hand looks like hers.', about: [delphine, 'fact_d'], options: [
  { title: 'She’s lying', detail: 'She wrote the second hand herself and is protecting her brother’s memory.' },
  { title: 'It’s her husband', detail: 'Daniel Calder, who drowned on the Belle; the D is his.' },
], answer: '', by: 'check', at: iso(3) })
add('question', 'q2', { type: 'hole', text: 'Why does Tomas wait until the night before the pier meeting to hand over the ledger?', about: [tomas, 'ev5'], options: [], answer: '', by: 'ai', at: iso(5) })
add('question', 'q3', { type: 'question', text: 'Does Ines speak at the meeting?', about: ['ev6'], options: [], answer: '', by: 'you', at: iso(8) })
add('question', 'q4', { type: 'question', text: 'Who rings the bell?', about: [], options: [], answer: 'Nobody: it rings on its own when the tide turns. Keep it that way.', by: 'you', at: iso(30) })

add('guide', 'g1', { use: 'style', scope: 'project', title: 'House style', text: 'Close third person. Past tense. Weather is never a metaphor for feeling. Dialogue carries the subtext; narration doesn’t explain it.' })
add('guide', 'g2', { use: 'banned', scope: 'project', title: 'Banned phrases', text: 'a beat\nlet out a breath\nsomething shifted' })
add('guide', 'g3', { use: 'style', scope: 'entity:' + delphine, title: 'Voice', text: 'Warm, plain, final. Never asks a question she doesn’t know the answer to.' })

add('note', 'n1', { scene: 'sc1', quote: 'He had not taken off his coat.', text: 'Good: shows he’s not staying. Could we see him almost take it off?', by: 'ai', topic: 'Subtext', at: iso(2) })
add('note', 'n2', { scene: 'sc1', text: 'Opening line is doing too much. Try starting on the chair.', by: 'you', at: iso(20) })
add('note', 'n3', { scene: 'sc2', quote: 'What was left of it began with a D.', severity: 'warning', text: 'Ines doesn’t yet know the second hand could be Delphine’s; this lands as a reveal too early.', fix: 'Make the letter ambiguous: a D or an O.', by: 'check', at: iso(2) })

add('chat', 'chat1', { mode: 'assistant', title: 'Is the ledger reveal too early?', at: iso(1), messages: [
  { role: 'user', text: 'Is the ledger reveal too early?' },
  { role: 'assistant', text: 'Not the ledger itself: the story needs it on the page by scene 2. What lands early is the **initial**. Right now the reader connects the D to Delphine before Ines does, so scene 3 plays as confirmation instead of confrontation.\n\n- Keep the torn margin, lose the letter.\n- Let Delphine’s handwriting do the work in scene 3, when Ines sees her shopping list on the table.' },
] })

for (let i = 0; i < 18; i++) if (i % 3 !== 1) add('day', 'day_' + day(i), { date: day(i), start: 1000 + i * 10, words: 1000 + i * 10 + ((i * 337) % 900) + 120 })

export function seed(dir: string) {
  mkdirSync(dir, { recursive: true })
  const s = new Store(join(dir, 'canon.db'))
  s.save({ group: 'seed', baseline: true, changes: records })
  s.close()
}

if (import.meta.url === `file://${process.argv[1]}`) seed(process.argv[2] || 'sample-data')
