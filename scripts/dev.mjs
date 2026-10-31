// npm run dev: Vite (with hot reload) for the renderer, esbuild --watch for the main process, and Electron
// pointed at the Vite server. Restart with Ctrl+C after changing src/main (the renderer reloads on its own).
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const run = (cmd, args, env = {}) => spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } })
const kids = []
const stop = () => { kids.forEach(k => k.kill()); process.exit() }
process.on('SIGINT', stop)

kids.push(run('npx', ['vite']))
kids.push(run('npx', ['esbuild', 'src/main/main.ts', '--bundle', '--platform=node', '--format=esm', '--target=node24', '--outfile=dist/main/main.js', '--external:electron', '--packages=external', '--watch=forever', '--log-level=warning']))

const url = 'http://localhost:5173'
for (let i = 0; i < 100; i++) {
  try { await fetch(url); break } catch { await new Promise(r => setTimeout(r, 150)) }
}
const electron = run(require('electron'), ['.'], { CANON_DEV_URL: url })
kids.push(electron)
electron.on('exit', stop)
