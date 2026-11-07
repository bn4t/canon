// End-to-end check of the built desktop app against the sample project:
// npm run build && xvfb-run -a npm run smoke
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { seed } from './seed.ts'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PLAYWRIGHT_PATH || 'playwright')
const dir = mkdtempSync(join(tmpdir(), 'canon-smoke-'))
seed(dir)
const launch = () => _electron.launch({ executablePath: require('electron'), args: ['.', '--no-sandbox'], env: { ...process.env, CANON_DATA_DIR: dir, NODE_OPTIONS: '' } })
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const step = async (name, fn) => { await fn(); console.log('✓', name) }

let app = await launch()
let page = await app.firstWindow()
const errors = []
page.on('pageerror', e => errors.push(e.message))
await page.waitForSelector('.side')
const prose = () => page.locator('.prose-area').inputValue()
const title = () => page.locator('.doc-title').inputValue()
const menu = cmd => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`dispatchEvent(new CustomEvent('canon:menu', { detail: ${JSON.stringify(c)} }))`), cmd)
const blur = () => page.evaluate(() => document.activeElement?.blur())

await step('opens Home of the sample project', async () => {
  await page.waitForSelector('.home h1')
  assert.equal(await page.locator('.home h1').innerText(), 'Low Tide at Merrow')
  assert.match(await page.locator('.side-project b').innerText(), /Low Tide at Merrow/)
  assert.match(await page.locator('.home').innerText(), /Needs you/)
})

await step('the palette shortcut toggles it once', async () => {
  await blur()
  await page.keyboard.press(`${mod}+k`)
  await page.waitForSelector('.palette')
  await page.keyboard.type('Delphine')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => location.hash.startsWith('#world/'))
  await page.waitForFunction(() => [...document.querySelectorAll('input, textarea')].some(x => x.value === 'Delphine Calder'))
  assert.equal(await page.locator('.palette').count(), 0)
})

await step('menu commands navigate, and old links still land', async () => {
  await menu('go:timeline')
  await page.waitForFunction(() => location.hash === '#timeline')
  await page.evaluate(() => { location.hash = 'write/st_ledger/sc1' })
  await page.waitForFunction(() => location.hash === '#scene/sc1')
  await page.waitForSelector('.prose-area')
  assert.equal(await title(), 'The office at night')
})

await step('typing undo is native; canon undo is one step', async () => {
  const before = await title()
  await page.locator('.doc-title').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' again')
  assert.equal(await title(), before + ' again')
  await page.keyboard.press(`${mod}+z`)
  assert.equal(await title(), before, 'native undo inside the field')
  await page.keyboard.type(' later')
  await page.waitForTimeout(800) // the save queue flushes
  await blur() // leave the field
  await page.keyboard.press(`${mod}+z`)
  await page.waitForFunction(t => document.querySelector('.doc-title').value === t, before, { timeout: 4000 })
  await page.keyboard.press(`${mod}+Shift+z`)
  await page.waitForFunction(t => document.querySelector('.doc-title').value === t, before + ' later', { timeout: 4000 })
})

await step('new scene from the menu, and it persists across a restart', async () => {
  await menu('new-scene')
  await page.waitForFunction(() => document.querySelector('.doc-title')?.value === 'New scene')
  await page.locator('.prose-area').click()
  await page.keyboard.type('The water turned.')
  await app.close() // closes the window: the shell waits for the renderer to flush
  app = await launch()
  page = await app.firstWindow()
  page.on('pageerror', e => errors.push(e.message))
  await page.waitForSelector('.side')
  // The new scene was saved: find it among the stored records, then open it.
  const id = await page.evaluate(async () => (await (await fetch('/api/records')).json()).find(r => r.kind === 'scene' && r.data.title === 'New scene' && r.data.story === 'st_ledger')?.id)
  assert.ok(id, 'the new scene survived the restart')
  await page.evaluate(i => { location.hash = 'scene/' + i }, id)
  await page.waitForFunction(() => document.querySelector('.doc-title')?.value === 'New scene')
  assert.equal(await prose(), 'The water turned.')
})

await step('every settings section opens', async () => {
  await menu('settings')
  await page.waitForSelector('.settings-win')
  for (const name of ['Details and background', 'Goals', 'Guides', 'Statuses, labels and fields', 'Types and fields', 'Assistant', 'Export', 'Backups', 'Book details', 'Appearance']) {
    await page.locator('.settings-ni', { hasText: name }).click()
    await page.waitForFunction(n => document.querySelector('.settings-head h2')?.textContent === n, name)
  }
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.settings-win'))
})

await step('exports go through the save dialog (Word, EPUB and PDF)', async () => {
  for (const [card, file] of [['Manuscript for submission', 'out.docx'], ['Ebook', 'out.epub'], ['Reading copy', 'out.pdf']]) {
    const target = join(dir, file)
    await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }) }, target)
    await menu('settings:export')
    const win = page.locator('.settings-win')
    await win.waitFor()
    await win.getByRole('radio', { name: card, exact: true }).click()
    await win.getByRole('button', { name: 'Export…' }).click()
    await page.waitForSelector('.toast', { timeout: 15000 })
    assert.match(await page.locator('.toast').innerText(), new RegExp('Saved ' + file))
    const b = readFileSync(target)
    assert.ok(b.length > 500, file + ' written')
    if (file.endsWith('.pdf')) assert.equal(b.subarray(0, 4).toString(), '%PDF')
    else if (file.endsWith('.epub')) assert.equal(b.subarray(30, 38).toString(), 'mimetype')
    else assert.ok(b.subarray(0, 2).toString() === 'PK' && b.includes('word/document.xml'), 'a Word document')
    await page.locator('.toast .x').click()
  }
  await page.keyboard.press('Escape')
})

await step('the first run opens the sample project', async () => {
  await page.evaluate(() => fetch('/api/records', { method: 'POST', body: JSON.stringify({ group: 'x', baseline: true, changes: [{ id: 'project', kind: 'project', data: null }] }) }))
  await page.evaluate(() => location.reload())
  await page.waitForSelector('.setup-card')
  await page.getByRole('button', { name: /Open the sample project/ }).click()
  await page.waitForSelector('.home h1')
  assert.equal(await page.locator('.home h1').innerText(), 'Low Tide at Merrow')
})

await step('no page errors', async () => { assert.deepEqual(errors, []) })
// Electron's close can hang after the window goes; don't let that keep the run alive.
const proc = app.process() // asked for before closing: Playwright forgets it once the app has gone
await Promise.race([app.close(), new Promise(r => setTimeout(r, 3000))])
proc.kill()
console.log('smoke: all good')
process.exit(0)
