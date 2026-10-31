// Pure find & replace over plain text (used by views/Find.tsx).
export interface FindOpts { matchCase?: boolean; wholeWord?: boolean; regex?: boolean }
export interface Match { start: number; end: number; text: string }

/** Throws on an invalid regex. */
export function makeRe(query: string, o: FindOpts, flags = 'g') {
  const src = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(o.wholeWord ? `\\b(?:${src})\\b` : src, flags + (o.matchCase ? '' : 'i'))
}

export function findMatches(text: string, query: string, o: FindOpts = {}): Match[] {
  if (!query) return []
  const re = makeRe(query, o), out: Match[] = []
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0]) { re.lastIndex++; continue } // zero-length regex match
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
  }
  return out
}

/** What one match becomes: literal text, or with $1-style groups in regex mode. */
export const replacement = (m: Match, query: string, repl: string, o: FindOpts = {}) => (o.regex ? m.text.replace(makeRe(query, o, ''), repl) : repl)

export const replaceOne = (text: string, m: Match, query: string, repl: string, o: FindOpts = {}) =>
  text.slice(0, m.start) + replacement(m, query, repl, o) + text.slice(m.end)

export function replaceAll(text: string, query: string, repl: string, o: FindOpts = {}) {
  if (!query) return text
  const re = makeRe(query, o)
  return o.regex ? text.replace(re, repl) : text.replace(re, () => repl)
}
