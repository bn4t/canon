// Starting points for a new project. Each builds the project's first records: a structure to write into, nothing to delete.
// Shared by first run (Setup) and File ▸ New Project (Projects).
import { uid, emptyProject, newScene, newSection, type Kind } from './store.ts'
import { sampleRecords } from './sample.ts'

export type Rec = { kind: Kind; id: string; data: Record<string, unknown> }
export interface ProjectInfo { title: string; logline?: string; author?: string }
export interface Template { id: string; name: string; blurb: string; icon: string; build: (p: ProjectInfo) => Rec[] }

const projectRec = (p: ProjectInfo): Rec => ({ kind: 'project', id: 'project', data: { ...emptyProject(), title: p.title.trim() || 'Untitled project', logline: p.logline?.trim() || '', ...(p.author?.trim() ? { author: p.author.trim() } : {}) } })

/** A story laid out from a shape: 'P' a part, 'C' a chapter (with one empty scene), numbered as Canon numbers them. */
function story(title: string, order: number, shape: string): Rec[] {
  const id = uid('story'), out: Rec[] = [{ kind: 'story', id, data: { title, order, form: 'prose', premise: '', beats: [] } }]
  let o = 1, parts = 0, chapters = 0
  for (const c of shape) {
    if (c === 'P') out.push({ kind: 'section', id: uid('section'), data: { ...newSection(id, o++, { type: 'part', title: `Part ${++parts}` }) } })
    else if (c === 'C') out.push({ kind: 'section', id: uid('section'), data: { ...newSection(id, o++, { title: `Chapter ${++chapters}` }) } })
    if (c === 'C' || c === 'S') out.push({ kind: 'scene', id: uid('scene'), data: { ...newScene(id, o++, { title: 'Untitled scene' }) } })
  }
  return out
}

export const TEMPLATES: Template[] = [
  { id: 'blank', name: 'Blank', icon: 'plus', blurb: 'Nothing yet. Add stories, chapters and scenes as you go.', build: p => [projectRec(p)] },
  { id: 'novel', name: 'Novel', icon: 'write', blurb: 'One story with three chapters to start writing in.', build: p => [projectRec(p), ...story(p.title.trim() || 'Untitled story', 1, 'CCC')] },
  { id: 'parts', name: 'Novel in parts', icon: 'list', blurb: 'One story in two parts, with chapters in each.', build: p => [projectRec(p), ...story(p.title.trim() || 'Untitled story', 1, 'PCCPC')] },
  { id: 'collection', name: 'Story collection', icon: 'stories', blurb: 'Three short stories that share a world and a cast.', build: p => [projectRec(p), ...['First story', 'Second story', 'Third story'].flatMap((t, i) => story(t, i + 1, 'S'))] },
  { id: 'series', name: 'Series', icon: 'collection', blurb: 'Three books, one canon: the cast, places and timeline run across them.', build: p => [projectRec(p), ...['Book One', 'Book Two', 'Book Three'].flatMap((t, i) => story(t, i + 1, 'C'))] },
]
/** The sample project, as a starting point of its own (File ▸ New Project). */
export const SAMPLE: Template = { id: 'sample', name: 'The sample project', icon: 'eye', blurb: '“Low Tide at Merrow”: three stories, a small cast, a timeline and open questions.', build: () => sampleRecords() as Rec[] }
