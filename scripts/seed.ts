// A small but complete sample project, for screenshots and for trying Canon out:
// node scripts/seed.ts <data-dir>   (then start Canon with CANON_DATA_DIR=<data-dir>)
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../src/main/db.ts'
import { sampleRecords } from '../src/renderer/sample.ts'

export function seed(dir: string) {
  mkdirSync(dir, { recursive: true })
  const s = new Store(join(dir, 'canon.db'))
  s.save({ group: 'seed', baseline: true, changes: sampleRecords() })
  s.close()
}

if (import.meta.url === `file://${process.argv[1]}`) seed(process.argv[2] || 'sample-data')
