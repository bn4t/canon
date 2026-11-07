// Export formats built in the main process: Word (.docx) and RTF in manuscript format, the finished EPUB (with its cover), and printing.
// The renderer compiles the manuscript into a Doc (doc.ts); these routes turn it into a file and ask where to save it.
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { projectDir, type ApiOptions } from './api.ts'
import { json, none, body, BadRequest, type Routes } from './http.ts'
import { docx, rtf } from './docx.ts'
import { ebook, type Cover } from './epub.ts'
import type { Doc } from './doc.ts'

/** The cover image named by the Doc, read from the project's files folder (only a bare file name: no paths). */
export function readCover(o: ApiOptions, d: Doc): Cover | undefined {
  const f = d.cover?.file
  if (!f) return
  if (basename(f) !== f || f.startsWith('.')) throw new BadRequest('bad cover file name')
  try { return { data: new Uint8Array(readFileSync(join(projectDir(o), 'files', f))), mime: d.cover!.mime } } catch { return undefined } // a missing cover leaves the book without one
}

export function exportRoutes(o: ApiOptions): Routes {
  const save = async (u: URL, fallback: string, data: Uint8Array) => json({ path: (await o.host.save(u.searchParams.get('name') || fallback, data)) || '' })
  return {
    'POST /api/export/docx': async (r, u) => save(u, 'manuscript.docx', docx(await body<Doc>(r))),
    'POST /api/export/rtf': async (r, u) => save(u, 'manuscript.rtf', new TextEncoder().encode(rtf(await body<Doc>(r)))),
    'POST /api/export/ebook': async (r, u) => { const d = await body<Doc>(r); return save(u, 'book.epub', ebook(d, readCover(o, d))) },
    'POST /api/print': async r => { const { html } = await body<{ html: string }>(r); if (!html) throw new BadRequest('nothing to print'); await o.host.print(html); return none() },
  }
}
