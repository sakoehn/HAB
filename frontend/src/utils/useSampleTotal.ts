// ── useSampleTotal ────────────────────────────────────────────────────────
// How many real samples the dataset has, from /api/samples (shared with
// useAllSamples). Until that list has loaded, or if it fails, this falls
// back to the dataset's known size so "N of M samples" still reads sensibly.

import { useAllSamples } from './useAllSamples'

export const KNOWN_SAMPLE_COUNT = 128

export function useSampleTotal(): number {
  const { allSamples } = useAllSamples()
  return allSamples && allSamples.length > 0 ? allSamples.length : KNOWN_SAMPLE_COUNT
}
