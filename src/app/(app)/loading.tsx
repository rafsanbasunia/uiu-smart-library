/**
 * Shown while a signed-in page is rendering on the server. Every page here
 * queries the database before it can paint, so without this a click in the
 * sidebar gave no feedback until the next page was ready.
 */
export default function Loading() {
  return (
    <div className="animate-pulse" role="status" aria-label="Loading">
      <div className="h-3 w-24 rounded bg-line-2" />
      <div className="mt-3 h-8 w-64 max-w-full rounded bg-line-2" />
      <div className="mt-3 h-4 w-96 max-w-full rounded bg-line-2" />

      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card h-20 p-4">
            <div className="h-3 w-16 rounded bg-line-2" />
            <div className="mt-3 h-5 w-10 rounded bg-line-2" />
          </div>
        ))}
      </div>

      <div className="mt-6 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="card flex items-center gap-4 p-4">
            <div className="h-16 w-12 shrink-0 rounded bg-line-2" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-2/3 rounded bg-line-2" />
              <div className="h-3 w-1/3 rounded bg-line-2" />
            </div>
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  )
}
