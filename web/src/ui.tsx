import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useCanon, undoRedo, applyProposal, isApplied, tx, type Proposal, type State } from './store.ts'
import { describe } from './prompts.ts'
import { diffWords, type Part } from './diff.ts'

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

/** Proposal cards: the AI suggests, the author applies. */
export function Proposals({ s, items, onChange, label = 'Suggestions' }: { s: State; items: Proposal[]; onChange: (items: Proposal[]) => void; label?: string }) {
  if (!items.length) return null
  const applied = (p: Proposal) => isApplied(s, p)
  const open = items.filter(p => !applied(p))
  const apply = (ps: Proposal[]) => tx(ps.length > 1 ? `Apply ${ps.length} suggestions` : 'Apply suggestion', () => ps.forEach(applyProposal))
  return (
    <div className="proposals">
      <div className="row"><span className="lbl aic">✦ {label}</span><span className="grow" />
        {open.length > 1 && <button className="btn sm" onClick={() => apply(open)}>Apply all {open.length}</button>}
        <button className="btn sm ghost" onClick={() => onChange([])}>Clear</button></div>
      {items.map((p, i) => {
        const d = describe(s, p)
        return (
          <div key={i} className={'proposal' + (applied(p) ? ' done' : '')}>
            <div className="stack" style={{ gap: 4 }}>
              <b>{d.title}</b>
              {p.op === 'edit' ? <p className="review" style={{ fontSize: 14 }}><Diff parts={diffWords(p.find || '', p.replace || '')} /></p> : d.body && <p className="pre">{d.body}</p>}
              {p.why && <p className="muted small">{p.why}</p>}
            </div>
            {applied(p) ? <span className="chip k">Applied</span> : (
              <div className="row nowrap">
                <button className="btn sm pri" onClick={() => apply([p])}>Apply</button>
                <button className="btn sm ghost" aria-label="Dismiss" onClick={() => onChange(items.filter(x => x !== p))}>×</button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
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

/** The sticky header every page uses: a title, a short line under it, actions on the right. */
export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return <header className="pagehead"><div className="ph grow"><h1>{title}</h1>{sub && <p>{sub}</p>}</div>{children}</header>
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><h2>{title}</h2>{children}</div>
}

export const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])

/** Render diff parts as tracked changes. */
export const Diff = ({ parts }: { parts: Part[] }) => <>{parts.map((p, i) => p.t === 'eq' ? <span key={i}>{p.s}</span> : p.t === 'del' ? <del key={i}>{p.s}</del> : <ins key={i}>{p.s}</ins>)}</>

const ICONS: Record<string, string> = {
  write: 'M4 20h4L19 9l-4-4L4 16z',
  world: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16',
  timeline: 'M3 12h18M7 8v8M12 6v12M17 9v6',
  questions: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5M12 16.5v.5',
  stories: 'M5 4h10l4 4v12H5zM15 4v4h4M8 12h8M8 16h6',
  find: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M16 16l4 4',
  scratch: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h3',
  settings: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
  director: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  project: 'M4 6h16M4 12h16M4 18h10',
}
export const Icon = ({ name, size = 18 }: { name: keyof typeof ICONS | string; size?: number }) =>
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name]} /></svg>
