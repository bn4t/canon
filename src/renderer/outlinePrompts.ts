import type { State, Story } from './store.ts'
import { suggestScenes } from './prompts.ts'

/** Suggest missing scenes, each placed in one of the story's beats so it lands in the right column of the board. */
export function suggestScenesByBeat(s: State, story: Story) {
  const p = suggestScenes(s, story)
  const beats = story.beats.map(b => b.trim()).filter(Boolean)
  return beats.length
    ? { ...p, system: p.system + `\nFor each scene, add "beat" to its data: exactly one of ${beats.map(b => JSON.stringify(b)).join(', ')}. Use "why" to say what the scene pays off or sets up.` }
    : p
}
