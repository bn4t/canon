import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Write via a temp file and rename, so a crash never leaves half a file. */
export function writeAtomic(path: string, data: string | Uint8Array, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.canon-${randomBytes(6).toString('hex')}`)
  try {
    writeFileSync(tmp, data)
    chmodSync(tmp, mode)
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

export const randToken = () => randomBytes(24).toString('base64url')
