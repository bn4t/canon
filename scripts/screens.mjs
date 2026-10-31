// Screenshot every view of the built app, in light and dark, against the sample project.
// npm run build && xvfb-run -a npm run screens [-- route ...]   → .screens/*.png
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seed } from './seed.ts'

// Use a project-local Playwright if there is one, else the machine's global install.
const { _electron } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || 'playwright')

const routes = process.argv.slice(2).length ? process.argv.slice(2) : [
  'write/st_ledger/sc1', 'write/st_ledger/sc2', 'story/st_ledger', 'world/ent_ines', 'timeline/ev2', 'knowledge', 'questions', 'project/ai', 'project/progress', 'welcome',
]
const out = '.screens'
mkdirSync(out, { recursive: true })
const dir = mkdtempSync(join(tmpdir(), 'canon-screens-'))
seed(dir)
writeFileSync(join(dir, 'settings.json'), JSON.stringify({ jobs: { build: { provider: 'chatgpt', model: 'gpt-5.5' }, check: { provider: 'chatgpt', model: 'gpt-5.5' }, assist: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' }, chat: { provider: 'chatgpt', model: 'gpt-5.5', effort: 'medium' } } }))
writeFileSync(join(dir, 'window.json'), JSON.stringify({ width: Number(process.env.W || 1440), height: Number(process.env.H || 900) }))

const app = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.', '--no-sandbox'], env: { ...process.env, CANON_DATA_DIR: dir, NODE_OPTIONS: '' } })
const page = await app.firstWindow()
page.on('console', m => { if (m.type() === 'error') console.log('console:', m.text()) })
page.on('pageerror', e => console.log('pageerror:', e.message))
await page.waitForSelector('#root > *')
for (const scheme of (process.env.SCHEMES || 'light,dark').split(',')) {
  await page.emulateMedia({ colorScheme: scheme })
  for (const r of routes) {
    if (r === 'assistant') { await page.evaluate(() => dispatchEvent(new CustomEvent('canon:menu', { detail: 'assistant' }))); continue }
    if (r === 'sidebar') { await page.evaluate(() => dispatchEvent(new CustomEvent('canon:menu', { detail: 'sidebar' }))); continue }
    if (r === 'palette') { await page.keyboard.press('Control+k'); await page.keyboard.type('led'); await page.waitForTimeout(250); await page.screenshot({ path: join(out, `palette-${scheme}.png`) }); await page.keyboard.press('Escape'); continue }
    if (r === 'notes') { await page.locator('.director .seg button', { hasText: 'Notes' }).click(); await page.waitForTimeout(250); await page.screenshot({ path: join(out, `notes-${scheme}.png`) }); continue }
    if (r === 'focus') { await page.evaluate(() => dispatchEvent(new CustomEvent('canon:menu', { detail: 'focus' }))); await page.waitForTimeout(300); await page.screenshot({ path: join(out, `focus-${scheme}.png`) }); await page.keyboard.press('Escape'); continue }
    if (r === 'welcome') {
      await page.evaluate(() => fetch('/api/records', { method: 'POST', body: JSON.stringify({ group: 'x', baseline: true, changes: [{ id: 'project', data: null }] }) }))
      await page.evaluate(() => location.reload())
      await page.waitForTimeout(600)
    } else {
      await page.evaluate(h => { location.hash = h }, r)
      await page.waitForTimeout(450)
    }
    const name = `${r.replace(/\//g, '_')}-${scheme}.png`
    await page.screenshot({ path: join(out, name) })
    console.log(name)
  }
}
await app.close()
