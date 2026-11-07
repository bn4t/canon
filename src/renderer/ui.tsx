import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useCanon, undoRedo, applyProposal, isApplied, tx, showToast, nameOf, typeDef, type Proposal, type State } from './store.ts'
import { diffWords, type Part } from './diff.ts'
import { useAI, aiReady, anyConnected, modelFor, type Job } from './ai.ts'

export const go = (h: string) => { location.hash = h }
/** Fix up the URL without a history entry; the app still hears about it. */
export const replaceRoute = (h: string) => { history.replaceState(null, '', '#' + h); dispatchEvent(new HashChangeEvent('hashchange')) }

/** Auto-growing labelled textarea (or single-line input). */
export function Area({ label, value, onChange, hint, rows = 1, single, className = '', autoFocus, placeholder }: {
  label?: ReactNode; value: string; onChange: (v: string) => void; hint?: string; rows?: number; single?: boolean; className?: string; autoFocus?: boolean; placeholder?: string
}) {
  const input = single
    ? <input className={'f ' + className} value={value} placeholder={placeholder ?? hint} autoFocus={autoFocus} onChange={e => onChange(e.target.value)} />
    : <textarea className={'f grow-area ' + className} rows={rows} value={value} placeholder={placeholder ?? hint} autoFocus={autoFocus} onChange={e => onChange(e.target.value)} />
  if (!label) return input
  return <label className="field"><span className="lbl">{label}</span>{input}</label>
}

/** Run async work with busy/error state and cancellation. */
export function useJob() {
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const ctl = useRef<AbortController>(undefined)
  const run = async (label: string, fn: (signal: AbortSignal, progress: (l: string) => void) => Promise<void>) => {
    setBusy(label); setErr('')
    ctl.current = new AbortController()
    try { await fn(ctl.current.signal, setBusy) } catch (e) { if (!ctl.current.signal.aborted) setErr(String(e).replace(/^Error: /, '')) }
    setBusy('')
  }
  return { busy, err, setErr, run, stop: () => ctl.current?.abort() }
}

export function JobStatus({ job }: { job: ReturnType<typeof useJob> }) {
  if (!job.busy && !job.err) return null
  return (
    <div className="stack">
      {job.busy && <div className="busy"><span className="spinner" />{job.busy}<button className="btn sm ghost" onClick={job.stop}>Stop</button></div>}
      {job.err && <div className="err">{job.err}<button className="x" aria-label="Dismiss" onClick={() => job.setErr('')}>×</button></div>}
    </div>
  )
}

// ---------------- proposed changes: the one way canon changes from the assistant are reviewed ----------------

const FIELD_LABEL: Record<string, string> = { summary: 'Summary', name: 'Name', text: 'Text', detail: 'Detail', answer: 'Answer', title: 'Title', card: 'Scene card', wants: 'Wants', mustLand: 'Must land', premise: 'Premise', logline: 'Logline', thesis: 'Thesis', notes: 'Notes' }
const asText = (v: unknown): string => typeof v === 'string' ? v : Array.isArray(v) ? v.map(asText).join(' · ')
  : v && typeof v === 'object' && 'state' in v ? [(v as { state: string }).state, (v as { note?: string }).note].filter(Boolean).join(': ') : v === undefined || v === null ? '' : JSON.stringify(v)
const at = (o: unknown, path: string) => path.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o)

/** What a proposal changes, one row per field: where, what it says now, what it would say. */
export function changeRows(s: State, p: Proposal): { where: string; before?: string; after: string }[] {
  if (p.op === 'edit') return [{ where: `${nameOf(s, p.id) || 'Scene'} › Text`, before: p.find, after: p.replace || '' }]
  if (p.op === 'create') {
    const d = (p.data || {}) as Record<string, unknown>
    const what = p.kind === 'fact' ? (d.at !== undefined ? 'event' : 'fact') : p.kind === 'entity' ? typeDef(s, String(d.type)).one.toLowerCase() : p.kind
    const name = asText(d.name || d.title || d.text)
    const body = asText(d.summary || d.card || d.detail || (p.kind === 'guide' ? d.text : ''))
    return [{ where: `New ${what}`, after: [name, body].filter(Boolean).join(': ') }]
  }
  const rec = p.id ? s.recs[p.id] : undefined
  return Object.entries(p.set || {}).map(([k, v]) => {
    const [head, key] = k.split('.')
    let label = FIELD_LABEL[k] || k
    if (head === 'fields' && rec?.kind === 'entity') label = typeDef(s, rec.type).fields.find(f => f.key === key)?.label || key
    else if (head === 'knows') label = `What ${nameOf(s, key) || 'someone'} knows`
    else if (head === 'meta') label = key
    return { where: `${nameOf(s, p.id) || 'Record'} › ${label}`, before: rec ? asText(at(rec, k)) : undefined, after: asText(v) }
  })
}

/** Canon changes from the assistant: tick what you want, then apply. Nothing changes before that. */
export function ProposedChanges({ s, items, onChange, title = 'Proposed changes', applyLabel, onApplied, note }: {
  s: State; items: Proposal[]; onChange: (items: Proposal[]) => void; title?: string; applyLabel?: (n: number) => string; onApplied?: (ps: Proposal[]) => void; note?: ReactNode
}) {
  const [off, setOff] = useState<Set<Proposal>>(new Set())
  if (!items.length) return null
  const open = items.filter(p => !isApplied(s, p))
  const picked = open.filter(p => !off.has(p))
  const apply = () => {
    tx(picked.length === 1 ? 'Apply a change' : `Apply ${picked.length} changes`, () => picked.forEach(applyProposal))
    onApplied?.(picked)
    if (picked.length === open.length) onChange(items.filter(p => isApplied(s, p) || picked.includes(p)))
  }
  const flip = (p: Proposal) => setOff(o => { const n = new Set(o); if (n.has(p)) n.delete(p); else n.add(p); return n })
  return (
    <div className="changes-box" role="group" aria-label={title}>
      <div className="changes-h"><span className="spark-ic"><Spark size={12} /></span><b>{title}</b><span className="lbl">{open.length ? `${picked.length} of ${open.length} selected` : 'All applied'}</span></div>
      {items.map((p, i) => {
        const done = isApplied(s, p)
        return (
          <label key={i} className={'change-row' + (done ? ' done' : '')}>
            {done ? <span className="change-done"><Icon name="check" size={12} /></span>
              : <input type="checkbox" checked={!off.has(p)} onChange={() => flip(p)} aria-label="Include this change" />}
            <span className="change-body">
              {changeRows(s, p).map((r, j) => (
                <span key={j} className="change-one">
                  <span className="lbl">{r.where}</span>
                  <span className="change-text">{r.before !== undefined && r.before.trim() ? <Diff parts={diffWords(r.before, r.after)} /> : <ins>{r.after}</ins>}</span>
                </span>
              ))}
              {p.why && <span className="small muted">{p.why}</span>}
            </span>
            {done && <span className="chip ok">Applied</span>}
          </label>
        )
      })}
      {note && <div className="change-note">{note}</div>}
      {open.length > 0 && <div className="changes-foot">
        <button className="btn sm pri" disabled={!picked.length} onClick={apply}>{applyLabel ? applyLabel(picked.length) : picked.length === 1 ? 'Apply 1 change' : `Apply ${picked.length} changes`}</button>
        <button className="btn sm ghost" onClick={() => onChange(items.filter(p => isApplied(s, p)))}>Discard</button>
      </div>}
    </div>
  )
}
/** @deprecated The old name; the same component. */
export const Proposals = ({ s, items, onChange, label }: { s: State; items: Proposal[]; onChange: (items: Proposal[]) => void; label?: string }) =>
  <ProposedChanges s={s} items={items} onChange={onChange} title={label && label !== 'Suggestions' ? label : 'Proposed changes'} />

// ---------------- the Assist menu: the same place and verbs on every screen ----------------

export interface AssistItem {
  label: string
  /** One line under the label: what it works on. */
  hint?: string
  /** Where its result lands: "Suggestions", "Margin", "Questions", "Board", "Fields"… */
  dest?: string
  run: () => void
  disabled?: boolean
  /** Works without an assistant (default: needs one). */
  local?: boolean
}
export function AssistMenu({ items, label = 'Assist', busy, className = 'right', disabled, title, footer }: {
  items: (AssistItem | 'sep')[]; label?: string; busy?: string; className?: string; disabled?: boolean
  /** A line above the items ("Assist with The Ledger · Results go to"); a line below them. */
  title?: ReactNode; footer?: ReactNode
}) {
  const st = useAI()
  const ready = aiReady(st)
  return (
    <Popover className={className} trigger={open => (
      <button className="btn sm soft assist-btn" disabled={disabled} aria-haspopup="menu" onClick={open}>
        {busy ? <span className="spinner" /> : <Spark size={13} />}{busy ? 'Working…' : label}<Icon name="down" size={12} />
      </button>
    )}>
      {close => (
        <div className="assist-menu" role="menu" aria-label={label}>
          {title && <div className="assist-menu-h">{title}</div>}
          {!ready && <ConnectPrompt compact onGo={close} />}
          {items.map((it, i) => it === 'sep' ? <div key={i} className="menu-sep" /> : (
            <button key={i} role="menuitem" className="assist-item" disabled={it.disabled || !!busy || (!ready && !it.local)} onClick={() => { close(); it.run() }}>
              <Spark size={14} />
              <span className="t"><b>{it.label}</b>{it.hint && <span>{it.hint}</span>}</span>
              {it.dest && <span className="dest">{it.dest}</span>}
            </button>
          ))}
          {footer !== undefined ? footer && <div className="assist-menu-f">{footer}</div>
            : <div className="assist-menu-f"><span className="grow">Nothing changes until you review it</span><ModelLink onGo={close} /></div>}
        </div>
      )}
    </Popover>
  )
}

/** The model a job uses, as a link to Settings › Assistant. */
export function ModelLink({ job = 'assist', onGo }: { job?: Job; onGo?: () => void }) {
  const st = useAI()
  const m = modelFor(job, st)
  return <button className="model-link" title="Change it in Settings › Assistant" onClick={() => { onGo?.(); openSettings('assistant') }}>{m.model || 'No model'}</button>
}

/** Shown wherever the assistant would act while none is connected. */
export function ConnectPrompt({ compact, onGo, what }: { compact?: boolean; onGo?: () => void; what?: string }) {
  const st = useAI()
  const connected = anyConnected(st)
  const go = () => { onGo?.(); openSettings('assistant') }
  return (
    <div className={'connect' + (compact ? ' compact' : '')}>
      <span className="spark-ic"><Spark size={12} /></span>
      <span className="grow">{connected ? 'Choose a model to use the assistant.' : `No assistant connected${what ? `: connect one to ${what}` : ''}.`}</span>
      <button className="btn sm" onClick={go}>{connected ? 'Choose a model' : 'Connect'}</button>
    </div>
  )
}

export const Spark = ({ size = 14 }: { size?: number }) =>
  <svg className="icon spark" width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l1.4 4.1L13.5 7 9.4 8.4 8 12.5 6.6 8.4 2.5 7l4.1-1.4Z" /></svg>

// ---------------- the assistant panel, from anywhere ----------------

/** Open the assistant panel and send it a question. */
export const askAssistant = (q: string) => dispatchEvent(new CustomEvent('canon:ask', { detail: q }))
/** Open the assistant panel on an interview with a character (an entity id). */
export const startInterview = (entityId: string) => dispatchEvent(new CustomEvent('canon:interview', { detail: entityId }))

// ---------------- the Settings window ----------------

export type SettingsSection = 'details' | 'goals' | 'guides' | 'labels' | 'types' | 'assistant' | 'export' | 'appearance'
let settingsOpen: SettingsSection | null = null
const settingsSubs = new Set<() => void>()
export function openSettings(section: SettingsSection = 'details') { settingsOpen = section; settingsSubs.forEach(f => f()) }
export function closeSettings() { settingsOpen = null; settingsSubs.forEach(f => f()) }
export const useSettingsSection = () => useSyncExternalStore(f => (settingsSubs.add(f), () => settingsSubs.delete(f)), () => settingsOpen)

// ---------------- appearance (per machine) ----------------

export interface Appearance { theme: 'system' | 'light' | 'dark'; prose: 'small' | 'medium' | 'large'; width: 'narrow' | 'medium' | 'wide' }
const PROSE = { small: '17px', medium: '19px', large: '21px' }, WIDTH = { narrow: '600px', medium: '680px', wide: '780px' }
export const getAppearance = (): Appearance => ({ theme: stored('canon.theme', 'system') as Appearance['theme'], prose: stored('canon.prose', 'medium') as Appearance['prose'], width: stored('canon.width', 'medium') as Appearance['width'] })
export function applyAppearance(p: Partial<Appearance> = {}) {
  const a = { ...getAppearance(), ...p }
  store('canon.theme', a.theme); store('canon.prose', a.prose); store('canon.width', a.width)
  const root = document.documentElement
  if (a.theme === 'system') delete root.dataset.theme; else root.dataset.theme = a.theme
  root.style.setProperty('--prose-size', PROSE[a.prose] || PROSE.medium)
  root.style.setProperty('--paper', WIDTH[a.width] || WIDTH.medium)
  return a
}

/** "2 hours ago", "yesterday", "3 Nov". */
export function ago(t: number | string) {
  const ms = Date.now() - new Date(t).getTime(), m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function Toast() {
  const s = useCanon()
  const [hidden, setHidden] = useState<number>()
  useEffect(() => { if (!s.toast) return; const t = setTimeout(() => setHidden(s.toast!.at), 6000); return () => clearTimeout(t) }, [s.toast])
  if (!s.toast || hidden === s.toast.at) return null
  return (
    <div className="toast" role="status">
      <span>{s.toast.text}</span>
      {s.toast.undo && <button className="btn sm" onClick={() => undoRedo(true)}>Undo</button>}
      {s.toast.action && <button className="btn sm" onClick={() => { s.toast!.action!.run(); setHidden(s.toast!.at) }}>{s.toast.action.label}</button>}
      <button className="x" aria-label="Dismiss" onClick={() => setHidden(s.toast!.at)}>×</button>
    </div>
  )
}

/** A small popover anchored to its trigger (portaled and fixed, so scroll containers can't clip it); closes on outside click, Escape or scroll. */
export function Popover({ trigger, children, className = '' }: { trigger: (open: () => void) => ReactNode; children: (close: () => void) => ReactNode; className?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number }>()
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const scroll = (e: Event) => { if (!pop.current?.contains(e.target as Node)) setOpen(false) }
    addEventListener('mousedown', off); addEventListener('keydown', esc); addEventListener('scroll', scroll, true)
    return () => { removeEventListener('mousedown', off); removeEventListener('keydown', esc); removeEventListener('scroll', scroll, true) }
  }, [open])
  useLayoutEffect(() => {
    if (!open || !ref.current || !pop.current) { setPos(undefined); return }
    const r = ref.current.getBoundingClientRect(), w = pop.current.offsetWidth, h = pop.current.offsetHeight
    const left = className.includes('right') ? r.right - w : className.includes('center') ? r.left + r.width / 2 - w / 2 : r.left
    const top = r.bottom + 6 + h > innerHeight - 8 && r.top - 6 - h > 8 ? r.top - 6 - h : r.bottom + 6
    setPos({ top: Math.max(8, Math.min(top, innerHeight - h - 8)), left: Math.max(8, Math.min(left, innerWidth - w - 8)) })
  }, [open, className])
  return <span ref={ref} className={'pop-anchor ' + className}>{trigger(() => setOpen(o => !o))}
    {open && createPortal(<div ref={pop} className="pop" style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}>{children(() => setOpen(false))}</div>, document.body)}</span>
}

/** Tiny markdown: paragraphs, bullet lists, **bold**, *italic*, `code`. */
export function Md({ text }: { text: string }) {
  const inline = (t: string) => t.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).map((p, i) =>
    p.startsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith('*') && p.length > 2 ? <i key={i}>{p.slice(1, -1)}</i> : p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p)
  const blocks = text.trim().split(/\n{2,}/)
  return <div className="md">{blocks.map((b, i) => {
    const lines = b.split('\n')
    if (lines.every(l => /^\s*([-*]|\d+\.)\s/.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>)}</ul>
    if (/^#{1,4}\s/.test(b)) return <h4 key={i}>{inline(b.replace(/^#+\s/, ''))}</h4>
    return <p key={i}>{lines.map((l, j) => <span key={j}>{inline(l)}{j < lines.length - 1 && <br />}</span>)}</p>
  })}</div>
}

// ---------------- window chrome state (per machine) ----------------

export const stored = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
export const store = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } }
interface Chrome { sidebar: boolean; assistant: boolean }
let chrome: Chrome = { sidebar: stored('canon.sidebar', '1') === '1', assistant: stored('canon.assistant', '0') === '1' }
const chromeSubs = new Set<() => void>()
export function setChrome(p: Partial<Chrome> | ((c: Chrome) => Partial<Chrome>)) {
  chrome = { ...chrome, ...(typeof p === 'function' ? p(chrome) : p) }
  store('canon.sidebar', chrome.sidebar ? '1' : '0'); store('canon.assistant', chrome.assistant ? '1' : '0')
  chromeSubs.forEach(f => f())
}
export const useChrome = () => useSyncExternalStore(f => (chromeSubs.add(f), () => chromeSubs.delete(f)), () => chrome)
export const isMac = /Mac/.test(navigator.platform)

/** After a file was saved through the shell: say where, with a way to see it. */
export function savedToast(path: string) {
  if (!path) return
  const name = path.split(/[\\/]/).pop()
  showToast(`Saved ${name}`, false, { label: isMac ? 'Show in Finder' : 'Show in folder', run: () => { fetch('/api/reveal', { method: 'POST', body: JSON.stringify({ path }) }) } })
}
export const MOD = isMac ? '⌘' : 'Ctrl+'

/** The top bar every screen has: its content on the left, actions on the right, the assistant toggle last. Doubles as the window's drag area. */
export function Bar({ children, className = '' }: { children?: ReactNode; className?: string }) {
  const c = useChrome()
  return (
    <header className={'pagehead ' + className}>
      {!c.sidebar && <button className="icon-btn" title={`Show sidebar (${MOD}\\)`} aria-label="Show sidebar" onClick={() => setChrome({ sidebar: true })}><Icon name="sidebar" /></button>}
      {children}
      <button className={'btn sm ghost assist-toggle' + (c.assistant ? ' on' : '')} title={`Assistant (${MOD}J)`} aria-label="Assistant" aria-pressed={c.assistant} onClick={() => setChrome(x => ({ assistant: !x.assistant }))}><Spark size={14} /><span>Assistant</span><kbd>{MOD}J</kbd></button>
    </header>
  )
}

/** A Bar with a title and a short line under it. */
export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return <Bar><div className="ph grow"><h1>{title}</h1>{sub && <p>{sub}</p>}</div>{children}</Bar>
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><h2>{title}</h2>{children}</div>
}

export const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])

/** Render diff parts as tracked changes. */
export const Diff = ({ parts }: { parts: Part[] }) => <>{parts.map((p, i) => p.t === 'eq' ? <span key={i}>{p.s}</span> : p.t === 'del' ? <del key={i}>{p.s}</del> : <ins key={i}>{p.s}</ins>)}</>

const ICONS: Record<string, string> = {
  write: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  board: 'M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z',
  world: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16',
  timeline: 'M3 12h18M7 8v8M12 6v12M17 9v6',
  questions: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5M12 16.5v.5',
  stories: 'M5 4h10l4 4v12H5zM15 4v4h4M8 12h8M8 16h6',
  find: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M16 16l4 4',
  scratch: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h3',
  settings: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
  director: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  project: 'M4 6h16M4 12h16M4 18h10',
  sidebar: 'M4 5h16v14H4zM9.5 5v14',
  plus: 'M12 5v14M5 12h14',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  focus: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  history: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2',
  import: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  collection: 'M4 7h16M7 4h10M5 10h14v10H5z',
  replace: 'M4 6h10M4 11h7M4 16h5M14 13l3-3 3 3M17 10v10',
  person: 'M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8M4.5 20c1-3.6 4-5.5 7.5-5.5s6.5 1.9 7.5 5.5',
  home: 'M4 10.8L12 4l8 6.8V19.3a.7.7 0 0 1-.7.7H14.5v-5.2h-5V20H4.7a.7.7 0 0 1-.7-.7z',
  lock: 'M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5M5.5 10.5h13v9.5h-13z',
  unlock: 'M7.5 10.5V8a4.5 4.5 0 0 1 8.7-1.6M5.5 10.5h13v9.5h-13z',
  comment: 'M4 5h16v11H10l-4.5 3.5V16H4z',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  card: 'M4.5 4h15v16h-15zM8 9h8M8 13h5',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  trash: 'M5 7h14M10 4h4M7 7l1 13h8l1-13',
  split: 'M4 12h16M12 4v5M12 15v5',
  merge: 'M7 4v5l5 4 5-4V4M12 13v7',
  copy: 'M8 8h11v12H8zM5 16V4h11',
  eye: 'M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5',
  drag: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
}
export const Icon = ({ name, size = 16 }: { name: keyof typeof ICONS | string; size?: number }) =>
  <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'more' || name === 'drag' ? 3 : 1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name]} /></svg>
