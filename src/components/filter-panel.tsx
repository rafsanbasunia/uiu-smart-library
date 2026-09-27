'use client'

import { useEffect, useRef } from 'react'

const DESKTOP = '(min-width: 1024px)'

/**
 * The catalogue filters. On a desktop they sit open in the sidebar; on a phone
 * they start collapsed behind a "Filters" toggle so the results are the first
 * thing a reader sees instead of two screens of checkboxes.
 */
export function FilterPanel({ summary, children }: { summary: React.ReactNode; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP)
    const sync = () => { if (ref.current) ref.current.open = mq.matches }
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  return (
    <details ref={ref} className="card overflow-hidden p-0">
      <summary
        className="flex cursor-pointer items-center gap-2 border-b border-line px-4 py-3 text-sm font-medium lg:cursor-default"
        // The sidebar stays open on a desktop; only phones toggle it.
        onClick={(e) => { if (window.matchMedia(DESKTOP).matches) e.preventDefault() }}
      >
        {summary}
      </summary>
      {children}
    </details>
  )
}
