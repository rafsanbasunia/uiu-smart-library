import 'server-only'
import { sql, type Sql } from './db'
import { isUuid } from './session'
import { CLOSE_HOUR, LIBRARY_TZ, OPEN_HOUR, SLOT_HOURS, SLOT_HOURS_OF_DAY, libraryDate, libraryHour } from './time'

export class RuleError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

const FINE_PER_DAY = 10 // ৳10 per item per day, per the project brief

/*
 * Every operation below that reads state and then writes based on it runs in a
 * single transaction, and takes a row lock on whatever it is deciding about.
 * Without that, two requests could both see "copy free" and both claim it, or a
 * fine posted mid-payment could be marked paid without being charged.
 */

function requireId(id: unknown, what: string): string {
  if (!isUuid(id)) throw new RuleError(`${what} not found`, 404)
  return id
}

async function notify(tx: Sql, userId: string, type: string, title: string, body: string, href?: string) {
  await tx`insert into notifications (user_id, type, title, body, href)
           values (${userId}, ${type}, ${title}, ${body}, ${href ?? null})`
}

async function rulesFor(tx: Sql, userId: string) {
  const [row] = await tx<{ role: string; max_items: number; loan_days: number; max_renewals: number }[]>`
    select u.role::text, r.max_items, r.loan_days, r.max_renewals
    from users u join loan_rules r on r.role = u.role where u.id = ${userId}`
  if (!row) throw new RuleError('Member not found', 404)
  return row
}

/** Serialise all circulation changes for one member. */
async function lockMember(tx: Sql, userId: string) {
  await tx`select id from users where id = ${userId} for update`
}

/**
 * Give a copy that has just come free to the next reader in the queue, or put
 * it back on the shelf. Shared by returns, cancelled holds and expired holds so
 * the queue is honoured however the copy is released.
 */
async function releaseCopy(tx: Sql, copyId: string, titleId: string, title: string) {
  const [next] = await tx<{ id: string; user_id: string }[]>`
    select id, user_id from holds where title_id = ${titleId} and status = 'queued'
    order by placed_at limit 1 for update skip locked`
  if (next) {
    await tx`update holds set status='ready', copy_id=${copyId}, ready_at=now(),
             expires_at = now() + interval '48 hours' where id = ${next.id}`
    await tx`update copies set status='held', due_back=null where id = ${copyId}`
    await notify(tx, next.user_id, 'hold_ready', 'Ready for pickup',
      `“${title}” is now waiting at the circulation desk. Collect it within 48 hours.`, '/loans')
    return true
  }
  await tx`update copies set status='available', due_back=null where id = ${copyId}`
  return false
}

/* ============================================================ holds */

export async function placeHold(userId: string, titleId: string) {
  requireId(titleId, 'Title')
  return sql.begin(async (tx) => {
    await lockMember(tx, userId)

    const [title] = await tx<{ id: string; title: string; type: string }[]>`
      select id, title, type::text from titles where id = ${titleId}`
    if (!title) throw new RuleError('Title not found', 404)
    if (title.type === 'ebook') throw new RuleError('E-books do not need reserving — open it directly.')

    const [existing] = await tx`
      select 1 from holds where user_id = ${userId} and title_id = ${titleId} and status in ('queued','ready')`
    if (existing) throw new RuleError('You already have a reservation on this title.')

    const [onLoan] = await tx`
      select 1 from loans where user_id = ${userId} and title_id = ${titleId} and returned_at is null`
    if (onLoan) throw new RuleError('You already have this title on loan.')

    const rules = await rulesFor(tx, userId)
    const [{ count }] = await tx<{ count: string }[]>`
      select count(*)::text as count from loans where user_id = ${userId} and returned_at is null`
    const [{ held }] = await tx<{ held: string }[]>`
      select count(*)::text as held from holds where user_id = ${userId} and status in ('queued','ready')`
    if (Number(count) + Number(held) >= rules.max_items) {
      throw new RuleError(`Your limit is ${rules.max_items} items at a time, including reservations.`)
    }

    const [{ outstanding }] = await tx<{ outstanding: string }[]>`
      select coalesce(sum(amount),0)::text as outstanding from fines where user_id = ${userId} and status = 'unpaid'`
    if (Number(outstanding) >= 500) {
      throw new RuleError('Clear your outstanding fines before reserving another item.')
    }

    // If a copy is free, hold it immediately (48 hours at the desk). The row
    // lock means a concurrent reservation skips this copy instead of taking it too.
    const [free] = await tx<{ id: string }[]>`
      select id from copies
      where title_id = ${titleId} and status = 'available' and copy_type <> 'reference'
      order by copy_type limit 1 for update skip locked`

    if (free) {
      const [hold] = await tx<{ id: string }[]>`
        insert into holds (title_id, copy_id, user_id, status, ready_at, expires_at)
        values (${titleId}, ${free.id}, ${userId}, 'ready', now(), now() + interval '48 hours')
        returning id`
      await tx`update copies set status = 'held' where id = ${free.id}`
      await notify(tx, userId, 'hold_ready', 'Ready for pickup',
        `“${title.title}” is waiting at the circulation desk. Collect it within 48 hours.`, '/loans')
      return { status: 'ready' as const, holdId: hold!.id, position: 0 }
    }

    const [hold] = await tx<{ id: string }[]>`
      insert into holds (title_id, user_id, status) values (${titleId}, ${userId}, 'queued') returning id`
    const [{ position }] = await tx<{ position: string }[]>`
      select count(*)::text as position from holds
      where title_id = ${titleId} and status = 'queued' and placed_at <= (select placed_at from holds where id = ${hold!.id})`
    await notify(tx, userId, 'hold_queued', 'Added to the queue',
      `You are number ${position} in the queue for “${title.title}”. We will tell you when a copy is ready.`, '/loans')
    return { status: 'queued' as const, holdId: hold!.id, position: Number(position) }
  })
}

export async function cancelHold(userId: string, holdId: string) {
  requireId(holdId, 'Reservation')
  return sql.begin(async (tx) => {
    const [hold] = await tx<{ id: string; copy_id: string | null; user_id: string; status: string; title_id: string; title: string }[]>`
      select h.id, h.copy_id, h.user_id, h.status::text, h.title_id, t.title
      from holds h join titles t on t.id = h.title_id where h.id = ${holdId} for update of h`
    if (!hold) throw new RuleError('Reservation not found', 404)
    if (hold.user_id !== userId) throw new RuleError('That reservation is not yours', 403)
    // A collected hold's copy is out on loan; touching it would mark a lent
    // copy available. Only open reservations can be cancelled.
    if (hold.status !== 'queued' && hold.status !== 'ready') {
      throw new RuleError('That reservation is no longer open.')
    }
    await tx`update holds set status = 'cancelled' where id = ${holdId}`
    // A ready hold had a copy waiting: offer it to the next reader in line.
    if (hold.status === 'ready' && hold.copy_id) {
      await releaseCopy(tx, hold.copy_id, hold.title_id, hold.title)
    }
    return { ok: true }
  })
}

/** Desk: pull a free copy for a queued reservation. */
export async function markHoldReady(holdId: string) {
  requireId(holdId, 'Reservation')
  return sql.begin(async (tx) => {
    const [hold] = await tx<{ id: string; title_id: string; user_id: string; status: string; title: string }[]>`
      select h.id, h.title_id, h.user_id, h.status::text, t.title
      from holds h join titles t on t.id = h.title_id where h.id = ${holdId} for update of h`
    if (!hold) throw new RuleError('Reservation not found', 404)
    if (hold.status !== 'queued') throw new RuleError('Only a queued reservation can be marked ready.')
    // Reference copies never leave the library, so they cannot satisfy a hold.
    const [free] = await tx<{ id: string }[]>`
      select id from copies where title_id = ${hold.title_id} and status = 'available'
        and copy_type <> 'reference'
      order by copy_type limit 1 for update skip locked`
    if (!free) throw new RuleError('No copy is free to hold yet.')
    await tx`update holds set status='ready', copy_id=${free.id}, ready_at=now(),
             expires_at = now() + interval '48 hours' where id = ${hold.id}`
    await tx`update copies set status='held' where id = ${free.id}`
    await notify(tx, hold.user_id, 'hold_ready', 'Ready for pickup',
      `“${hold.title}” is waiting at the circulation desk. Collect it within 48 hours.`, '/loans')
    return { ok: true }
  })
}

/** Desk: a reservation was not collected in time. */
export async function expireHold(holdId: string) {
  requireId(holdId, 'Reservation')
  return sql.begin(async (tx) => {
    const [hold] = await tx<{ id: string; title_id: string; copy_id: string | null; status: string; title: string }[]>`
      select h.id, h.title_id, h.copy_id, h.status::text, t.title
      from holds h join titles t on t.id = h.title_id where h.id = ${holdId} for update of h`
    if (!hold) throw new RuleError('Reservation not found', 404)
    if (hold.status !== 'queued' && hold.status !== 'ready') {
      throw new RuleError('That reservation is no longer open.')
    }
    await tx`update holds set status='expired' where id = ${hold.id}`
    if (hold.status === 'ready' && hold.copy_id) {
      await releaseCopy(tx, hold.copy_id, hold.title_id, hold.title)
    }
    return { ok: true }
  })
}

/* ============================================================ renewals */

export async function renewLoan(userId: string, loanId: string) {
  requireId(loanId, 'Loan')
  return sql.begin(async (tx) => {
    const [loan] = await tx<{ id: string; user_id: string; title_id: string; due_at: string; renewals_count: number; title: string }[]>`
      select l.id, l.user_id, l.title_id, l.due_at, l.renewals_count, t.title
      from loans l join titles t on t.id = l.title_id
      where l.id = ${loanId} and l.returned_at is null for update of l`
    if (!loan) throw new RuleError('Loan not found', 404)
    if (loan.user_id !== userId) throw new RuleError('That loan is not yours', 403)

    const rules = await rulesFor(tx, userId)
    if (loan.renewals_count >= rules.max_renewals) {
      throw new RuleError(`This item has already been renewed ${rules.max_renewals} times.`)
    }

    const [{ waiting }] = await tx<{ waiting: string }[]>`
      select count(*)::text as waiting from holds where title_id = ${loan.title_id} and status = 'queued'`
    if (Number(waiting) > 0) {
      throw new RuleError(`Another reader is waiting for this title, so it cannot be renewed.`)
    }

    const base = new Date(loan.due_at) > new Date() ? new Date(loan.due_at) : new Date()
    const due = new Date(base.getTime() + rules.loan_days * 86400000)
    await tx`update loans set due_at = ${due}, renewals_count = renewals_count + 1 where id = ${loanId}`
    await tx`update copies set due_back = ${due} where id = (select copy_id from loans where id = ${loanId})`
    await notify(tx, userId, 'renewed', 'Loan renewed',
      `“${loan.title}” is now due back on ${due.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: LIBRARY_TZ })}.`, '/loans')
    return { due_at: due, renewals_count: loan.renewals_count + 1 }
  })
}

/* ============================================================ desk */

export async function issueCopy(staffId: string, accession: string, memberCode: string) {
  if (!accession || !memberCode) throw new RuleError('Scan a copy and enter the member’s UIU ID.')
  return sql.begin(async (tx) => {
    const [copy] = await tx<{ id: string; title_id: string; status: string; copy_type: string; title: string }[]>`
      select c.id, c.title_id, c.status::text, c.copy_type::text, t.title
      from copies c join titles t on t.id = c.title_id where c.accession_number = ${accession}
      for update of c`
    if (!copy) throw new RuleError(`No copy with accession number ${accession}`, 404)
    if (copy.copy_type === 'reference') throw new RuleError('Reference copies cannot leave the library.')
    if (copy.status === 'on_loan') throw new RuleError('That copy is already on loan.')
    if (copy.status === 'lost' || copy.status === 'repair') throw new RuleError(`That copy is marked ${copy.status}.`)

    const [member] = await tx<{ id: string; name: string; role: string }[]>`
      select id, name, role::text from users where uiu_id = ${memberCode} or email = ${memberCode}`
    if (!member) throw new RuleError(`No member with ID ${memberCode}`, 404)
    await lockMember(tx, member.id)

    const rules = await rulesFor(tx, member.id)
    const [{ count }] = await tx<{ count: string }[]>`
      select count(*)::text as count from loans where user_id = ${member.id} and returned_at is null`
    if (Number(count) >= rules.max_items) {
      throw new RuleError(`${member.name} already has ${count} items out (limit ${rules.max_items}).`)
    }

    // A held copy may only be issued to the reader it is being held for.
    if (copy.status === 'held') {
      const [hold] = await tx<{ user_id: string }[]>`
        select user_id from holds where copy_id = ${copy.id} and status = 'ready'`
      if (hold && hold.user_id !== member.id) {
        throw new RuleError('That copy is being held for another reader.')
      }
      if (hold) await tx`update holds set status = 'collected' where copy_id = ${copy.id} and status = 'ready'`
    }

    const due = new Date(Date.now() + rules.loan_days * 86400000)
    const [loan] = await tx<{ id: string }[]>`
      insert into loans (copy_id, title_id, user_id, due_at, issued_by)
      values (${copy.id}, ${copy.title_id}, ${member.id}, ${due}, ${staffId}) returning id`
    await tx`update copies set status = 'on_loan', due_back = ${due} where id = ${copy.id}`
    await notify(tx, member.id, 'issued', 'Item issued',
      `“${copy.title}” is due back on ${due.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: LIBRARY_TZ })}.`, '/loans')
    return { loanId: loan!.id, member: member.name, title: copy.title, due_at: due }
  })
}

export async function returnCopy(accession: string) {
  if (!accession) throw new RuleError('Scan the copy being returned.')
  return sql.begin(async (tx) => {
    const [copy] = await tx<{ id: string; title_id: string; title: string }[]>`
      select c.id, c.title_id, t.title from copies c join titles t on t.id = c.title_id
      where c.accession_number = ${accession} for update of c`
    if (!copy) throw new RuleError(`No copy with accession number ${accession}`, 404)

    const [loan] = await tx<{ id: string; user_id: string; due_at: string }[]>`
      select id, user_id, due_at from loans where copy_id = ${copy.id} and returned_at is null for update`
    if (!loan) throw new RuleError('That copy is not currently on loan.')

    await tx`update loans set returned_at = now() where id = ${loan.id}`

    // Overdue charge, posted the moment the item comes back.
    const daysLate = Math.floor((Date.now() - new Date(loan.due_at).getTime()) / 86400000)
    let fine = 0
    if (daysLate > 0) {
      fine = daysLate * FINE_PER_DAY
      await tx`insert into fines (user_id, loan_id, title_id, amount, days_late, reason)
               values (${loan.user_id}, ${loan.id}, ${copy.title_id}, ${fine}, ${daysLate}, 'Overdue return')`
      await addLedger(tx, loan.user_id, 'charge', fine, `Overdue — ${copy.title} (${daysLate} day${daysLate > 1 ? 's' : ''})`)
      await notify(tx, loan.user_id, 'fine', 'Overdue charge posted',
        `“${copy.title}” came back ${daysLate} day${daysLate > 1 ? 's' : ''} late. ৳${fine} has been added to your account.`, '/fines')
    }

    // Promote the next reader in the queue onto this copy.
    const promoted = await releaseCopy(tx, copy.id, copy.title_id, copy.title)
    return { title: copy.title, daysLate: Math.max(0, daysLate), fine, promoted }
  })
}

/* ============================================================ fines */

async function addLedger(tx: Sql, userId: string, type: 'charge' | 'payment' | 'waiver', amount: number, description: string) {
  const [{ balance }] = await tx<{ balance: string }[]>`
    select coalesce((select balance_after from ledger_entries where user_id = ${userId}
                     order by created_at desc, id desc limit 1), 0)::text as balance`
  const next = type === 'charge' ? Number(balance) + amount : Number(balance) - amount
  await tx`insert into ledger_entries (user_id, type, amount, description, balance_after)
           values (${userId}, ${type}::ledger_type, ${amount}, ${description}, ${next})`
}

/**
 * Simulated payment. No merchant gateway is wired up, so the member presses
 * Pay and the charge settles. 'nagad' stays in the enum for records already
 * written against it.
 */
export const PAY_LABEL: Record<string, string> = {
  bkash: 'bKash', rocket: 'Rocket', nagad: 'Nagad', card: 'Card',
}

const PAY_METHODS = ['bkash', 'rocket', 'card'] as const

export async function payFines(userId: string, method: (typeof PAY_METHODS)[number]) {
  if (!PAY_METHODS.includes(method)) throw new RuleError('Choose bKash, Rocket or card.')
  return sql.begin(async (tx) => {
    await lockMember(tx, userId)
    // Settle exactly the fines being charged for: a fine posted between a
    // separate total and update would otherwise be marked paid without charge.
    const settled = await tx<{ amount: string }[]>`
      update fines set status = 'paid' where user_id = ${userId} and status = 'unpaid'
      returning amount`
    if (settled.length === 0) throw new RuleError('There is nothing outstanding to pay.')

    const total = settled.reduce((s, f) => s + Number(f.amount), 0)
    const reference = `${method.slice(0, 3).toUpperCase()}-${Math.floor(100000 + Math.random() * 899999)}`

    await tx`insert into payments (user_id, amount, method, reference)
             values (${userId}, ${total}, ${method}::pay_method, ${reference})`
    await addLedger(tx, userId, 'payment', total, `${PAY_LABEL[method] ?? method} payment ${reference}`)
    await notify(tx, userId, 'payment', 'Payment received',
      `৳${total} settled by ${PAY_LABEL[method] ?? method}. Reference ${reference}.`, '/fines')
    return { total, reference, cleared: settled.length }
  })
}

/* ============================================================ rooms */

export async function bookRoom(userId: string, roomId: string, slotStart: string) {
  requireId(roomId, 'Room')
  const start = new Date(slotStart)
  if (Number.isNaN(start.getTime())) throw new RuleError('Invalid slot')
  const end = new Date(start.getTime() + SLOT_HOURS * 3600000)

  // Opening hours are Dhaka wall-clock, not the server's timezone. Slots start
  // on the fixed grid the booking screen offers, so none can run past closing.
  const hour = libraryHour(start)
  if (hour < OPEN_HOUR || hour + SLOT_HOURS > CLOSE_HOUR) {
    throw new RuleError(`Rooms are bookable between ${String(OPEN_HOUR).padStart(2, '0')}:00 and ${CLOSE_HOUR}:00.`)
  }
  if (!SLOT_HOURS_OF_DAY.includes(hour) || start.getUTCMinutes() !== 0 || start.getUTCSeconds() !== 0) {
    throw new RuleError('Pick one of the listed two-hour slots.')
  }
  if (end.getTime() < Date.now()) throw new RuleError('That slot has already passed.')

  return sql.begin(async (tx) => {
    // Lock the room and the reader so two requests cannot both pass the
    // clash checks below and double-book the same slot.
    const [room] = await tx<{ name: string }[]>`select name from rooms where id = ${roomId} for update`
    if (!room) throw new RuleError('Room not found', 404)
    await lockMember(tx, userId)

    const [clash] = await tx`
      select 1 from room_bookings
      where room_id = ${roomId} and status in ('booked','checked_in')
        and slot_start < ${end} and slot_end > ${start}`
    if (clash) throw new RuleError('That slot has just been taken.')

    const [mine] = await tx`
      select 1 from room_bookings where user_id = ${userId} and status in ('booked','checked_in')
        and slot_start < ${end} and slot_end > ${start}`
    if (mine) throw new RuleError('You already have a room booked for that time.')

    // Checked-in slots count too, otherwise checking in freed up an extra booking.
    const [{ count }] = await tx<{ count: string }[]>`
      select count(*)::text as count from room_bookings
      where user_id = ${userId} and status in ('booked','checked_in')
        and (slot_start at time zone ${LIBRARY_TZ})::date = ${libraryDate(start)}::date`
    if (Number(count) >= 2) throw new RuleError('Two slots per day is the limit.')

    const [booking] = await tx<{ id: string }[]>`
      insert into room_bookings (room_id, user_id, slot_start, slot_end)
      values (${roomId}, ${userId}, ${start}, ${end}) returning id`
    await notify(tx, userId, 'room', 'Room booked',
      `${room.name} is reserved for you on ${start.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: LIBRARY_TZ })} at ${start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: LIBRARY_TZ })}. Check in within 15 minutes or the slot is released.`, '/rooms')
    return { id: booking!.id }
  })
}

export async function cancelBooking(userId: string, bookingId: string) {
  requireId(bookingId, 'Booking')
  const [b] = await sql<{ user_id: string; status: string }[]>`
    select user_id, status::text from room_bookings where id = ${bookingId}`
  if (!b) throw new RuleError('Booking not found', 404)
  if (b.user_id !== userId) throw new RuleError('That booking is not yours', 403)
  if (b.status !== 'booked') throw new RuleError('Only an upcoming booking can be cancelled.')
  await sql`update room_bookings set status='cancelled' where id = ${bookingId} and status = 'booked'`
  return { ok: true }
}

export async function checkInBooking(userId: string, bookingId: string) {
  requireId(bookingId, 'Booking')
  const [b] = await sql<{ user_id: string; slot_start: string; status: string }[]>`
    select user_id, slot_start, status::text from room_bookings where id = ${bookingId}`
  if (!b) throw new RuleError('Booking not found', 404)
  if (b.user_id !== userId) throw new RuleError('That booking is not yours', 403)
  if (b.status === 'checked_in') throw new RuleError('Already checked in.')
  if (b.status !== 'booked') throw new RuleError('That booking is no longer active.')
  const mins = (Date.now() - new Date(b.slot_start).getTime()) / 60000
  if (mins < -10) throw new RuleError('You can check in from 10 minutes before the slot starts.')
  if (mins > 15) throw new RuleError('Check-in closed — the slot was auto-released after 15 minutes.')
  await sql`update room_bookings set status='checked_in', checked_in_at=now() where id = ${bookingId}`
  return { ok: true }
}

/**
 * Auto-release: any slot whose reader did not check in within 15 minutes goes
 * back into the pool. Runs opportunistically whenever the rooms page loads,
 * which stands in for the scheduled job described in the plan.
 */
export async function releaseStaleBookings() {
  const released = await sql<{ id: string; user_id: string }[]>`
    update room_bookings set status = 'released'
    where status = 'booked' and checked_in_at is null and slot_start < now() - interval '15 minutes'
    returning id, user_id`
  return released.length
}

/* ============================================================ ratings */

export async function rateTitle(userId: string, titleId: string, stars: number, review: string | null) {
  requireId(titleId, 'Title')
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new RuleError('Rating must be between 1 and 5 stars.')
  }
  if (review && review.length > 2000) throw new RuleError('Keep the review under 2,000 characters.')
  return sql.begin(async (tx) => {
    const [title] = await tx`select 1 from titles where id = ${titleId} for update`
    if (!title) throw new RuleError('Title not found', 404)
    await tx`
      insert into ratings (user_id, title_id, stars, review) values (${userId}, ${titleId}, ${stars}, ${review})
      on conflict (user_id, title_id) do update set stars = excluded.stars, review = excluded.review, created_at = now()`
    await tx`
      update titles t set rating_avg = r.avg, rating_count = r.n
      from (select round(avg(stars)::numeric,2) avg, count(*) n from ratings where title_id = ${titleId}) r
      where t.id = ${titleId}`
    return { ok: true }
  })
}
