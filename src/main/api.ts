// The renderer's API: a plain Request → Response function, served over canon://app/api/ by the
// Electron main process (no network port). Native parts (dialogs, PDF, Finder) come in through Host,
// so this module runs under plain Node for tests.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep, extname } from 'node:path'
import { Store, BadRequest, type ChangeSet } from './db.ts'
import { AuthStore, openrouterStart, PROVIDERS } from './auth.ts'
import { ChatGPT } from './siwc.ts'
import { AI, type AIRequest } from './ai.ts'
import { epub, type Book } from './epub.ts'
import { writeAtomic } from './files.ts'
import { json, text, none, body, type Routes } from './http.ts'
import { researchRoutes } from './research.ts'
import { importRoutes } from './convert.ts'
import { projectRoutes } from './projects.ts'
import { exportRoutes } from './exporter.ts'

export interface Host {
  /** Native folder picker; undefined when cancelled. */
  pickFolder(title: string): Promise<string | undefined>
  /** Native save dialog, then write; the saved path, or undefined when cancelled. */
  save(defaultName: string, data: Uint8Array): Promise<string | undefined>
  /** Render a standalone HTML document to PDF. */
  pdf(html: string): Promise<Uint8Array>
  /** Show the system print dialog for a standalone HTML document. */
  print(html: string): Promise<void>
  /** Native open dialog for files; [] when cancelled. `filters`: e.g. [{ name: 'Word', extensions: ['docx'] }]. */
  pickFiles(title: string, filters?: { name: string; extensions: string[] }[], multi?: boolean): Promise<string[]>
  /** Move a file or folder to the Trash. */
  trash(path: string): Promise<void>
  /** Reload the renderer (after switching projects). */
  reload(): void
  reveal(path: string): void
  openExternal(url: string): void
  /** Something outside the renderer changed (e.g. a sign-in finished in the browser). */
  notify(event: string): void
}

/** The options object is live: switching projects replaces `store` and `projectDir` on it (see projects.ts), and every route reads them per request.
 * `dataDir`: machine-wide (settings, sign-ins, the project list). `projectDir`: the open project's folder (its database, `files/`, `backups/`); dataDir when unset. */
export interface ApiOptions { store: Store; dataDir: string; host: Host; root?: string; version?: string; fetchImpl?: typeof fetch; projectDir?: string; dbPath?: string }
export const projectDir = (o: ApiOptions) => o.projectDir || o.dataDir
export const dbPath = (o: ApiOptions) => o.dbPath || join(projectDir(o), 'canon.db')

export function createApi(o: ApiOptions) {
  const auth = new AuthStore(join(o.dataDir, 'auth.json'))
  const chatgpt = new ChatGPT(auth, () => o.host.notify('auth'))
  const ai = new AI(auth, chatgpt, o.fetchImpl)
  let root = o.root

  /** Resolve a slash path inside the story folder, rejecting escapes. */
  const safePath = (p: string) => {
    if (!root) throw new BadRequest('No story folder chosen.')
    const full = resolve(root, ...p.split('/'))
    const rel = relative(root, full)
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || resolve(rel) === rel) throw new BadRequest(`path outside story folder: "${p}"`)
    return full
  }
  /** Editable text files in the story folder, skipping dot-dirs and node_modules. */
  const tree = () => {
    const out: string[] = []
    if (!root) return out
    const walk = (dir: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, d.name)
        if (d.isDirectory()) { if (!d.name.startsWith('.') && d.name !== 'node_modules') walk(p) }
        else if (['.txt', '.md', '.json'].includes(extname(d.name))) out.push(relative(root!, p).split(sep).join('/'))
      }
    }
    walk(root)
    return out.sort()
  }
  const settingsPath = join(o.dataDir, 'settings.json')

  const routes: Routes = {
    ...researchRoutes(o), ...importRoutes(o), ...projectRoutes(o), ...exportRoutes(o),
    'GET /api/info': () => json({ root: root || '', dataDir: o.dataDir, projectDir: projectDir(o), db: dbPath(o), backups: join(projectDir(o), 'backups'), version: o.version || '' }),
    'GET /api/records': () => json(o.store.list()),
    'POST /api/records': async r => { o.store.save(await body<ChangeSet>(r)); return none() },
    'POST /api/undo': () => json(o.store.step(true)),
    'POST /api/redo': () => json(o.store.step(false)),
    'GET /api/history': (_, u) => { const rec = u.searchParams.get('record'), n = Number(u.searchParams.get('limit')); return json(rec ? o.store.history(rec, n || 50) : o.store.recent(n || 8)) },

    // The story folder is chosen with a native picker and only ever read.
    'POST /api/root': async () => { const p = await o.host.pickFolder('Choose your story folder'); if (p) root = p; return json({ root: root || '', picked: !!p }) },
    'GET /api/tree': () => json(tree()),
    'GET /api/file': (_, u) => {
      const p = safePath(u.searchParams.get('path') || '')
      try { if (!statSync(p).isFile()) return text('not found', 404) } catch { return text('not found', 404) }
      return text(readFileSync(p, 'utf8'), 200)
    },

    // Files leave the app through a save dialog.
    'POST /api/save': async (r, u) => {
      const path = await o.host.save(u.searchParams.get('name') || 'canon.txt', new Uint8Array(await r.arrayBuffer()))
      return json({ path: path || '' })
    },
    'POST /api/export/epub': async (r, u) => {
      const b = await body<Book>(r)
      const path = await o.host.save(u.searchParams.get('name') || 'canon.epub', epub(b))
      return json({ path: path || '' })
    },
    'POST /api/export/pdf': async (r, u) => {
      const { html } = await body<{ html: string }>(r)
      const path = await o.host.save(u.searchParams.get('name') || 'canon.pdf', await o.host.pdf(html))
      return json({ path: path || '' })
    },
    'POST /api/backup': async () => {
      const d = new Date().toLocaleDateString('sv')
      const path = await o.host.save(`canon-backup-${d}.json`, new TextEncoder().encode(JSON.stringify(o.store.list(), null, 1)))
      return json({ path: path || '' })
    },
    'POST /api/reveal': async r => { const { path } = await body<{ path: string }>(r); o.host.reveal(path); return none() },
    'POST /api/open': async r => {
      const { url } = await body<{ url: string }>(r)
      if (!/^https?:\/\//.test(url)) throw new BadRequest('only web links')
      o.host.openExternal(url); return none()
    },

    // Settings (model per job) are machine-local and owned by the renderer; stored as an opaque blob.
    'GET /api/settings': () => { try { return json(JSON.parse(readFileSync(settingsPath, 'utf8'))) } catch { return json({}) } },
    'PUT /api/settings': async r => { writeAtomic(settingsPath, JSON.stringify(await body(r, 1 << 20)), 0o600); return none() },

    'GET /api/auth/status': () => json(auth.status()),
    'POST /api/auth/chatgpt': async () => { const url = await chatgpt.start(); o.host.openExternal(url); return json({ url }) },
    'POST /api/auth/openrouter': async () => { const url = await openrouterStart(auth, () => o.host.notify('auth')); o.host.openExternal(url); return json({ url }) },
    'PUT /api/auth/key': async r => {
      const b = await body<{ provider: string; key: string }>(r)
      if (!b.key?.trim()) throw new BadRequest('provider and key required')
      if (b.provider !== 'opencode-go' && b.provider !== 'openrouter') throw new BadRequest('unknown provider')
      auth.set(b.provider, { key: b.key.trim() })
      return none()
    },
    'GET /api/models': async (_, u) => {
      try { return json(await ai.models(u.searchParams.get('provider') || '')) } catch (e) { return text(String(e instanceof Error ? e.message : e), 502) }
    },
    'POST /api/ai': async r => {
      const req = await body<AIRequest>(r, 8 << 20)
      if (!req.model) throw new BadRequest('provider, model and prompt required')
      return new Response(ai.stream(req), { headers: { 'Content-Type': 'application/x-ndjson' } })
    },
  }

  return async function handle(r: Request): Promise<Response> {
    const u = new URL(r.url)
    let route = routes[`${r.method} ${u.pathname}`]
    const m = u.pathname.match(/^\/api\/auth\/([\w-]+)$/)
    if (!route && r.method === 'DELETE' && m && (PROVIDERS as readonly string[]).includes(m[1])) {
      route = async () => { if (m[1] === 'chatgpt') await chatgpt.revoke(); auth.set(m[1], null); return none() }
    }
    if (!route) return text('not found', 404)
    try {
      return await route(r, u)
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), e instanceof BadRequest ? 400 : 500)
    }
  }
}
