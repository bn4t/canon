// Import: Word, RTF, OpenDocument, Markdown or text files, a folder of them, or a Scrivener project.
// Choose a source, see what it becomes (stories, parts, chapters, scenes, research, sheets), adjust two choices, and bring it
// in as one undoable step. The main process converts (src/main/convert.ts); importer.ts plans and writes.
import { useEffect, useMemo, useState } from 'react'
import { stories, typesOf, project, type State } from '../store.ts'
import { Icon, go } from '../ui.tsx'
import { planTree, runImport, commonTitle, countPlan, mapMeta, type ImportNode, type SplitAt, type BringAs, type PlanItem, type TreePlan } from '../importer.ts'
import './import.css'

const n = (x: number) => x.toLocaleString()
const plural = (k: number, one: string, many = one + 's') => `${n(k)} ${k === 1 ? one : many}`
const words = (t: string) => { let k = 0; for (const w of t.match(/\S+/g) || []) if (/[\p{L}\p{N}]/u.test(w)) k++; return k }
const manuscript = (x: ImportNode) => !x.research && x.kind !== 'file'

/** Always mounted: File ▸ Import… (and anything else that sends `import`). */
export function ImportHost({ s }: { s: State }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent<string>).detail === 'import') { e.preventDefault(); setOpen(true) } }
    addEventListener('canon:command', on)
    return () => removeEventListener('canon:command', on)
  }, [])
  return open ? <ImportDialog s={s} onClose={() => setOpen(false)} onDone={route => { setOpen(false); go(route) }} /> : null
}

const SOURCES: { kind: 'files' | 'folder' | 'scrivener'; icon: string; title: string; text: string }[] = [
  { kind: 'files', icon: 'stories', title: 'Documents', text: 'Word, RTF, OpenDocument, Markdown or plain text. One file or many.' },
  { kind: 'folder', icon: 'folder', title: 'A folder', text: 'Every document inside it. Subfolders become parts and chapters; pictures and PDFs go to Research.' },
  { kind: 'scrivener', icon: 'import', title: 'A Scrivener project', text: 'The Draft with its synopses, notes, labels and status. The Research folder comes too.' },
]

/** The import dialog. `onDone` gets the route to open (the new story, or Research). Also used by first run. */
export function ImportDialog({ s, onClose, onDone }: { s: State; onClose: () => void; onDone: (route: string) => void }) {
  const [nodes, setNodes] = useState<ImportNode[]>()
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [split, setSplit] = useState<SplitAt>('breaks')
  const [as, setAs] = useState<BringAs>('story')
  const [title, setTitle] = useState('')
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }; addEventListener('keydown', esc); return () => removeEventListener('keydown', esc) }, [onClose, busy])

  const pick = async (kind: 'files' | 'folder' | 'scrivener') => {
    setBusy(kind); setErr('')
    try {
      const r = await fetch('/api/import/pick', { method: 'POST', body: JSON.stringify({ kind }) })
      if (!r.ok) throw new Error(await r.text())
      const got: ImportNode[] = (await r.json()).nodes
      if (!got.length) return // cancelled
      const has = (x: ImportNode): boolean => x.kind !== 'folder' || (x.children || []).some(has)
      if (!got.some(has)) throw new Error('There’s nothing Canon can import in that folder.')
      setNodes(got); setTitle(commonTitle(got)); setAs('story'); setSplit('breaks')
    } catch (e) { setErr(String(e).replace(/^Error: /, '')) } finally { setBusy('') }
  }
  const plan = useMemo(() => (nodes ? planTree(nodes, { split, as, title }, typesOf(s)) : undefined), [nodes, split, as, title, s])
  // The top level the "a story each" choice splits at: a lone folder's contents, or the documents picked.
  const tops = useMemo(() => { const ms = (nodes || []).filter(manuscript); return ms.length === 1 && ms[0].kind === 'folder' ? (ms[0].children || []).filter(manuscript) : ms }, [nodes])
  const ms = (nodes || []).filter(manuscript)
  const name = as === 'story' ? title.trim() || 'Untitled story' : ms.length === 1 ? ms[0].title : plural(ms.length, 'document')
  const go1 = async () => {
    if (!plan) return
    setBusy('import'); setErr('')
    try { onDone(await runImport(plan, name)) } catch (e) { setErr(String(e).replace(/^Error: /, '')); setBusy('') }
  }
  const sts = s.recs.project ? stories(s) : []
  const each = tops.every(x => x.kind === 'folder') ? 'folder' : tops.every(x => x.kind !== 'folder') ? 'document' : 'folder or document'

  return (
    <div className="overlay imp-overlay" onMouseDown={() => !busy && onClose()}>
      <div className="palette imp" role="dialog" aria-label="Import" onMouseDown={e => e.stopPropagation()}>
        <div className="imp-h">
          <div className="grow"><h2>{plan ? `Import ${name}` : 'Import your writing'}</h2>
            <p className="small muted">{plan ? 'This is what it becomes. Nothing is added until you import.' : 'Canon reads it and shows you what it becomes before anything is added. The originals are only read, never changed.'}</p></div>
          <button className="x" aria-label="Close" disabled={!!busy} onClick={onClose}>×</button>
        </div>

        {!plan && <div className="imp-b">
          <div className="imp-sources">
            {SOURCES.map(x => <button key={x.kind} className="choice" disabled={!!busy} onClick={() => pick(x.kind)}>
              <Icon name={x.icon} size={20} /><b>{busy === x.kind ? 'Reading…' : x.title}</b><span>{x.text}</span></button>)}
          </div>
          {err && <div className="err">{err}</div>}
        </div>}

        {plan && <>
          <div className="imp-opts">
            <label className="field"><span className="lbl">Bring it in as</span>
              <select className="f" value={as} disabled={!!busy} onChange={e => setAs(e.target.value)}>
                <option value="story">A new story</option>
                {tops.length > 1 && <option value="stories">A story for each {each} ({tops.length})</option>}
                {sts.length > 0 && <optgroup label="Chapters at the end of">{sts.map(st => <option key={st.id} value={st.id}>{st.title || 'Untitled story'}</option>)}</optgroup>}
              </select></label>
            <label className="field"><span className="lbl">Split scenes at</span>
              <select className="f" value={split} disabled={!!busy} onChange={e => setSplit(e.target.value as SplitAt)}
                title="Scene breaks are lines like * * *. With “Scene breaks”, headings make parts and chapters; with “Headings too”, each heading starts a scene.">
                <option value="breaks">Scene breaks</option>
                <option value="headings">Headings too</option>
                <option value="none">Don’t split</option>
              </select></label>
            {as === 'story' && <label className="field"><span className="lbl">Story title</span>
              <input className="f" value={title} placeholder="Untitled story" disabled={!!busy} onChange={e => setTitle(e.target.value)} /></label>}
          </div>
          <Preview s={s} plan={plan} />
          {err && <div className="err" style={{ margin: '0 20px 12px' }}>{err}</div>}
          <div className="imp-f">
            <span className="grow small muted">{s.recs.project ? 'It comes in as one step: Undo takes it all back.' : 'This starts the project. You can rename and rearrange everything afterwards.'}</span>
            <button className="btn ghost" disabled={!!busy} onClick={() => { setNodes(undefined); setErr('') }}>Back</button>
            <button className="btn pri" disabled={!!busy || !countPlan(plan).scenes && !plan.research.length && !plan.entities.length} onClick={go1}>{busy === 'import' ? 'Importing…' : 'Import'}</button>
          </div>
        </>}
      </div>
    </div>
  )
}

/** The plan as a tree (parts, chapters, scenes with their words), then what else comes along. */
function Preview({ s, plan }: { s: State; plan: TreePlan }) {
  const c = countPlan(plan)
  const meta = mapMeta(plan.labels, plan.statuses, s.recs.project ? project(s) : {})
  const known = new Set((s.recs.project ? project(s).statuses : undefined)?.map(x => x.id) || ['todo', 'draft', 'revised', 'final'])
  const added = plan.statuses.filter(x => !known.has(meta.statusOf[x]))
  const summary = [c.stories > 1 && plural(c.stories, 'story', 'stories'), c.parts && plural(c.parts, 'part'), c.chapters && plural(c.chapters, 'chapter'), plural(c.scenes, 'scene'), plural(c.words, 'word')].filter(Boolean).join(' · ')
  const into = (id?: string) => (id ? s.recs[id] as { title?: string } | undefined : undefined)
  const LIMIT = 400
  let shown = 0
  return (
    <div className="imp-preview">
      <div className="imp-sum"><b>{summary}</b>{c.files + c.notes > 0 && <span> · research: {[c.files && plural(c.files, 'file'), c.notes && plural(c.notes, 'note')].filter(Boolean).join(', ')}</span>}{c.sheets > 0 && <span> · {plural(c.sheets, 'sheet')}</span>}</div>
      <div className="imp-tree" role="tree" aria-label="What the import becomes">
        {plan.stories.map((st, i) => {
          let part = false, chap = false
          const rows = st.items.map((x: PlanItem, j) => {
            if (shown++ >= LIMIT) return null
            if (x.kind === 'part') { part = true; chap = false }
            else if (x.kind === 'chapter') chap = true
            const depth = x.kind === 'part' ? 1 : x.kind === 'chapter' ? (part ? 2 : 1) : 1 + Number(part) + Number(chap)
            const w = x.kind === 'scene' ? words(x.prose) : 0
            const color = x.kind === 'scene' && x.label ? meta.labelOf[x.label] : undefined
            return <div key={j} role="treeitem" className={'imp-row ' + x.kind + (x.exclude ? ' out' : '')} style={{ paddingLeft: 12 + depth * 16 }}>
              {x.kind === 'scene' ? <i className="dot" style={{ background: color ? `var(--l-${color})` : 'var(--line2)' }} /> : <Icon name={x.kind === 'part' ? 'list' : 'card'} size={13} />}
              <span className="grow clip">{x.title || (x.kind === 'scene' ? 'Untitled scene' : `Untitled ${x.kind}`)}</span>
              {x.exclude && <span className="imp-tag">left out of export</span>}
              {x.kind === 'scene' && x.card && <span className="imp-tag" title={x.card}>card</span>}
              {x.kind === 'scene' && x.notes && <span className="imp-tag" title={x.notes}>notes</span>}
              <span className="imp-w">{x.kind === 'scene' ? (w ? n(w) : 'empty') : ''}</span>
            </div>
          })
          return <div key={i} className="imp-story">
            <div className="imp-row story"><Icon name="stories" size={14} /><b className="grow clip">{st.into ? `At the end of “${into(st.into)?.title || 'Untitled story'}”` : st.title || 'Untitled story'}</b>
              <span className="imp-w">{plural(st.items.filter(x => x.kind === 'scene').length, 'scene')}</span></div>
            {rows}
          </div>
        })}
        {shown > LIMIT && <p className="small muted imp-more">…and {n(shown - LIMIT)} more</p>}
        {!plan.stories.length && <p className="small muted imp-more">No manuscript in this: only research{c.sheets ? ' and sheets' : ''}.</p>}
      </div>
      {(plan.labels.length > 0 || added.length > 0 || plan.research.length > 0 || plan.entities.length > 0) && <ul className="imp-also small">
        {plan.labels.length > 0 && <li><Icon name="check" size={12} /><span>Labels: {plan.labels.map(l => { const col = meta.labelOf[l]; return <span key={l} className="imp-lab">{col ? <i className="dot" style={{ background: `var(--l-${col})` }} /> : null}{l}{col ? '' : ' (as a tag: all six label colours are named)'}</span> })}</span></li>}
        {added.length > 0 && <li><Icon name="check" size={12} /><span>New statuses: {added.join(', ')}</span></li>}
        {plan.research.length > 0 && <li><Icon name="check" size={12} /><span>{plural(plan.research.length, 'item')} to Research{c.files ? ', the files copied into the project' : ''}</span></li>}
        {plan.entities.length > 0 && <li><Icon name="check" size={12} /><span>Sheets: {plan.entities.slice(0, 6).map(e => e.name).join(', ')}{plan.entities.length > 6 ? '…' : ''}</span></li>}
      </ul>}
    </div>
  )
}
