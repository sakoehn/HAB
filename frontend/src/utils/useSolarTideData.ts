// ── useSolarTideData ─────────────────────────────────────────────────────
// Fetches /api/sun-times and /api/tides once and caches the result at
// module scope, so every chart that mounts the day/night + tide overlay
// shares a single fetch rather than re-requesting per chart instance.
// Matches the "fetch once, share everywhere" pattern already used for
// TIMEPOINTS/SUN_TIMES/TIDES on the backend.
//
// Both requests are independent (a missing tide file shouldn't block
// night shading, and vice versa) — each tracks its own loading/error
// state.

import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import type { SunTimes, TidePoint } from './solar'

type SunTimesResponse = {
  location:  string
  lat:       number
  lon:       number
  tz_offset: number
  date_min:  string | null
  date_max:  string | null
  data:      SunTimes
}

type TidesResponse = {
  station:          string
  shift_applied_hr: number
  unit:             string
  total:            number
  data:             TidePoint[]
}

type CacheState<T> = {
  data:    T | null
  loading: boolean
  error:   string | null
}

// Module-level cache + in-flight promise so concurrent mounts (e.g. three
// charts on the Compare page) trigger exactly one network request each.
let sunTimesCache:    CacheState<SunTimes>     = { data: null, loading: false, error: null }
let tidesCache:       CacheState<TidePoint[]>  = { data: null, loading: false, error: null }
let sunTimesPromise:  Promise<void> | null     = null
let tidesPromise:     Promise<void> | null     = null

const listeners = new Set<() => void>()
function notify() {
  for (const l of listeners) l()
}

function loadSunTimes(): Promise<void> {
  if (sunTimesCache.data || sunTimesPromise) return sunTimesPromise ?? Promise.resolve()
  sunTimesCache = { ...sunTimesCache, loading: true }
  sunTimesPromise = apiFetch<SunTimesResponse>('/api/sun-times')
    .then(res => {
      sunTimesCache = { data: res.data, loading: false, error: null }
    })
    .catch(err => {
      sunTimesCache = { data: null, loading: false, error: String(err) }
      // Forget the failed request so the next chart that mounts tries again.
      sunTimesPromise = null
    })
    .finally(notify)
  return sunTimesPromise
}

function loadTides(): Promise<void> {
  if (tidesCache.data || tidesPromise) return tidesPromise ?? Promise.resolve()
  tidesCache = { ...tidesCache, loading: true }
  tidesPromise = apiFetch<TidesResponse>('/api/tides')
    .then(res => {
      tidesCache = { data: res.data, loading: false, error: null }
    })
    .catch(err => {
      tidesCache = { data: null, loading: false, error: String(err) }
      tidesPromise = null
    })
    .finally(notify)
  return tidesPromise
}

// ── useSolarTideData ─────────────────────────────────────────────────────
// Lazily triggers the fetches on first call (so charts that never enable
// the overlays never pay the network cost), then re-renders subscribers
// whenever either cache updates.
//
// enabled: pass (showNightShading || showTide) from the calling chart so
// data loads only once a user actually opts into an overlay.

export function useSolarTideData(enabled: boolean) {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!enabled) return
    const listener = () => setTick(t => t + 1)
    listeners.add(listener)
    loadSunTimes()
    loadTides()
    return () => {
      listeners.delete(listener)
    }
  }, [enabled])

  return {
    sunTimes:        sunTimesCache.data,
    sunTimesLoading: sunTimesCache.loading,
    sunTimesError:   sunTimesCache.error,
    tides:           tidesCache.data,
    tidesLoading:    tidesCache.loading,
    tidesError:      tidesCache.error,
  }
}
