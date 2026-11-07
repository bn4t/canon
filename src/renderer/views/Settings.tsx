import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  update, create, tx, list, project, stories, scenesOf, allScenes, entities, typeIds, typeDef, words, totalWords, sessionWords, today, guidesFor, nameOf,
  LABELS, GUIDE_KINDS, STATUSES, statusesOf, statusOf, dailyGoal, writingDaysLeft, uid, type StatusDef, type State, type Proposal, type MetaField, type FieldKind, type GuideKind, type Project,
} from '../store.ts'
import { slug } from '../schema.ts'
import { saveSettings, refreshStatus, completeJSON, useAI, modelFor, fallsBack, aiReady, JOBS, PROVIDERS, providerName, type Settings as AISettings, type Provider, type Job, type JobModel } from '../ai.ts'
import { projectFromBackground, normalizeProposal } from '../prompts.ts'
import { compile, FORMATS, type Format } from '../compile.ts'
import { SettingsGroup, Area, Popover, useJob, JobStatus, ProposedChanges, ConnectPrompt, Spark, Icon, savedToast, closeSettings, openSettings, getAppearance, applyAppearance, type SettingsSection, type Appearance } from '../ui.tsx'
import { GuideRow } from './shared.tsx'
import { TypesView } from './World.tsx'
import { ExportSection, BookSection } from './Export.tsx'
import { BackupsSection } from './Projects.tsx'
import './settings.css'

const SECTIONS: { group: string; items: [SettingsSection, string, string][] }[] = [
  { group: 'Project', items: [['details', 'Details and background', 'Title, logline, and the background the assistant reads'], ['book', 'Book details', 'Front and back matter, the cover and the metadata that go into an export'], ['goals', 'Goals', 'Word targets, deadline, and your writing history']] },
  { group: 'Writing', items: [['guides', 'Guides', 'Style, rules and banned phrases, for the whole project or one story or character'], ['labels', 'Statuses, labels and fields', 'The stages a scene moves through, what the label colours mean, and fields every scene card has']] },
  { group: 'World', items: [['types', 'Types and fields', 'The kinds of things in your world and the fields each sheet has']] },
  { group: 'Files', items: [['export', 'Export', 'Compile the manuscript to Word, PDF, EPUB, RTF, Markdown or text'], ['backups', 'Backups', 'Earlier copies of this project, and restoring one']] },
  { group: 'Canon app', items: [['assistant', 'Assistant', 'For every project on this Mac. Canon sends only what a task needs; keys stay on this machine.'], ['appearance', 'Appearance', 'On this Mac only']] },
]
const editProject = (fn: (x: Project) => void) => update<'project'>('project', fn)

/** Settings: one window, sections down the side. Opened from the sidebar, the project menu, ⌘, and wherever a screen needs it. */
export function SettingsWindow({ s, section }: { s: State; section: SettingsSection }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as Element).closest?.('.pop')) closeSettings() }; addEventListener('keydown', k); return () => removeEventListener('keydown', k) }, [])
  const cur = SECTIONS.flatMap(g => g.items).find(i => i[0] === section) || SECTIONS[0].items[0]
  return (
    <div className="overlay settings-overlay" onMouseDown={closeSettings}>
      <div className="settings-win" role="dialog" aria-label="Settings" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-title">Settings</div>
          {SECTIONS.map(g => <div key={g.group} className="stack" style={{ gap: 1 }}>
            <div className="settings-grp">{g.group}</div>
            {g.items.map(([id, label]) => <button key={id} className={'settings-ni' + (id === section ? ' on' : '')} aria-current={id === section ? 'page' : undefined} onClick={() => openSettings(id)}>{label}</button>)}
          </div>)}
        </nav>
        <div className="settings-cnt">
          <div className="settings-head">
            <div className="grow"><h2>{cur[1]}</h2><p className="muted">{cur[2]}</p></div>
            <button className="icon-btn" aria-label="Close settings" title="Close (Esc)" onClick={closeSettings}><Icon name="close" /></button>
          </div>
          <div className="settings-body" key={section}>
            {section === 'details' && <Details s={s} />}
            {section === 'goals' && <Goals s={s} />}
            {section === 'guides' && <Guides s={s} />}
            {section === 'labels' && <Labels s={s} />}
            {section === 'types' && <TypesView s={s} />}
            {section === 'assistant' && <Assistant />}
            {section === 'book' && <BookSection s={s} />}
            {section === 'export' && <ExportSection s={s} />}
            {section === 'backups' && <BackupsSection s={s} />}
            {section === 'appearance' && <AppearanceSection />}
          </div>
        </div>
      </div>
    </div>
  )
}

const Group = SettingsGroup

// ---------------- details and background ----------------

function Details({ s }: { s: State }) {
  const p = project(s)
  const job = useJob()
  const ai = useAI()
  const [props, setProps] = useState<Proposal[]>([])
  const fill = () => job.run('Reading the background…', async sig => {
    const out = (await completeJSON<Proposal[]>('assist', projectFromBackground(s), sig)).map(x => normalizeProposal(s, x))
    setProps(out); if (!out.length) job.setErr('Nothing new: the canon already has what the background says.')
  })
  return (
    <>
      <Group label="The project">
        <div className="set-box pad stack">
          <div className="row" style={{ alignItems: 'start' }}>
            <div style={{ flex: '2 1 260px' }}><Area label="Title" single value={p.title} onChange={v => editProject(x => { x.title = v })} /></div>
            <div style={{ flex: '1 1 160px' }}><Area label="Author" single value={p.author || ''} hint="Shown on the title page when you export" onChange={v => editProject(x => { x.author = v })} /></div>
          </div>
          <Area label="Logline" value={p.logline} placeholder="The whole project in one sentence" onChange={v => editProject(x => { x.logline = v })} />
          <Area label="Thesis" value={p.thesis} placeholder="What the work argues, or asks" onChange={v => editProject(x => { x.thesis = v })} />
          <p className="small muted">Tone, motifs and conventions are <button className="link" onClick={() => openSettings('guides')}>guides</button>, so they can apply to the whole project, one story or one character.</p>
        </div>
      </Group>
      <Group label="Background" aside={p.background.trim() && aiReady(ai) ? <button className="btn sm soft" disabled={!!job.busy} onClick={fill}><Spark size={12} />Fill the canon from it</button> : undefined}>
        <p className="small muted">Free-form reference the assistant reads with drafts and checks. Where it disagrees with your sheets, timeline or cards, those win.</p>
        <textarea className="f" style={{ minHeight: 220 }} value={p.background} aria-label="Background" placeholder="Paste notes, a series bible, research…" onChange={e => editProject(x => { x.background = e.target.value })} />
        {p.background.trim() && !aiReady(ai) && <ConnectPrompt what="turn the background into sheets and facts" />}
        <JobStatus job={job} />
        <ProposedChanges s={s} items={props} onChange={setProps} title="From the background" />
      </Group>
    </>
  )
}

// ---------------- goals ----------------

const STOP = new Set('the a an and or but of to in on at for with as by from is was were be been are it its it’s he she they them his her their i you we me my your our that this these those there then than so not no if into out up down over just had has have do did does said says what when where who which while one all about like back him would could will can only now’s don’t didn’t'.split(' '))
const days = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 864e5)

/** Characters (spaces included, line breaks not) and manuscript pages, about 250 words to a page. */
const charsOf = (t: string) => t.replace(/\n/g, '').length
const pagesOf = (w: number) => Math.ceil(w / 250)
const sizeLine = (w: number, c: number) => `${c.toLocaleString()} characters · about ${pagesOf(w).toLocaleString()} page${pagesOf(w) === 1 ? '' : 's'}`
/** Weekdays Monday first, as numbers Date.getDay() uses (0 = Sunday). */
const WEEK = [1, 2, 3, 4, 5, 6, 0]
const dayName = (d: number, style: 'short' | 'long' = 'short') => new Date(2024, 0, 7 + d).toLocaleDateString(undefined, { weekday: style }) // 7 Jan 2024 was a Sunday

function Goals({ s }: { s: State }) {
  const p = project(s)
  const total = totalWords(s), todayWords = Math.max(0, sessionWords(s)), chars = allScenes(s).reduce((n, sc) => n + charsOf(sc.prose), 0)
  const left = p.deadline ? days(today(), p.deadline) : undefined
  const wdays = p.writingDays?.length ? p.writingDays : WEEK
  const writing = p.deadline && left !== undefined && left >= 0 ? writingDaysLeft(p.deadline, wdays) : 0
  const remaining = p.target ? Math.max(0, p.target - (total - todayWords)) : 0
  const perDay = p.target && writing > 0 ? Math.ceil(remaining / writing) : undefined
  const canWork = !!p.target && !!p.deadline && left !== undefined && left >= 0
  const auto = !!p.goalFromDeadline && canWork, goal = dailyGoal(s)
  const toggleDay = (d: number) => editProject(x => {
    const cur = x.writingDays?.length ? x.writingDays : WEEK
    const next = cur.includes(d) ? cur.filter(y => y !== d) : [...cur, d]
    x.writingDays = next.length === 7 ? undefined : next.length ? next : cur // at least one day stays
  })
  const hist = useMemo(() => {
    const byDate = new Map(list(s, 'day').map(d => [d.date, Math.max(0, d.words - d.start)]))
    return Array.from({ length: 30 }, (_, i) => { const d = new Date(Date.now() - (29 - i) * 864e5).toLocaleDateString('sv'); return { d, n: byDate.get(d) || 0 } })
  }, [s])
  const max = Math.max(1, ...hist.map(h => h.n))
  const freq = useMemo(() => {
    // count case-insensitively, but show names as written: a word that never appears in lowercase keeps its capital
    const m = new Map<string, number>(), shown = new Map<string, string>()
    for (const sc of allScenes(s)) for (const raw of sc.prose.match(/[\p{L}’']{3,}/gu) || []) {
      const w = raw.toLowerCase()
      if (STOP.has(w)) continue
      m.set(w, (m.get(w) || 0) + 1)
      if (raw === w) shown.set(w, w)
      else if (!shown.has(w)) shown.set(w, raw)
    }
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([w, n]) => [shown.get(w) || w, n] as const)
  }, [s])
  const num = (v: number | undefined, fn: (n: number | undefined) => void, label: string, step = 1000) =>
    <label className="field"><span className="lbl">{label}</span><input className="f" type="number" min={0} step={step} value={v || ''} placeholder="None" onChange={e => fn(Number(e.target.value) || undefined)} /></label>
  return (
    <>
      <Group label="Targets">
        <div className="set-box pad stack">
          <div className="grid3">
            {auto
              ? <label className="field" title="Worked out from the target and the due date. Untick the option below to set your own."><span className="lbl">Daily goal (words)</span><input className="f" type="number" disabled value={goal || ''} /></label>
              : num(p.sessionTarget, n => editProject(x => { x.sessionTarget = n }), 'Daily goal (words)', 100)}
            {num(p.target, n => editProject(x => { x.target = n }), 'Project target (words)')}
            <label className="field"><span className="lbl">Due date</span><input className="f" type="date" value={p.deadline || ''} onChange={e => editProject(x => { x.deadline = e.target.value || undefined })} /></label>
          </div>
          <div className="stack set-auto">
            <label className="row nowrap" title={canWork ? undefined : 'Needs a project target and a due date that hasn’t passed'}>
              <input type="checkbox" checked={!!p.goalFromDeadline} disabled={!canWork && !p.goalFromDeadline} onChange={e => editProject(x => { x.goalFromDeadline = e.target.checked || undefined })} />
              <span>Work out the daily goal from the deadline{!canWork && <span className="muted"> · needs a target and a due date</span>}</span></label>
            {p.goalFromDeadline && <>
              <div className="row set-days" role="group" aria-label="Writing days">
                <span className="small muted">Writing days</span>
                {WEEK.map(d => <button key={d} className={'chip' + (wdays.includes(d) ? ' on' : '')} aria-pressed={wdays.includes(d)} title={dayName(d, 'long')} onClick={() => toggleDay(d)}>{dayName(d)}</button>)}
              </div>
              {auto && <p className="small muted">Today’s goal is {(goal || 0).toLocaleString()} words: {remaining.toLocaleString()} words to go over {writing} writing day{writing === 1 ? '' : 's'}, today included. It updates each day as you write.</p>}
            </>}
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <div className="row"><b>{todayWords.toLocaleString()}</b><span className="muted">{goal ? `of ${goal.toLocaleString()} today` : 'words today'}</span></div>
            {goal ? <div className="bar"><i style={{ width: Math.min(100, (todayWords / goal) * 100) + '%' }} /></div> : null}
            <div className="row"><b>{total.toLocaleString()}</b><span className="muted">{p.target ? `of ${p.target.toLocaleString()} words` : 'words in the project'}</span><span className="grow" /><span className="small muted">{sizeLine(total, chars)}</span></div>
            {p.target ? <div className="bar"><i style={{ width: Math.min(100, (total / p.target) * 100) + '%' }} /></div> : null}
            {left !== undefined && <p className="small muted">{left < 0 ? `The due date passed ${-left} days ago.` : `${left} days left${wdays.length < 7 ? `, ${writing} of them writing days` : ''}${perDay !== undefined && !auto ? `: about ${perDay.toLocaleString()} words a writing day reaches the target` : ''}.`}</p>}
          </div>
        </div>
      </Group>
      <Group label="Stories">
        <div className="set-box">
          {stories(s).map(st => {
            const scs = scenesOf(s, st.id), w = scs.reduce((n, sc) => n + words(sc.prose), 0)
            return (
              <div key={st.id} className="set-row">
                <span className="grow clip">{st.title}{w > 0 && <span className="small muted set-size">{sizeLine(w, scs.reduce((n, sc) => n + charsOf(sc.prose), 0))}</span>}</span>
                <input className="f set-num" type="number" min={0} step={500} value={st.target || ''} placeholder="Target" aria-label={`Target for ${st.title}`} onChange={e => update<'story'>(st.id, x => { x.target = Number(e.target.value) || undefined })} />
                <span className="small muted set-words">{w.toLocaleString()}{st.target ? ` / ${st.target.toLocaleString()}` : ''}</span>
                {st.target ? <div className="bar" style={{ width: 90 }}><i style={{ width: Math.min(100, (w / st.target) * 100) + '%' }} /></div> : <span style={{ width: 90 }} />}
              </div>
            )
          })}
          {!stories(s).length && <p className="small muted set-row">No stories yet.</p>}
        </div>
      </Group>
      <Group label="Writing history · last 30 days">
        {hist.every(h => !h.n) ? <p className="small muted">Nothing recorded yet. Every day you write, the words you add show up here.</p>
          : <div className="hist">{hist.map(h => <i key={h.d} title={`${h.d}: ${h.n.toLocaleString()} words`} style={{ height: Math.max(2, (h.n / max) * 100) + '%', opacity: h.n ? .8 : .15 }} />)}</div>}
        <p className="small muted">Words added per day, counted from saves. Deleting text counts as zero.</p>
      </Group>
      <Group label="Most used words">
        {freq.length ? <div className="row" style={{ gap: 5 }}>{freq.map(([w, n]) => <span key={w} className="chip">{w} <span className="muted">{n}</span></span>)}</div> : <p className="small muted">No text yet.</p>}
      </Group>
    </>
  )
}

// ---------------- guides ----------------

function scopeName(s: State, scope: string) {
  if (scope === 'project') return 'Whole project'
  if (scope === 'form:documents') return 'In-world documents'
  const [k, id] = scope.split(':')
  if (k === 'type') return `Every ${typeDef(s, id).one.toLowerCase()}`
  return nameOf(s, id) || 'Missing'
}

function Guides({ s }: { s: State }) {
  const used = new Set(list(s, 'guide').map(g => g.scope))
  const scopes = ['project', 'form:documents', ...stories(s).map(x => 'story:' + x.id), ...typeIds(s).map(t => 'type:' + t), ...entities(s).map(e => 'entity:' + e.id)]
  const shown = scopes.filter(sc => sc === 'project' || used.has(sc))
  const [scope, setScope] = useState('project')
  const [kind, setKind] = useState<GuideKind>('style')
  const add = (sc: string, k: GuideKind) => tx('Add guide', () => { create('guide', { use: k, scope: sc, title: GUIDE_KINDS.find(x => x.id === k)!.label, text: '' }) }, false)
  return (
    <>
      <p className="small muted">Guides go with every draft and check in their scope. A character’s voice is a style guide scoped to them; it also shows on their sheet.</p>
      <div className="set-box pad stack" style={{ gap: 6 }}>
        {GUIDE_KINDS.map(k => <span key={k.id} className="small"><b>{k.label}</b> <span className="muted">{k.hint}</span></span>)}
        <div className="row nowrap" style={{ marginTop: 6 }}>
          <select className="f" value={scope} aria-label="Applies to" onChange={e => setScope(e.target.value)}>{scopes.map(sc => <option key={sc} value={sc}>{scopeName(s, sc)}</option>)}</select>
          <select className="f" style={{ width: 180 }} value={kind} aria-label="Kind" onChange={e => setKind(e.target.value as GuideKind)}>{GUIDE_KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
          <button className="btn" onClick={() => add(scope, kind)}>Add guide</button>
        </div>
      </div>
      {shown.map(sc => {
        const gs = guidesFor(s, sc)
        return (
          <Group key={sc} label={scopeName(s, sc)} aside={<><button className="btn sm ghost" onClick={() => add(sc, 'rule')}>+ Rule</button><button className="btn sm ghost" onClick={() => add(sc, 'style')}>+ Style</button></>}>
            <div className="set-box pad stack">
              {!gs.length && <p className="small muted">None yet.</p>}
              {gs.map(g => <GuideRow key={g.id} g={g} />)}
            </div>
          </Group>
        )
      })}
    </>
  )
}

// ---------------- labels and scene fields ----------------

/** The grey and the six label colours a status can take. */
const STATUS_COLORS = ['var(--line2)', ...LABELS.map(l => `var(--l-${l})`)]
/** Edit the project's statuses, writing the defaults in on the first change. */
const editStatuses = (fn: (xs: StatusDef[], x: Project) => void) => editProject(x => { if (!x.statuses?.length) x.statuses = STATUSES.map(y => ({ ...y })); fn(x.statuses, x) })

function Statuses({ s }: { s: State }) {
  const all = statusesOf(s)
  const [drag, setDrag] = useState<number>(), [over, setOver] = useState<number>(), [fresh, setFresh] = useState<string>()
  const used = (id: string) => allScenes(s).filter(sc => statusOf(s, sc.status).id === id).length
  const add = () => { const id = uid('st'); tx('Add status', () => editStatuses(xs => { xs.push({ id, label: 'New status', color: STATUS_COLORS[1 + (xs.length % 6)] }) }), false); setFresh(id) }
  const move = (from: number, to: number) => { if (from !== to && from + 1 !== to) tx('Reorder statuses', () => editStatuses(xs => { const [x] = xs.splice(from, 1); xs.splice(to > from ? to - 1 : to, 0, x) })) }
  /** Remove a status; its scenes (and any collection filtering on it) take the first remaining status. One undo step. */
  const drop = (i: number) => {
    const gone = all[i], rest = all.filter((_, j) => j !== i), to = rest[0]
    if (!to) return
    const scs = allScenes(s).filter(sc => statusOf(s, sc.status).id === gone.id)
    tx(`Remove status “${gone.label}”${scs.length ? `; ${scs.length} scene${scs.length === 1 ? '' : 's'} now “${to.label}”` : ''}`, () => {
      for (const sc of scs) update<'scene'>(sc.id, x => { x.status = to.id })
      editStatuses((xs, x) => { xs.splice(i, 1); for (const c of x.collections || []) if (c.filter.status === gone.id) c.filter.status = to.id })
    })
  }
  return (
    <Group label="Statuses" aside={<button className="btn sm" onClick={add}>Add status</button>}>
      <p className="small muted">The stages a scene moves through, in order. Drag to reorder; the last one counts as finished.</p>
      <div className="set-box">
        {all.map((st, i) => (
          <div key={st.id} className={'set-row set-status' + (over === i && drag !== undefined && drag !== i ? ' over' : '')} draggable={drag !== undefined || undefined}
            onDragOver={e => { if (drag === undefined) return; e.preventDefault(); setOver(i) }} onDrop={e => { e.preventDefault(); if (drag !== undefined) move(drag, i); setDrag(undefined); setOver(undefined) }}
            onDragEnd={() => { setDrag(undefined); setOver(undefined) }}>
            <span className="set-grip" title="Drag to reorder" onMouseDown={() => setDrag(i)} onMouseUp={() => setDrag(undefined)}><Icon name="drag" size={14} /></span>
            <Popover trigger={o => <button className="set-swatch" style={{ background: st.color }} aria-label={`Colour of ${st.label}`} title="Colour" onClick={o} />}>{close => (
              <div className="set-swatches" role="listbox" aria-label="Colour">{STATUS_COLORS.map(c => <button key={c} role="option" aria-selected={st.color === c} className={'set-swatch' + (st.color === c ? ' on' : '')} style={{ background: c }}
                aria-label={c === 'var(--line2)' ? 'Grey' : c.slice(8, -1)} onClick={() => { tx(`Recolour “${st.label}”`, () => editStatuses(xs => { xs[i].color = c }), false); close() }} />)}</div>
            )}</Popover>
            <input className="f" value={st.label} placeholder="Status name" aria-label="Status name" autoFocus={fresh === st.id} onFocus={e => { if (fresh === st.id) e.target.select() }}
              onChange={e => editStatuses(xs => { xs[i].label = e.target.value })} />
            <span className="small muted set-words">{used(st.id) ? `${used(st.id)} scene${used(st.id) === 1 ? '' : 's'}` : ''}</span>
            <button className="icon-btn" aria-label={`Remove ${st.label}`} disabled={all.length < 2}
              title={all.length < 2 ? 'A project needs at least one status' : used(st.id) ? `Remove; its scenes become “${(all[i === 0 ? 1 : 0]).label}”` : 'Remove'} onClick={() => drop(i)}><Icon name="trash" size={15} /></button>
          </div>
        ))}
        {all.length > 1 && <div className={'set-status-end' + (over === all.length ? ' over' : '')} onDragOver={e => { if (drag === undefined) return; e.preventDefault(); setOver(all.length) }}
          onDrop={e => { e.preventDefault(); if (drag !== undefined) move(drag, all.length); setDrag(undefined); setOver(undefined) }} />}
      </div>
    </Group>
  )
}

const KINDS: { id: FieldKind; label: string }[] = [{ id: 'text', label: 'Text' }, { id: 'check', label: 'Checkbox' }, { id: 'list', label: 'Choice' }, { id: 'date', label: 'Date' }]

function Labels({ s }: { s: State }) {
  const p = project(s)
  const fields = p.sceneFields || []
  const setField = (i: number, patch: Partial<MetaField>) => editProject(x => { x.sceneFields![i] = { ...x.sceneFields![i], ...patch } })
  return (
    <>
      <Statuses s={s} />
      <Group label="Label colours">
        <p className="small muted">Name what each colour means on your cards: a point of view, a timeline, a thread.</p>
        <div className="set-labels">{LABELS.map(l => (
          <label key={l} className="row nowrap"><i className="dot" style={{ background: `var(--l-${l})`, width: 12, height: 12 }} />
            <input className="f" value={p.labels?.[l] || ''} placeholder={l[0].toUpperCase() + l.slice(1)} aria-label={`Name for ${l}`} onChange={e => editProject(x => { x.labels = { ...x.labels, [l]: e.target.value } })} /></label>
        ))}</div>
      </Group>
      <Group label="Scene fields" aside={<button className="btn sm" onClick={() => tx('Add scene field', () => editProject(x => { x.sceneFields = [...(x.sceneFields || []), { key: 'field-' + ((x.sceneFields || []).length + 1), label: '', kind: 'text' }] }), false)}>Add field</button>}>
        <p className="small muted">Extra properties every scene card has, shown in the card’s property row.</p>
        <div className="set-box pad stack" style={{ gap: 8 }}>
          {fields.map((f, i) => (
            <div key={i} className="row nowrap">
              <input className="f" value={f.label} placeholder="Field name" aria-label="Field name" onChange={e => setField(i, { label: e.target.value, key: f.key || slug(e.target.value) })} />
              <select className="f" style={{ width: 130 }} value={f.kind} aria-label="Kind" onChange={e => setField(i, { kind: e.target.value as FieldKind })}>{KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
              {f.kind === 'list' && <input className="f" value={(f.options || []).join(', ')} placeholder="Choices, comma-separated" aria-label="Choices" onChange={e => setField(i, { options: e.target.value.split(',').map(o => o.trimStart()) })} />}
              <button className="icon-btn" aria-label="Remove field" title="Remove field" onClick={() => tx('Remove scene field', () => editProject(x => { x.sceneFields!.splice(i, 1) }))}><Icon name="trash" size={15} /></button>
            </div>
          ))}
          {!fields.length && <p className="small muted">No extra fields.</p>}
        </div>
      </Group>
      <Group label="Checks">
        <label className="row nowrap"><input type="checkbox" checked={!!p.emDashCheck} onChange={e => editProject(x => { x.emDashCheck = e.target.checked })} />Flag em dashes used as prose punctuation</label>
      </Group>
    </>
  )
}

// ---------------- assistant ----------------

const LOGO: Record<Provider, string> = { chatgpt: 'G', openrouter: 'R', 'opencode-go': 'O' }
const ABOUT: Record<Provider, string> = {
  chatgpt: 'Uses your ChatGPT plan’s allowance. Canon can call models and nothing else.',
  openrouter: 'Sign in, or paste a key. Gives access to most models.',
  'opencode-go': 'Paste your key from opencode.ai.',
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh']

export function useProviderSignIn() {
  const [waiting, setWaiting] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => { // poll while a browser sign-in is open
    if (!waiting) return
    const t = setInterval(async () => { const st = await (await fetch('/api/auth/status')).json(); if (st[waiting]) { setWaiting(''); refreshStatus() } }, 2000)
    const stop = setTimeout(() => setWaiting(''), 5 * 60_000)
    return () => { clearInterval(t); clearTimeout(stop) }
  }, [waiting])
  const signIn = async (p: 'chatgpt' | 'openrouter') => {
    setErr('')
    const r = await fetch('/api/auth/' + p, { method: 'POST' }) // the shell opens the sign-in page in the browser
    if (!r.ok) { setErr(await r.text()); return }
    setWaiting(p)
  }
  const saveKey = async (p: Provider, key: string) => {
    setErr('')
    const r = await fetch('/api/auth/key', { method: 'PUT', body: JSON.stringify({ provider: p, key }) })
    if (!r.ok) { setErr(await r.text()); return false }
    refreshStatus(); return true
  }
  const signOut = async (p: Provider) => { await fetch('/api/auth/' + p, { method: 'DELETE' }); refreshStatus() }
  return { waiting, err, setErr, signIn, saveKey, signOut }
}

/** One provider: connect, paste a key, or disconnect. */
export function ProviderRow({ p, auth, big }: { p: Provider; auth: ReturnType<typeof useProviderSignIn>; big?: boolean }) {
  const ai = useAI()
  const [key, setKey] = useState<string>()
  const on = !!ai.status[p]
  const keyBox = <span className="row nowrap" style={{ gap: 6 }}>
    <input className="f" type="password" autoComplete="off" autoFocus value={key} placeholder={p === 'openrouter' ? 'sk-or-…' : 'Your API key'} aria-label={`${providerName(p)} API key`} style={{ width: 200 }} onChange={e => setKey(e.target.value)}
      onKeyDown={async e => { if (e.key === 'Enter' && key?.trim() && await auth.saveKey(p, key.trim())) setKey(undefined); if (e.key === 'Escape') setKey(undefined) }} />
    <button className="btn sm pri" disabled={!key?.trim()} onClick={async () => { if (await auth.saveKey(p, key!.trim())) setKey(undefined) }}>Save</button>
    <button className="btn sm ghost" onClick={() => setKey(undefined)}>Cancel</button></span>
  return (
    <div className={big ? 'prov-card' + (on ? ' on' : '') : 'set-row prov-row'}>
      <span className={'prov-logo ' + p}>{LOGO[p]}</span>
      <span className="grow" style={{ minWidth: 0 }}><b>{providerName(p)}</b><span className="small muted" style={{ display: 'block' }}>{ABOUT[p]}</span></span>
      {on ? <><span className="prov-ok"><i />Connected</span><button className="btn sm ghost" onClick={() => auth.signOut(p)}>{p === 'chatgpt' ? 'Sign out' : 'Disconnect'}</button></>
        : auth.waiting === p ? <span className="small ai-text">Waiting for the browser…</span>
        : key !== undefined ? keyBox
        : p === 'opencode-go' ? <button className="btn sm" onClick={() => setKey('')}>Add key</button>
        : p === 'openrouter' ? <><button className="btn sm ghost" onClick={() => setKey('')}>Paste a key</button><button className="btn sm pri" onClick={() => auth.signIn('openrouter')}>Connect</button></>
        : <button className="btn sm pri" onClick={() => auth.signIn('chatgpt')}>Sign in with ChatGPT</button>}
    </div>
  )
}

function useModels() {
  const ai = useAI()
  const [models, setModels] = useState<Record<string, string[]>>({})
  useEffect(() => {
    for (const p of PROVIDERS) if (ai.status[p.id] && !models[p.id])
      fetch('/api/models?provider=' + p.id).then(r => (r.ok ? r.json() : [])).then((ids: string[]) => setModels(m => ({ ...m, [p.id]: ids }))).catch(() => {})
  }, [ai.status]) // eslint-disable-line react-hooks/exhaustive-deps
  return models
}

/** Provider, model and (for ChatGPT) effort. */
function ModelPick({ m, onChange, label }: { m: JobModel; onChange: (m: JobModel) => void; label: string }) {
  const ai = useAI()
  return (
    <span className="row nowrap" style={{ gap: 6 }}>
      <select className="f set-sel" value={m.provider} aria-label={`${label} provider`} onChange={e => onChange({ provider: e.target.value as Provider, model: '', effort: m.effort })}>
        {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}{ai.status[p.id] ? '' : ' (not connected)'}</option>)}
      </select>
      <input className="f set-model" list={'models-' + m.provider} value={m.model} placeholder={ai.status[m.provider] ? 'Choose a model' : 'Connect first'} aria-label={`${label} model`} onChange={e => onChange({ ...m, model: e.target.value })} />
      {m.provider === 'chatgpt' && <select className="f set-sel" value={m.effort || 'medium'} aria-label={`${label} effort`} onChange={e => onChange({ ...m, effort: e.target.value })}>
        {EFFORTS.map(x => <option key={x} value={x}>{x[0].toUpperCase() + x.slice(1)} effort</option>)}</select>}
    </span>
  )
}

export function Assistant() {
  const ai = useAI()
  const auth = useProviderSignIn()
  const models = useModels()
  const cfg = ai.settings
  const save = (next: AISettings) => saveSettings(next)
  const setJob = (j: Job, m: JobModel | undefined) => { const jobs = { ...cfg.jobs }; if (m) jobs[j] = m; else delete jobs[j]; save({ ...cfg, jobs }) }
  return (
    <>
      {auth.err && <div className="err">{auth.err}<button className="x" aria-label="Dismiss" onClick={() => auth.setErr('')}>×</button></div>}
      <Group label="Providers">
        <div className="set-box">{PROVIDERS.map(p => <ProviderRow key={p.id} p={p.id} auth={auth} />)}</div>
      </Group>
      <Group label="Model">
        <div className="set-box">
          <div className="set-row wrap">
            <span className="grow"><b>Default</b><span className="small muted" style={{ display: 'block' }}>Used for everything unless you choose otherwise below</span></span>
            <ModelPick m={cfg.default} label="Default" onChange={m => save({ ...cfg, default: m })} />
          </div>
          {!aiReady(ai) && <div className="set-row"><ConnectPrompt /></div>}
        </div>
      </Group>
      <Group label="Per job">
        <div className="set-box">
          {JOBS.map(j => {
            const own = cfg.jobs[j.id]
            const eff = modelFor(j.id, ai)
            return (
              <div key={j.id} className="set-row wrap" style={{ alignItems: 'flex-start' }}>
                <span className="grow"><b style={{ fontWeight: 500 }}>{j.label}</b><span className="small muted" style={{ display: 'block' }}>{j.hint}</span>
                  {fallsBack(j.id, ai) && <span className="set-warn"><Icon name="questions" size={13} />{providerName(own!.provider)} isn’t connected, so this falls back to the default.</span>}</span>
                <span className="stack" style={{ gap: 6, justifyItems: 'end' }}>
                  <select className="f set-sel" value={own ? 'own' : 'default'} aria-label={`${j.label} model`} onChange={e => setJob(j.id, e.target.value === 'own' ? { ...cfg.default } : undefined)}>
                    <option value="default">Default{cfg.default.model ? ` (${cfg.default.model})` : ''}</option><option value="own">Choose a model…</option>
                  </select>
                  {own && <ModelPick m={own} label={j.label} onChange={m => setJob(j.id, m)} />}
                  {!own && eff.model && <span className="small faint">{eff.model} · {providerName(eff.provider)}</span>}
                </span>
              </div>
            )
          })}
        </div>
      </Group>
      {PROVIDERS.map(p => <datalist key={p.id} id={'models-' + p.id}>{(models[p.id] || []).map(id => <option key={id} value={id} />)}</datalist>)}
    </>
  )
}

// ---------------- export and backup ----------------

// ---------------- appearance ----------------

function AppearanceSection() {
  const [a, setA] = useState<Appearance>(getAppearance)
  const set = (p: Partial<Appearance>) => setA(applyAppearance(p))
  const seg = <K extends keyof Appearance>(k: K, opts: [Appearance[K], string][]) =>
    <div className="seg">{opts.map(([v, l]) => <button key={v} className={a[k] === v ? 'on' : ''} aria-pressed={a[k] === v} onClick={() => set({ [k]: v } as Partial<Appearance>)}>{l}</button>)}</div>
  return (
    <div className="set-box">
      <div className="set-row"><span className="grow"><b style={{ fontWeight: 500 }}>Theme</b></span>{seg('theme', [['system', 'Match the system'], ['light', 'Light'], ['dark', 'Dark']])}</div>
      <div className="set-row"><span className="grow"><b style={{ fontWeight: 500 }}>Text size</b><span className="small muted" style={{ display: 'block' }}>The size of prose in the editor</span></span>{seg('prose', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']])}</div>
      <div className="set-row"><span className="grow"><b style={{ fontWeight: 500 }}>Page width</b><span className="small muted" style={{ display: 'block' }}>How wide a line of prose runs</span></span>{seg('width', [['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide']])}</div>
    </div>
  )
}
