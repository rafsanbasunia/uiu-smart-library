import 'server-only'
import { NextResponse } from 'next/server'
import { RuleError } from './circulation'
import { getSession } from './session'
import type { SessionUser } from './types'

export type Handler<T> = (ctx: { user: SessionUser; body: T; req: Request }) => Promise<unknown>

/**
 * Postgres errors that mean the request was wrong, not the server. Without
 * this, a malformed id or an unknown enum value surfaced as a 500.
 *   22P02 invalid text (a non-uuid id, an unknown enum value)
 *   22003 number out of range       23514 check constraint failed
 *   23503 referenced row missing    23505 duplicate
 */
const CLIENT_ERRORS: Record<string, { status: number; message: string }> = {
  '22P02': { status: 400, message: 'That request contained an invalid value.' },
  '22003': { status: 400, message: 'A number in that request is out of range.' },
  '23514': { status: 400, message: 'That value is not allowed.' },
  '23503': { status: 404, message: 'Something that request refers to does not exist.' },
  '23505': { status: 409, message: 'That already exists.' },
}

/**
 * Wraps a route handler with the session check and a single, consistent error
 * shape. Business-rule failures come back as a readable message the UI shows
 * verbatim; anything else is logged and reported as a server error.
 */
export function route<T = Record<string, unknown>>(handler: Handler<T>, opts: { staff?: boolean } = {}) {
  return async (req: Request) => {
    try {
      const user = await getSession()
      if (!user) return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 })
      if (opts.staff && user.role !== 'staff') {
        return NextResponse.json({ error: 'Library staff only.' }, { status: 403 })
      }
      let body = {} as T
      if (req.method !== 'GET' && req.headers.get('content-type')?.includes('json')) {
        body = (await req.json().catch(() => ({}))) as T
      }
      const data = await handler({ user, body, req })
      return NextResponse.json(data ?? { ok: true })
    } catch (err) {
      if (err instanceof RuleError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      const pg = CLIENT_ERRORS[(err as { code?: string })?.code ?? '']
      if (pg) return NextResponse.json({ error: pg.message }, { status: pg.status })
      console.error('[api]', err)
      return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
    }
  }
}
