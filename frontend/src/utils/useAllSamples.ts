// ── useAllSamples ─────────────────────────────────────────────────────────
// Fetches /api/samples once and caches the full, chronologically-sorted
// list of every real sample at module scope, so every chart that needs
// the true 128-sample timeline shares a single fetch rather than
// re-requesting per chart instance. Same "fetch once, share everywhere"
// pattern as useSolarTideData.
//
// A chart's own /series/
// annotations response only has rows for samples where that specific
// annotation was actually detected, so a chart can't tell "no data at
// this timepoint" from "this timepoint doesn't exist" using its own data
// alone. This hook supplies the full timeline so a chart can merge in an
// explicit null for every real sample its own series is missing, instead
// of the line silently running straight from one detection to the next.

import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import { parseDateTime } from './format'
import type { TimepointMeta } from '../types'

export type SampleEntry = {
  sample:   string
  datetime: string
}

type SamplesResponse = {
  data: { sample: string; timepoint: TimepointMeta | null }[]
}

type CacheState = {
  data:    SampleEntry[] | null
  loading: boolean
  error:   string | null
}

// Module-level cache + in-flight promise so concurrent mounts (many chart
// cards on Analyze/Compare at once) trigger exactly one network request.
let cache:   CacheState          = { data: null, loading: false, error: null }
let promise: Promise<void> | null = null

const listeners = new Set<() => void>()
function notify() {
  for (const l of listeners) l()
}

function load(): Promise<void> {
  if (cache.data || promise) return promise ?? Promise.resolve()
  cache = { ...cache, loading: true }
  // 128 real samples total (confirmed throughout this dataset) -- 200 is
  // headroom, not a magic number tied to that count.
  promise = apiFetch<SamplesResponse>('/api/samples?page_size=200')
    .then(res => {
      const entries = (res.data ?? [])
        .filter(row => row.timepoint?.datetime)
        .map(row => ({ sample: row.sample, datetime: row.timepoint!.datetime }))
        .sort((a, b) => parseDateTime(a.datetime) - parseDateTime(b.datetime))
      cache = { data: entries, loading: false, error: null }
    })
    .catch(err => {
      cache = { data: null, loading: false, error: String(err) }
      // Forget the failed request so the next chart that mounts tries again.
      promise = null
    })
    .finally(notify)
  return promise
}

export function useAllSamples() {
  const [, setTick] = useState(0)

  useEffect(() => {
    const listener = () => setTick(t => t + 1)
    listeners.add(listener)
    load()
    return () => {
      listeners.delete(listener)
    }
  }, [])

  return {
    allSamples:        cache.data,
    allSamplesLoading: cache.loading,
    allSamplesError:   cache.error,
  }
}
