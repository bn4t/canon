import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  update, remove, tx, create, get, getState, list, nameOf, entities, events, plainFacts, stories, scenesOf, allScenes, newQuestion, eventCode, showToast, QKINDS, GUIDE_KINDS,
  type State, type Question, type Guide, type GuideKind, type Fact, type KCell, type KState,
} from '../store.ts'
import { completeJSON, useAI, aiReady } from '../ai.ts'
import { findProblems, normalizeProposal, type FoundQ } from '../prompts.ts'
import { useJob, JobStatus, Popover, ConnectPrompt, Spark, Icon, go, ago } from '../ui.tsx'
import './timeline.css'
import './questions.css'

/** Where a record lives in the app. */
export function hrefOf(s: State, id: string): string {
  const r = s.recs[id]
  if (!r) return ''
  if (r.kind === 'entity') return 'world/' + id
  if (r.kind === 'fact') return 'timeline/' + id
  if (r.kind === 'story') return 'story/' + id
  if (r.kind === 'scene') return 'scene/' + id
  if (r.kind === 'question') return 'questions/' + id
  if (r.kind === 'section') return 'text/' + id
  if (r.kind === 'research') return 'research/' + id
  return ''
}
export const RecLink = ({ s, id }: { s: State; id: string }) => <a className="chip" href={'#' + hrefOf(s, id)}>{nameOf(s, id) || 'Missing'}</a>

/** Pick any record (entities, events, facts, stories, scenes) with a filter box. */
export function RecordPicker({ s, label, exclude = [], onPick, kinds = ['entity', 'fact', 'story', 'scene'] }: { s: State; label: ReactNode; exclude?: string[]; onPick: (id: string) => void; kinds?: string[] }) {
  return <Popover trigger={open => <button className="chip dash" onClick={open}>{label}</button>}>{close => <PickList s={s} exclude={exclude} kinds={kinds} onPick={id => { onPick(id); close() }} />}</Popover>
}
function PickList({ s, exclude, kinds, onPick }: { s: State; exclude: string[]; kinds: string[]; onPick: (id: string) => void }) {
  const [q, setQ] = useState('')
  const all = useMemo(() => [
    ...(kinds.includes('entity') ? entities(s).map(e => ({ id: e.id, g: 'World', n: e.name })) : []),
    ...(kinds.includes('fact') ? [...events(s), ...plainFacts(s)].map(f => ({ id: f.id, g: f.at !== undefined ? 'Events' : 'Facts', n: nameOf(s, f.id) })) : []),
    ...(kinds.includes('story') ? stories(s).map(x => ({ id: x.id, g: 'Stories', n: x.title })) : []),
    ...(kinds.includes('scene') ? allScenes(s).map(x => ({ id: x.id, g: 'Scenes', n: x.title })) : []),
    ...(kinds.includes('section') ? stories(s).flatMap(st => list(s, 'section').filter(x => x.story === st.id).sort((a, b) => a.order - b.order)).map(x => ({ id: x.id, g: 'Chapters', n: nameOf(s, x.id) })) : []),
    ...(kinds.includes('research') ? list(s, 'research').sort((a, b) => b.at.localeCompare(a.at)).map(x => ({ id: x.id, g: 'Research', n: x.title })) : []),
  ].filter(x => !exclude.includes(x.id)), [s, exclude, kinds])
  const hits = all.filter(x => x.n.toLowerCase().includes(q.toLowerCase())).slice(0, 60)
  return <div className="stack" style={{ gap: 4, width: 300 }}>
    <input className="f" autoFocus placeholder="Filter" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && hits[0]) onPick(hits[0].id) }} />
    {hits.map((h, i) => <button key={h.id} className="menu-item" onClick={() => onPick(h.id)}>{(i === 0 || hits[i - 1].g !== h.g) && <span className="lbl" style={{ width: 52 }}>{h.g}</span>}{!(i === 0 || hits[i - 1].g !== h.g) && <span style={{ width: 52 }} />}<span className="clip">{h.n}</span></button>)}
    {!hits.length && <p className="muted small" style={{ padding: 8 }}>Nothing matches.</p>}
  </div>
}

// ---------------- small shared pieces ----------------

/** A fact's code: E-number for events (stable), F + position for undated facts. */
export const factCode = (s: State, id: string) => { const f = get(s, id, 'fact'); if (!f) return ''; return f.at !== undefined ? eventCode(s, id) : 'F' + (plainFacts(s).findIndex(x => x.id === id) + 1) }
/** Short label for a record in a chip: a code for facts, the name otherwise. */
export const shortName = (s: State, id: string) => get(s, id, 'fact') ? factCode(s, id) : nameOf(s, id) || 'Missing'

const AVATAR = ['var(--l-blue)', 'var(--l-purple)', 'var(--l-green)', 'var(--l-orange)', 'var(--l-red)', 'var(--l-yellow)']
export const avatarColor = (name: string) => AVATAR[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR.length]
export const Av = ({ name, size = 20 }: { name: string; size?: number }) =>
  <span className="kav" style={{ background: avatarColor(name), width: size, height: size, fontSize: size * .52 }} aria-hidden="true">{(name.trim()[0] || '?').toUpperCase()}</span>

/** A button that asks the assistant for something; with none connected it opens a Connect prompt instead. */
export function AIButton({ label, busy, onClick, className = 'btn sm soft', disabled, title }: { label: ReactNode; busy?: string; onClick: () => void; className?: string; disabled?: boolean; title?: string }) {
  const ready = aiReady(useAI())
  const face = <>{busy ? <span className="spinner" /> : <Spark size={13} />}{busy ? 'Working…' : label}</>
  if (!ready) return <Popover className="right" trigger={o => <button className={className} title={title} onClick={o}>{face}</button>}>{close => <div style={{ width: 330 }}><ConnectPrompt compact onGo={close} /></div>}</Popover>
  return <button className={className} title={title} disabled={disabled || !!busy} onClick={onClick}>{face}</button>
}

// ---------------- what someone knows: one editor, used by the event inspector, the knowledge lens and character sheets ----------------

export const KSTATES: { id: KState; label: string }[] = [{ id: 'knows', label: 'Knows' }, { id: 'almost', label: 'Almost' }, { id: 'believes', label: 'Believes otherwise' }, { id: 'never', label: 'Never' }, { id: '', label: 'Not decided' }]
export const kLabel = (st: KState) => KSTATES.find(k => k.id === st)?.label || 'Not decided'
const noteLabel = (st: KState) => st === 'believes' ? 'What they believe instead' : st === 'almost' ? 'How close they get' : 'Note'

/** Edit what one entity knows of one fact: state, a note, and where they learn it. */
export function KnowledgeEditor({ s, f, who }: { s: State; f: Fact; who: string }) {
  const c: KCell = f.knows[who] || { state: '' }
  const name = nameOf(s, who) || 'Someone'
  const set = (patch: Partial<KCell>, label?: string) => {
    const run = () => update<'fact'>(f.id, x => {
      const next = { ...c, ...patch }
      if (!next.state && !next.note && !next.from) delete x.knows[who]; else x.knows[who] = next
    })
    if (label) tx(label, run, false); else run()
  }
  return (
    <div className="kedit">
      <div className="row nowrap"><Av name={name} /><span className="grow"><b>{name}</b><span className="small muted clip" style={{ display: 'block' }}>{f.text || 'Untitled'}</span></span></div>
      <div className="kopts">{KSTATES.map(k => (
        <button key={k.id} className={'kst ' + (k.id || 'unset') + (c.state === k.id ? ' on' : '')} aria-pressed={c.state === k.id}
          onClick={() => set({ state: k.id }, `${name}: ${k.label.toLowerCase()}`)}>{k.label}</button>))}</div>
      {c.state && <label className="field"><span className="lbl">{noteLabel(c.state)}</span>
        <input className="f" value={c.note || ''} placeholder="Optional" onChange={e => set({ note: e.target.value || undefined })} /></label>}
      {c.state && c.state !== 'never' && <label className="field"><span className="lbl">From</span>
        <select className="f" value={c.from || ''} onChange={e => set({ from: e.target.value || undefined }, `${name} learns it`)}>
          <option value="">From the start</option>
          {stories(s).map(st => <optgroup key={st.id} label={st.title}>
            <option value={st.id}>{st.title} (the whole story)</option>
            {scenesOf(s, st.id).map((sc, i) => <option key={sc.id} value={sc.id}>{i + 1}. {sc.title}</option>)}
          </optgroup>)}
        </select></label>}
    </div>
  )
}

/** A knowledge state as a pill that opens the editor. Empty cells stay empty: "+ Set" shows on hover. */
export function KnowledgeChip({ s, f, who, withNote }: { s: State; f: Fact; who: string; withNote?: boolean }) {
  const c = f.knows[who]
  const st = c?.state || ''
  return <>
    <Popover trigger={o => st
      ? <button className={'kst ' + st} title={c?.note} onClick={o}>{kLabel(st)}{c?.from && st !== 'never' ? ` · ${nameOf(s, c.from)}` : ''}</button>
      : <button className={'kst-set' + (c?.note ? ' has' : '')} onClick={o}>{c?.note ? 'Not decided' : '+ Set'}</button>}>
      {() => <KnowledgeEditor s={s} f={f} who={who} />}
    </Popover>
    {withNote && c?.note && <span className="knote">{c.note}</span>}
  </>
}

// ---------------- questions: raised anywhere, decided in Questions ----------------

const SOURCE = { you: 'you', ai: 'assistant', check: 'continuity check' } as const
export const sourceOf = (q: Question) => SOURCE[q.by] || 'you'
export const kindLabel = (q: Question) => QKINDS.find(k => k.id === q.type)?.label || 'Open question'

/** One question as a compact row (character sheets, the event inspector): deciding happens in Questions. */
export function QuestionCard({ s, q, compact }: { s: State; q: Question; compact?: boolean }) {
  const status = q.dismissed ? 'Dismissed' : q.answer ? 'Decided' : ''
  return (
    <a className={'qrow' + (status ? ' done' : '') + (compact ? ' compact' : '')} href={'#questions/' + q.id}>
      <span className="row nowrap" style={{ gap: 8 }}><span className={'tag ' + q.type}>{kindLabel(q)}</span>
        <span className="lbl" style={{ fontWeight: 400 }}>{status || `${sourceOf(q)} · ${ago(q.at)}`}</span><span className="grow" />{!status && <span className="qrow-go">Decide<Icon name="right" size={12} /></span>}</span>
      <span className="qrow-text">{q.text || 'Untitled question'}</span>
      {status === 'Decided' && <span className="small muted clip">{q.answer}</span>}
    </a>
  )
}

/** Look for plot holes, contradictions and open questions; they land in Questions (one undo step). Returns the new question ids. */
export async function findProblemsInto(focus: string | undefined, signal: AbortSignal): Promise<string[]> {
  const out = await completeJSON<FoundQ[]>('check', findProblems(getState(), focus), signal)
  const ids: string[] = []
  tx(`Find problems: ${out.length} question${out.length === 1 ? '' : 's'}`, () => {
    for (const f of out) ids.push(create('question', newQuestion({
      type: (['question', 'hole', 'contradiction'] as const).includes(f.kind) ? f.kind : 'question', text: f.text, by: 'ai',
      about: [...new Set([...(f.about || []).filter(id => getState().recs[id]), ...(focus ? [focus] : [])])],
      options: (f.options || []).map(o => ({ title: o.title, detail: o.detail, proposal: o.proposal ? normalizeProposal(getState(), o.proposal) : undefined })),
    })))
  }, false)
  if (ids.length) showToast(`Found ${ids.length} problem${ids.length === 1 ? '' : 's'}. They’re in Questions.`, true, { label: 'Open', run: () => go('questions/' + ids[0]) })
  else showToast('Find problems: nothing found. The canon holds up here.')
  return ids
}

/** The Find problems button: its results go to Questions, with a toast that links there. */
export function FindProblems({ s: _s, focus, label = 'Find problems' }: { s: State; focus?: string; label?: string }) {
  const job = useJob()
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div><AIButton label={label} busy={job.busy} onClick={() => job.run('Looking for problems…', sig => findProblemsInto(focus, sig).then(() => {}))} /></div>
      {job.err && <JobStatus job={job} />}
    </div>
  )
}

/** Versions of one record from the server history, with restore. */
export function History({ id, render }: { id: string; render?: (prev: Record<string, unknown>) => ReactNode }) {
  const [vs, setVs] = useState<{ seq: number; label: string; at: number; prev: Record<string, unknown> | null }[]>()
  const [open, setOpen] = useState<number>()
  useEffect(() => { fetch('/api/history?record=' + encodeURIComponent(id)).then(r => r.json()).then(setVs) }, [id])
  if (!vs) return <p className="muted small">Loading…</p>
  if (!vs.length) return <p className="muted small">No history yet. Every change is kept from now on.</p>
  const restore = (prev: Record<string, unknown>) => tx('Restore version', () => update(id, d => {
    const rec = d as unknown as Record<string, unknown>
    for (const k of Object.keys(rec)) if (k !== 'id' && k !== 'kind') delete rec[k]
    Object.assign(rec, prev)
  }))
  return (
    <div className="stack" style={{ gap: 6 }}>
      {vs.map(v => (
        <div key={v.seq} className="hist-row">
          <div className="row nowrap"><b className="clip grow">{v.label || 'Edit'}</b><span className="small muted" title={new Date(v.at).toLocaleString()}>{ago(v.at)}</span></div>
          {v.prev ? <div className="row">
            <button className="btn sm ghost" onClick={() => setOpen(open === v.seq ? undefined : v.seq)}>{open === v.seq ? 'Hide' : 'Show before'}</button>
            <button className="btn sm ghost" onClick={() => restore(v.prev!)}>Restore the version before this</button>
          </div> : <span className="small muted">Created</span>}
          {open === v.seq && v.prev && (render ? render(v.prev) : <pre className="pre small mono" style={{ margin: 0, maxHeight: 240, overflow: 'auto' }}>{JSON.stringify(v.prev, null, 2)}</pre>)}
        </div>
      ))}
    </div>
  )
}

export { ChatPane } from './Chat.tsx'

export const openCount = (s: State) => list(s, 'question').filter(q => !q.answer && !q.dismissed).length

/** One guide: kind, title, and its text (long texts start collapsed). */
export function GuideRow({ g }: { g: Guide }) {
  const long = g.text.length > 600
  const [open, setOpen] = useState(!long)
  return (
    <div className="guide">
      <div className="row nowrap">
        <select className="f chip-select" value={g.use} aria-label="Kind" onChange={e => update<'guide'>(g.id, x => { x.use = e.target.value as GuideKind })}>{GUIDE_KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
        <input className="inline" style={{ fontWeight: 600 }} value={g.title} aria-label="Guide title" onChange={e => update<'guide'>(g.id, x => { x.title = e.target.value })} />
        {long && <button className="btn sm ghost" onClick={() => setOpen(o => !o)}>{open ? 'Collapse' : `Show · ${g.text.length.toLocaleString()} characters`}</button>}
        <button className="x" aria-label="Delete guide" title="Delete guide" onClick={() => tx(`Delete guide “${g.title}”`, () => remove(g.id))}>×</button>
      </div>
      {open && <textarea className={'f' + (long ? ' mono-area' : '')} value={g.text} aria-label="Guide text"
        placeholder={g.use === 'banned' ? 'One phrase per line' : g.use === 'rule' ? 'One short instruction' : 'How to write within this scope'} onChange={e => update<'guide'>(g.id, x => { x.text = e.target.value })} />}
    </div>
  )
}
