// Entity types are project data (project.types): each is a template with its own fields, like Scrivener's sheet templates.
// Field values live in entity.fields[key]; unknown keys are preserved.
export interface FieldDef { key: string; label: string; hint?: string; long?: boolean }
export interface TypeDef { label: string; one: string; fields: FieldDef[] }
export type EntityType = string

export const f = (key: string, label: string, hint = '', long = true): FieldDef => ({ key, label, hint, long })

/** Starting types for a new project: genre-neutral. Authors rename, extend or delete them. */
export const DEFAULT_TYPES: Record<string, TypeDef> = {
  character: {
    label: 'Characters', one: 'Character', fields: [
      f('role', 'Role', 'protagonist, antagonist, supporting…', false), f('pronouns', 'Pronouns', 'she/her, he/him, they/them…', false),
      f('occupation', 'Occupation', 'What they do', false), f('home', 'Lives at', 'Where they live', false),
      f('wants', 'Wants', 'What they consciously pursue'), f('needs', 'Needs', 'What they actually need, often against the want'),
      f('lie', 'The lie they believe', 'The false belief the story tests'), f('wound', 'Wound', 'What happened that still drives them'),
      f('secret', 'Secret', 'What they hide, and from whom'), f('arc', 'Arc', 'Where they start, where they end'),
      f('personality', 'Personality', 'How they come across; habits and contradictions'), f('voice', 'Voice & dialogue style', 'How they talk; what they never say'),
      f('physical', 'Physical description', 'What a stranger notices'), f('background', 'Background', 'Where they come from'),
    ],
  },
  place: { label: 'Places', one: 'Place', fields: [f('location', 'Where', 'Region, street, building', false), f('description', 'Description', 'What it is and what it is like'), f('sensory', 'Sensory texture', 'Sound, light, smell, temperature'), f('significance', 'Story significance', 'Why the story needs it')] },
  group: { label: 'Groups', one: 'Group', fields: [f('purpose', 'What it wants', 'Its practical goal'), f('register', 'How it talks', 'The register of its people and documents'), f('operations', 'How it works', 'Structure, rituals, day-to-day'), f('significance', 'Story significance', 'Why the story needs it')] },
  object: { label: 'Objects', one: 'Object', fields: [f('description', 'What it is'), f('rules', 'Rules & limits', 'What it can and can’t do'), f('significance', 'Story significance', 'Why the story needs it')] },
  lore: { label: 'Lore', one: 'Lore', fields: [f('description', 'Description', 'What it is'), f('significance', 'Story significance', 'Why the story needs it')] },
}

export const slug = (t: string) => t.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item'
