// Research files: stored in the open project's `files/` folder under unique, safe names, and served at GET /api/files?name=….
// Records (kind "research") live in the database like everything else; a file is never deleted when its record is,
// so undo can always bring an item back whole.
import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { projectDir, type ApiOptions } from './api.ts'
import { BadRequest, body, bytes, json, none, text, type Routes } from './http.ts'

const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg',
  // Chromium plays H.264 .mov files when they are served as mp4.
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
}
/** A file's type from its name. Anything we don't render (HTML included: it would run as the app) is a download. */
export const mimeOf = (name: string) => MIME[extname(name).slice(1).toLowerCase()] || 'application/octet-stream'

/** A unique stored name that keeps something of the original: "Tide tables 1952.pdf" → "tide-tables-1952-k3x9q2.pdf". */
export function safeName(original: string, rand = () => randomBytes(4).toString('hex').slice(0, 6)) {
  const ext = extname(original).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)
  const stem = basename(original, extname(original)).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'file'
  return `${stem}-${rand()}${ext ? '.' + ext : ''}`
}
/** Only names safeName could have made: no paths, no dot files. */
export const validName = (n: string) => /^[a-z0-9][a-z0-9-]*(\.[a-z0-9]{1,8})?$/.test(n) && n.length <= 80

const filesDir = (o: ApiOptions) => join(projectDir(o), 'files')
function fileFor(o: ApiOptions, name: string) {
  if (!validName(name)) throw new BadRequest('bad file name')
  return join(filesDir(o), name)
}
/** Write bytes under a fresh name; returns what the record needs. */
function store(o: ApiOptions, original: string, data: Uint8Array | { copy: string }) {
  mkdirSync(filesDir(o), { recursive: true, mode: 0o700 })
  let name = safeName(original)
  while (existsSync(join(filesDir(o), name))) name = safeName(original)
  const path = join(filesDir(o), name)
  if ('copy' in data) copyFileSync(data.copy, path); else writeFileSync(path, data)
  return { file: name, name: basename(original), size: statSync(path).size, mime: mimeOf(original).split(';')[0] }
}

// Files never run as the app: everything but PDFs (Chromium's viewer needs plugins) is sandboxed with no scripts.
const LOCKED = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"
const stream = (path: string, start?: number, end?: number) => Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream

function serve(o: ApiOptions, name: string, range: string | null): Response {
  const path = fileFor(o, name)
  let size: number
  try { const st = statSync(path); if (!st.isFile()) throw new Error(); size = st.size } catch { return text('not found', 404) }
  const type = mimeOf(name)
  const head: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable' }
  if (type !== 'application/pdf') head['Content-Security-Policy'] = LOCKED
  const m = range?.match(/^bytes=(\d*)-(\d*)$/)
  if (m && (m[1] || m[2])) {
    // "bytes=100-" (from 100), "bytes=-500" (the last 500), "bytes=0-99"
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    return new Response(size ? stream(path, start, end) : null, { status: 206, headers: { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } })
  }
  return new Response(size ? stream(path) : null, { status: 200, headers: { ...head, 'Content-Length': String(size) } })
}

// ---------------- web clipping: a page's title and readable text ----------------

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß' }
const decode = (t: string) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all }
  return ENT[e.toLowerCase()] ?? all
})
/** Readable text from HTML: the article (or main, or body) without scripts, menus and furniture, one paragraph per block. */
export function readable(html: string): { title: string; text: string } {
  const meta = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i)?.[1] || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i)?.[1]
  const title = decode((meta || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim())
  let h = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|template|svg|iframe|nav|header|footer|aside|form|button|select|figure)\b[\s\S]*?<\/\1>/gi, ' ')
  const part = (tag: string) => h.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)<\\/${tag}>`, 'i'))?.[1]
  h = part('article') || part('main') || part('body') || h
  const out = decode(h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(p|div|h[1-6]|li|blockquote|tr|section|dd|dt|pre|table|ul|ol)\b[^>]*>/gi, '\n\n').replace(/<[^>]+>/g, ''))
    .split(/\n{2,}/).map(p => p.replace(/[ \t\r\f\v\n]+/g, ' ').trim()).filter(Boolean).join('\n\n')
  return { title, text: out.slice(0, 200_000) }
}

async function clip(o: ApiOptions, url: string) {
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new BadRequest('Paste a web address that starts with http:// or https://')
  const r = await (o.fetchImpl ?? fetch)(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5', 'User-Agent': 'Mozilla/5.0 (Macintosh) Canon' } })
  if (!r.ok) throw new Error(`The page answered ${r.status}${r.statusText ? ' ' + r.statusText : ''}.`)
  const type = r.headers.get('content-type') || ''
  if (type && !/text\/(html|plain)|xhtml/.test(type)) throw new Error(`That address is a ${type.split(';')[0]}, not a web page. Download it and add the file instead.`)
  // Read at most 5 MB: enough for any article, and a guard against endless pages.
  const reader = r.body?.getReader(), parts: Uint8Array[] = []
  let n = 0
  if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.length; if (n > 5 << 20) { reader.cancel(); break } }
  const raw = new TextDecoder().decode(Buffer.concat(parts))
  const page = /text\/plain/.test(type) ? { title: '', text: raw.slice(0, 200_000) } : readable(raw)
  return { ...page, url: r.url || url, title: page.title || new URL(r.url || url).hostname.replace(/^www\./, '') }
}

export function researchRoutes(o: ApiOptions): Routes {
  return {
    'POST /api/research/upload': async (r, u) => json(store(o, u.searchParams.get('name') || 'file', await bytes(r))),
    'POST /api/research/pick': async () => {
      const paths = await o.host.pickFiles('Add to Research')
      return json(paths.map(p => store(o, basename(p), { copy: p })))
    },
    'GET /api/files': (r, u) => serve(o, u.searchParams.get('name') || '', r.headers.get('range')),
    'POST /api/research/clip': async r => json(await clip(o, String((await body<{ url: string }>(r)).url || '').trim())),
    'POST /api/research/reveal': async r => { o.host.reveal(fileFor(o, (await body<{ file: string }>(r)).file)); return none() },
  }
}
