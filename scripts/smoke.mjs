// End-to-end check of the built desktop app against the sample project:
// npm run build && xvfb-run -a npm run smoke
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
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

await step('opens the first scene of the sample project', async () => {
  assert.equal(await title(), 'The office at night')
  assert.match(await page.locator('.side-project b').innerText(), /Low Tide at Merrow/)
})

await step('the palette shortcut toggles it once', async () => {
  await page.locator('.doc-foot').click()
  await page.keyboard.press(`${mod}+k`)
  await page.waitForSelector('.palette')
  await page.keyboard.type('Delphine')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => location.hash.startsWith('#world/'))
  assert.equal(await page.locator('.sheet .doc-title').inputValue(), 'Delphine Calder')
  assert.equal(await page.locator('.palette').count(), 0)
})

await step('menu commands navigate', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`dispatchEvent(new CustomEvent('canon:menu', { detail: 'go:timeline' }))`))
  await page.waitForFunction(() => location.hash === '#timeline')
  await page.evaluate(() => { location.hash = 'write/st_ledger/sc1' })
  await page.waitForSelector('.prose-area')
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
  await page.locator('.doc-foot').click() // leave the field
  await page.keyboard.press(`${mod}+z`)
  await page.waitForFunction(t => document.querySelector('.doc-title').value === t, before, { timeout: 4000 })
  await page.keyboard.press(`${mod}+Shift+z`)
  await page.waitForFunction(t => document.querySelector('.doc-title').value === t, before + ' later', { timeout: 4000 })
})

await step('new scene from the menu, and it persists across a restart', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`dispatchEvent(new CustomEvent('canon:menu', { detail: 'new-scene' }))`))
  await page.waitForFunction(() => document.querySelector('.doc-title')?.value === 'New scene')
  await page.locator('.prose-area').click()
  await page.keyboard.type('The water turned.')
  await app.close() // closes the window: the shell waits for the renderer to flush
  app = await launch()
  page = await app.firstWindow()
  await page.waitForSelector('.side')
  await page.evaluate(() => { location.hash = 'write/st_ledger' })
  const n = await page.locator('.tree-scene:not(.add)').count()
  assert.equal(n, 6)
  await page.locator('.tree-scene:not(.add)').nth(5).click()
  await page.waitForFunction(() => document.querySelector('.doc-title')?.value === 'New scene')
  assert.equal(await prose(), 'The water turned.')
})

await step('exports go through the save dialog (EPUB and PDF)', async () => {
  for (const [fmt, file] of [['EPUB', 'out.epub'], ['PDF', 'out.pdf']]) {
    const target = join(dir, file)
    await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }) }, target)
    await page.evaluate(() => { location.hash = 'project/export' })
    await page.getByRole('button', { name: fmt, exact: true }).click()
    await page.getByRole('button', { name: 'Export…' }).click()
    await page.waitForSelector('.toast', { timeout: 15000 })
    assert.match(await page.locator('.toast').innerText(), new RegExp('Saved ' + file))
    assert.ok(statSync(target).size > 500, fmt + ' written')
    if (fmt === 'PDF') assert.equal(readFileSync(target).subarray(0, 4).toString(), '%PDF')
    else assert.equal(readFileSync(target).subarray(30, 38).toString(), 'mimetype')
    await page.locator('.toast .x').click()
  }
})

await step('no page errors', async () => { assert.deepEqual(errors, []) })
await app.close()
console.log('smoke: all good')
