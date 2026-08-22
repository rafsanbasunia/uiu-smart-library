import 'server-only'
import { sql } from './db'
import { CLOSE_HOUR, LIBRARY_TZ, OPEN_HOUR, SLOT_HOURS, libraryDate, libraryHour } from './time'

export class RuleError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

const FINE_PER_DAY = 10 // ৳10 per item per day, per the project brief

async function notify(userId: string, type: string, title: string, body: string, href?: string) {
  await sql`insert into notifications (user_id, type, title, body, href)
            values (${userId}, ${type}, ${title}, ${body}, ${href ?? null})`
}

async function rulesFor(userId: string) {
  const [row] = await sql<{ role: string; max_items: number; loan_days: number; max_renewals: number }[]>`
    select u.role::text, r.max_items, r.loan_days, r.max_renewals
    from users u join loan_rules r on r.role = u.role where u.id = ${userId}`
  if (!row) throw new RuleError('Member not found', 404)
  return row
}

/* ============================================================ holds */

export async function placeHold(userId: string, titleId: string) {
  const [title] = await sql<{ id: string; title: string; type: string }[]>`
    select id, title, type::text from titles where id = ${titleId}`
  if (!title) throw new RuleError('Title not found', 404)
  if (title.type === 'ebook') throw new RuleError('E-books do not need reserving — open it directly.')

  const [existing] = await sql`
    select 1 from holds where user_id = ${userId} and title_id = ${titleId} and status in ('queued','ready')`
  if (existing) throw new RuleError('You already have a reservation on this title.')

  const [onLoan] = await sql`
    select 1 from loans where user_id = ${userId} and title_id = ${titleId} and returned_at is null`
  if (onLoan) throw new RuleError('You already have this title on loan.')

  const rules = await rulesFor(userId)
  const [{ count }] = await sql<{ count: string }[]>`
    select count(*)::text as count from loans where user_id = ${userId} and returned_at is null`
  const [{ held }] = await sql<{ held: string }[]>`
    select count(*)::text as held from holds where user_id = ${userId} and status in ('queued','ready')`
  if (Number(count) + Number(held) >= rules.max_items) {
    throw new RuleError(`Your limit is ${rules.max_items} items at a time, including reservations.`)
  }

  const [{ outstanding }] = await sql<{ outstanding: string }[]>`
    select coalesce(sum(amount),0)::text as outstanding from fines where user_id = ${userId} and status = 'unpaid'`
  if (Number(outstanding) >= 500) {
    throw new RuleError('Clear your outstanding fines before reserving another item.')
  }

  // If a copy is free, hold it immediately (48 hours at the desk).
  const [free] = await sql<{ id: string }[]>`
    select id from copies
    where title_id = ${titleId} and status = 'available' and copy_type <> 'reference'
    order by copy_type limit 1 for update skip locked`

  if (free) {
    const [hold] = await sql<{ id: string }[]>`
      insert into holds (title_id, copy_id, user_id, status, ready_at, expires_at)
      values (${titleId}, ${free.id}, ${userId}, 'ready', now(), now() + interval '48 hours')
      returning id`
    await sql`update copies set status = 'held' where id = ${free.id}`
    await notify(userId, 'hold_ready', 'Ready for pickup',
      `“${title.title}” is waiting at the circulation desk. Collect it within 48 hours.`, '/loans')
    return { status: 'ready' as const, holdId: hold!.id, position: 0 }
  }

  const [hold] = await sql<{ id: string }[]>`
    insert into holds (title_id, user_id, status) values (${titleId}, ${userId}, 'queued') returning id`
  const [{ position }] = await sql<{ position: string }[]>`
    select count(*)::text as position from holds
    where title_id = ${titleId} and status = 'queued' and placed_at <= (select placed_at from holds where id = ${hold!.id})`
  await notify(userId, 'hold_queued', 'Added to the queue',
    `You are number ${position} in the queue for “${title.title}”. We will tell you when a copy is ready.`, '/loans')
  return { status: 'queued' as const, holdId: hold!.id, position: Number(position) }
}

export async function cancelHold(userId: string, holdId: string) {
  const [hold] = await sql<{ id: string; copy_id: string | null; user_id: string }[]>`
    select id, copy_id, user_id from holds where id = ${holdId}`
  if (!hold) throw new RuleError('Reservation not found', 404)
  if (hold.user_id !== userId) throw new RuleError('That reservation is not yours', 403)
  await sql`update holds set status = 'cancelled' where id = ${holdId}`
