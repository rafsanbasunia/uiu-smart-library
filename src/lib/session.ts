import { cookies } from 'next/headers'
import { cache } from 'react'
import { sql } from './db'
import type { SessionUser } from './types'

export const SESSION_COOKIE = 'uiu_lib_uid'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True if `v` is shaped like a UUID — safe to bind against a uuid column. */
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v)
}

/**
 * Mock authentication. The deck specifies UIU single sign-on (same credentials
 * as UCAM); there is no UCAM endpoint available to a student project, so the
 * session is a signed-in user id held in a cookie and the login screen lists
 * the seeded accounts. Everything downstream — permissions, ownership checks,
 * loan rules — behaves exactly as it would behind real SSO.
 */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies()
  const id = jar.get(SESSION_COOKIE)?.value
  // users.id is a uuid: anything else would make Postgres raise, turning a
  // stale or edited cookie into a crashed page instead of a sign-in prompt.
  if (!isUuid(id)) return null
  const rows = await sql<SessionUser[]>`
    select id, uiu_id, name, email, role, department, avatar_hue
    from users where id = ${id} and active limit 1`
  return rows[0] ?? null
})

export async function requireUser(): Promise<SessionUser> {
  const user = await getSession()
  if (!user) throw new Error('UNAUTHENTICATED')
  return user
}

export async function requireStaff(): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role !== 'staff') throw new Error('FORBIDDEN')
  return user
}
