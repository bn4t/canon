// Canon's Electron main process: one window, the renderer served over canon://app/, and the API behind it.
// There is no network port and no preload: the renderer talks to the API with fetch, and menu commands
// reach it as DOM events.
import { app, BrowserWindow, Menu, dialog, nativeTheme, net, protocol, screen, shell, type MenuItemConstructorOptions } from 'electron'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './db.ts'
import { createApi, type Host } from './api.ts'
import { writeAtomic } from './files.ts'

const here = dirname(fileURLToPath(import.meta.url))
const RENDERER = join(here, '..', 'renderer')
const DEV_URL = process.env.CANON_DEV_URL // `npm run dev` points this at the Vite server
const isMac = process.platform === 'darwin'

app.setName('Canon')
const arg = (k: string) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3)
// Same place the Go version kept it (~/Library/Application Support/Canon on macOS), so existing projects open as-is.
const dataDir = process.env.CANON_DATA_DIR || arg('data-dir') || join(app.getPath('appData'), 'Canon')
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
app.setPath('userData', dataDir)
app.setPath('sessionData', join(dataDir, 'Chromium')) // keep Chromium's caches out of the way

protocol.registerSchemesAsPrivileged([{ scheme: 'canon', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false, codeCache: true } }])

if (!app.requestSingleInstanceLock()) app.quit() // one writer per database

let win: BrowserWindow | undefined
const send = (event: string, detail?: string) =>
  win?.webContents.executeJavaScript(`dispatchEvent(new CustomEvent(${JSON.stringify(event)}, { detail: ${JSON.stringify(detail ?? null)} }))`).catch(() => {})

// ---------------- window state ----------------

const statePath = join(dataDir, 'window.json')
type WinState = { x?: number; y?: number; width: number; height: number; maximized?: boolean }
function loadState(): WinState {
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf8')) as WinState
    const visible = screen.getAllDisplays().some(d => s.x !== undefined && s.y !== undefined && s.x >= d.bounds.x - 50 && s.y >= d.bounds.y - 50 && s.x < d.bounds.x + d.bounds.width && s.y < d.bounds.y + d.bounds.height)
    return visible ? s : { width: s.width, height: s.height, maximized: s.maximized }
  } catch { return { width: 1440, height: 920 } }
}
function saveState(w: BrowserWindow) {
  try { writeAtomic(statePath, JSON.stringify({ ...w.getNormalBounds(), maximized: w.isMaximized() })) } catch { /* not important */ }
}

// ---------------- native host for the API ----------------

const host: Host = {
  async pickFolder(title) {
    const r = await dialog.showOpenDialog(win!, { title, properties: ['openDirectory'] })
    return r.canceled ? undefined : r.filePaths[0]
  },
  async save(name, data) {
    const r = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath('documents'), name) })
    if (r.canceled || !r.filePath) return
    writeFileSync(r.filePath, data)
    return r.filePath
  },
  async pdf(html) {
    const file = join(tmpdir(), `canon-print-${process.pid}-${Date.now()}.html`)
    writeFileSync(file, html)
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } })
    try {
      await w.loadFile(file)
      return new Uint8Array(await w.webContents.printToPDF({ preferCSSPageSize: true, printBackground: false }))
    } finally {
      w.destroy()
      rmSync(file, { force: true })
    }
  },
  reveal: p => shell.showItemInFolder(p),
  openExternal: url => { shell.openExternal(url) },
  notify(event) {
    send('canon:notify', event)
    if (event === 'auth' && win) { if (win.isMinimized()) win.restore(); win.focus() } // back from the browser sign-in
  },
}

// ---------------- the canon:// protocol ----------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
}
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

function serveStatic(url: URL): Response | Promise<Response> {
  if (DEV_URL) return net.fetch(DEV_URL + url.pathname + url.search)
  const rel = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)).replace(/^([/\\])+/, '')
  const file = join(RENDERER, rel)
  if (!file.startsWith(RENDERER + sep)) return new Response('forbidden', { status: 403 })
  try {
    const type = MIME[extname(file)] || 'application/octet-stream'
    return new Response(readFileSync(file), { headers: { 'Content-Type': type, ...(type.startsWith('text/html') ? { 'Content-Security-Policy': CSP } : {}) } })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

// ---------------- menu ----------------

const isTyping = 'document.activeElement?.closest?.("input, textarea, select, [contenteditable]")'
function menu(): Menu {
  const cmd = (label: string, command: string, accelerator?: string, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions =>
    ({ label, accelerator, click: () => send('canon:menu', command), ...extra })
  // Undo is one item for both: inside a text field it undoes typing, elsewhere it undoes the last change to the canon.
  const history = (undo: boolean): MenuItemConstructorOptions => ({
    label: undo ? 'Undo' : 'Redo', accelerator: undo ? 'CmdOrCtrl+Z' : 'Shift+CmdOrCtrl+Z',
    click: () => win?.webContents.executeJavaScript(isTyping).then(typing => {
      if (typing) win?.webContents[undo ? 'undo' : 'redo']()
      else send('canon:menu', undo ? 'undo' : 'redo')
    }),
  })
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const, submenu: [
      { role: 'about' as const }, { type: 'separator' as const },
      cmd('Settings…', 'go:project/ai', 'Cmd+,'), { type: 'separator' as const },
      { role: 'services' as const }, { type: 'separator' as const }, { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const },
      { type: 'separator' as const }, { role: 'quit' as const },
    ] }] : []),
    { label: 'File', submenu: [
      cmd('New Scene', 'new-scene', 'CmdOrCtrl+N'),
      cmd('New Story', 'new-story', 'Shift+CmdOrCtrl+N'),
      { type: 'separator' },
      cmd('Import Files…', 'import'),
      cmd('Export…', 'go:project/export', 'CmdOrCtrl+E'),
      { type: 'separator' },
      cmd('Show Database in ' + (isMac ? 'Finder' : 'Folder'), 'reveal-data'),
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ] },
    { label: 'Edit', submenu: [
      history(true), history(false), { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' },
      { type: 'separator' },
      cmd('Find in Project', 'go:find', 'Shift+CmdOrCtrl+F'),
      ...(isMac ? [{ type: 'separator' as const }, { label: 'Speech', submenu: [{ role: 'startSpeaking' as const }, { role: 'stopSpeaking' as const }] }] : []),
    ] },
    { label: 'View', submenu: [
      cmd('Search and Commands…', 'palette', 'CmdOrCtrl+K'),
      cmd('Toggle Sidebar', 'sidebar', 'CmdOrCtrl+\\'),
      cmd('Toggle Assistant', 'assistant', 'CmdOrCtrl+J'),
      cmd('Focus Mode', 'focus', 'Shift+CmdOrCtrl+Return'),
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(app.isPackaged ? [] : [{ type: 'separator' as const }, { role: 'reload' as const }, { role: 'toggleDevTools' as const }]),
    ] },
    { label: 'Go', submenu: [
      cmd('Write', 'go:write', 'CmdOrCtrl+1'), cmd('Plan', 'go:story', 'CmdOrCtrl+2'), cmd('World', 'go:world', 'CmdOrCtrl+3'),
      cmd('Timeline', 'go:timeline', 'CmdOrCtrl+4'), cmd('Questions', 'go:questions', 'CmdOrCtrl+5'),
      { type: 'separator' },
      cmd('Previous Scene', 'scene:prev', 'Alt+CmdOrCtrl+Up'), cmd('Next Scene', 'scene:next', 'Alt+CmdOrCtrl+Down'),
      { type: 'separator' },
      cmd('Back', 'back', 'CmdOrCtrl+['), cmd('Forward', 'forward', 'CmdOrCtrl+]'),
      ...(isMac ? [] : [{ type: 'separator' as const }, cmd('Settings', 'go:project/ai', 'Ctrl+,')]),
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Sign in with ChatGPT: what Canon can see', click: () => shell.openExternal('https://developers.openai.com/siwc') },
      { label: 'Open Backups Folder', click: () => shell.openPath(join(dataDir, 'backups')) },
    ] },
  ]
  return Menu.buildFromTemplate(template)
}

// ---------------- the window ----------------

function createWindow() {
  const st = loadState()
  win = new BrowserWindow({
    ...st, minWidth: 880, minHeight: 560, show: false, title: 'Canon',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141416' : '#f7f6f3',
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } } : { autoHideMenuBar: true }),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true },
  })
  if (st.maximized) win.maximize()
  win.once('ready-to-show', () => win?.show())
  win.loadURL(`canon://app/index.html${isMac ? '?mac' : ''}`)

  // Links to the web open in the browser; the window never navigates away from the app.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('canon://app/')) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url) } })

  // Right click: spelling suggestions and the usual edit actions.
  win.webContents.on('context-menu', (_, p) => {
    const items: MenuItemConstructorOptions[] = [
      ...p.dictionarySuggestions.slice(0, 5).map(s => ({ label: s, click: () => win?.webContents.replaceMisspelling(s) })),
      ...(p.misspelledWord ? [{ label: 'Add to Dictionary', click: () => win?.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' as const }] : []),
      ...(p.isEditable ? [{ role: 'cut' as const, enabled: p.editFlags.canCut }, { role: 'copy' as const, enabled: p.editFlags.canCopy }, { role: 'paste' as const, enabled: p.editFlags.canPaste }, { role: 'selectAll' as const }]
        : p.selectionText ? [{ role: 'copy' as const }] : []),
      ...(p.linkURL && /^https?:/.test(p.linkURL) ? [{ label: 'Open Link in Browser', click: () => shell.openExternal(p.linkURL) }] : []),
    ]
    if (items.length) Menu.buildFromTemplate(items).popup()
  })

  // Hold the close until the renderer has written its pending edits.
  let flushed = false
  win.on('close', e => {
    saveState(win!)
    if (flushed) return
    e.preventDefault()
    const done = () => { flushed = true; win?.close() }
    Promise.race([win!.webContents.executeJavaScript('window.__canonFlush ? window.__canonFlush() : null'), new Promise(r => setTimeout(r, 4000))]).then(done, done)
  })
  win.on('closed', () => { win = undefined })
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })

app.whenReady().then(() => {
  const store = new Store(join(dataDir, 'canon.db'))
  try { store.backup(join(dataDir, 'backups')) } catch (e) { console.error('backup:', e) }
  const api = createApi({ store, dataDir, host, root: arg('root'), version: app.getVersion() })
  protocol.handle('canon', req => {
    const url = new URL(req.url)
    if (url.host !== 'app') return new Response('not found', { status: 404 })
    return url.pathname.startsWith('/api/') ? api(req) : serveStatic(url)
  })
  Menu.setApplicationMenu(menu())
  createWindow()
  app.on('activate', () => { if (!win) createWindow() })
  app.on('will-quit', () => store.close())
})

app.on('window-all-closed', () => { if (!isMac) app.quit() })

