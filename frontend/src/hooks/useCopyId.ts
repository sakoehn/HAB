// ── useCopyId ─────────────────────────────────────────────────────────────────
// Custom hook that manages clipboard copy state for annotation IDs.
//
// Returns:
//   copiedId — the ID most recently copied, or null if the 1.5s window elapsed
//   copy     — stable callback (useCallback) that writes an ID to the clipboard
//              and sets copiedId for 1.5 seconds, giving visual feedback
//
// Usage:
//   const { copiedId, copy } = useCopyId()
//   <CopyBtn id={ann.annotation_id} copiedId={copiedId} onCopy={copy} />

import { useState, useCallback } from 'react'

export function useCopyId() {
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const copy = useCallback((id: string) => {
    navigator.clipboard.writeText(id).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1500)
    })
  }, [])

  return { copiedId, copy }
}
