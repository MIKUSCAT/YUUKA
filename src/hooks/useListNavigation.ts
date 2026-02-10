import { useState } from 'react'
import { useInput } from 'ink'

interface UseListNavigationOptions {
  /** Total number of options in the list */
  count: number
  /** Initial selected index (default: 0) */
  initial?: number
  /** Called when Enter is pressed with the current index */
  onSelect: (index: number) => void
  /** Called when Escape is pressed */
  onEscape?: () => void
  /** Indices to skip during navigation (e.g. separators) */
  skipIndices?: Set<number>
  /** Disable input handling (e.g. when saving) */
  disabled?: boolean
}

/**
 * Shared list navigation hook for up/down arrow wrapping + Enter/Escape.
 * Extracts the repetitive keyboard navigation pattern used across agents.tsx.
 */
export function useListNavigation({
  count,
  initial = 0,
  onSelect,
  onEscape,
  skipIndices,
  disabled = false,
}: UseListNavigationOptions) {
  const [selectedIndex, setSelectedIndex] = useState(initial)

  useInput((input, key) => {
    if (disabled) return

    if (key.escape && onEscape) {
      onEscape()
    } else if (key.return) {
      onSelect(selectedIndex)
    } else if (key.upArrow) {
      setSelectedIndex(prev => {
        let next = prev > 0 ? prev - 1 : count - 1
        if (skipIndices) {
          while (skipIndices.has(next) && next !== prev) {
            next = next > 0 ? next - 1 : count - 1
          }
        }
        return next
      })
    } else if (key.downArrow) {
      setSelectedIndex(prev => {
        let next = prev < count - 1 ? prev + 1 : 0
        if (skipIndices) {
          while (skipIndices.has(next) && next !== prev) {
            next = next < count - 1 ? next + 1 : 0
          }
        }
        return next
      })
    }
  })

  return { selectedIndex, setSelectedIndex }
}
