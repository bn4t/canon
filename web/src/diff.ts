// Word-level diff for tracked changes and snapshot compare.
export type Part = { t: 'eq' | 'del' | 'ins'; s: string }

function lcs(a: string[], b: string[]): Part[] {
  let p = 0, q = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++
  const A = a.slice(p, a.length - q), B = b.slice(p, b.length - q)
  const out: Part[] = a.slice(0, p).map(s => ({ t: 'eq', s }))
  // ponytail: O(n·m) table; past ~4M cells the middle shows as one delete + one insert.
  if (A.length * B.length > 4e6) out.push({ t: 'del', s: A.join('') }, { t: 'ins', s: B.join('') })
  else {
    const n = A.length, m = B.length, T = new Uint32Array((n + 1) * (m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      T[i * (m + 1) + j] = A[i] === B[j] ? T[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(T[(i + 1) * (m + 1) + j], T[i * (m + 1) + j + 1])
    let i = 0, j = 0
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { out.push({ t: 'eq', s: A[i++] }); j++ }
      else if (i < n && (j === m || T[(i + 1) * (m + 1) + j] >= T[i * (m + 1) + j + 1])) out.push({ t: 'del', s: A[i++] })
      else out.push({ t: 'ins', s: B[j++] })
    }
  }
  out.push(...a.slice(a.length - q).map(s => ({ t: 'eq' as const, s })))
  return out
}

const merge = (ps: Part[]) => ps.reduce<Part[]>((o, x) => { const l = o[o.length - 1]; if (x.s && l?.t === x.t) l.s += x.s; else if (x.s) o.push({ ...x }); return o }, [])
const tokens = (t: string) => t.match(/\s+|[^\s]+/g) || []

export const diffWords = (a: string, b: string) => merge(lcs(tokens(a), tokens(b)))

/** Paragraph diff first (cheap on long texts), then words inside changed runs. */
export function diffText(a: string, b: string): Part[] {
  const lines = (t: string) => t.match(/[^\n]*\n|[^\n]+$/g) || []
  const out: Part[] = []
  let del = '', ins = ''
  const flushRun = () => { if (del || ins) out.push(...(del && ins ? diffWords(del, ins) : [{ t: del ? 'del' : 'ins', s: del || ins } as Part])); del = ins = '' }
  for (const p of lcs(lines(a), lines(b))) {
    if (p.t === 'eq') { flushRun(); out.push(p) } else if (p.t === 'del') del += p.s; else ins += p.s
  }
  flushRun()
  return merge(out)
}
