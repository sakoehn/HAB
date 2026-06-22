// ── API Utilities ─────────────────────────────────────────────────────────────
// Thin wrappers around fetch and file download — no React imports.
// All network requests in the app go through apiFetch so timeout and
// error handling are consistent everywhere.

const FETCH_TIMEOUT_MS = 30_000

// ── apiFetch ───────────────────────────────────────────────────────────────
// Generic typed fetch with a 30-second abort timeout.
// Throws on non-2xx responses so callers can catch uniformly.
//
// Usage:
//   const data = await apiFetch<{ data: AnnotationItem[] }>('/api/series/annotations?...')

export async function apiFetch<T>(path: string): Promise<T> {
  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(path, { signal: controller.signal })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.json() as Promise<T>
  } finally {
    clearTimeout(timer)
  }
}

// ── downloadCsv ────────────────────────────────────────────────────────────
// Serialise an array of plain objects to CSV and trigger a browser download.
// Values containing commas, quotes, or newlines are quoted and escaped.
// Skips silently if rows is empty.
//
// Usage:
//   downloadCsv(rows, 'egc_timeseries.csv')

export function downloadCsv(rows: Record<string, unknown>[], filename: string): void {
  if (!rows.length) return

  const cols   = Object.keys(rows[0])
  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }

  const csv  = [
    cols.join(','),
    ...rows.map(r => cols.map(c => escape(r[c])).join(',')),
  ].join('\n')

  const blob = new Blob([csv], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
