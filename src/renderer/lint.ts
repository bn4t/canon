export interface LintHit { line: number; msg: string; excerpt: string }

/**
 * Deterministic style checks. Em dashes are allowed only for interrupted speech
 * (dash right before a closing quote or at line end, or a stutter inside dialogue)
 * and as field separators in record-like lines (short, no sentence punctuation).
 * ponytail: heuristic; a narration line that happens to look like a record line slips through.
 */
export function lint(text: string, banned: string[] = [], emDash = true): LintHit[] {
  const hits: LintHit[] = []
  text.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd()
    const recordLike = line.length < 90 && !/[.!?"”]$/.test(line)
    for (let j = emDash ? line.indexOf('—') : -1; j >= 0; j = line.indexOf('—', j + 1)) {
      const next = line[j + 1] ?? ''
      const inQuote = ((line.slice(0, j).match(/["“”]/g) || []).length % 2) === 1
      const interrupted = next === '' || /["”'’]/.test(next) || (inQuote && /\S/.test(line[j - 1] ?? '') && /\S/.test(next))
      if (!interrupted && !recordLike) hits.push({ line: i + 1, msg: 'Em dash as prose punctuation', excerpt: line.slice(Math.max(0, j - 40), j + 40) })
    }
    for (const b of banned) {
      const k = line.toLowerCase().indexOf(b.toLowerCase())
      if (b && k >= 0) hits.push({ line: i + 1, msg: `Banned phrase: “${b}”`, excerpt: line.slice(Math.max(0, k - 30), k + b.length + 30) })
    }
  })
  return hits
}
