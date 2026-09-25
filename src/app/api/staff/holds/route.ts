import { sql } from '@/lib/db'
import { route } from '@/lib/api'
import { RuleError, expireHold, issueCopy, markHoldReady } from '@/lib/circulation'
import { isUuid } from '@/lib/session'

/** Desk actions on the hold queue: mark ready, mark collected, or expire. */
export const PATCH = route<{ holdId: string; action: 'ready' | 'collected' | 'expire' }>(
  async ({ user, body }) => {
    if (body.action === 'ready') return markHoldReady(body.holdId)
    if (body.action === 'expire') return expireHold(body.holdId)

    if (body.action === 'collected') {
      // Collecting a reservation *is* issuing the copy. Closing the hold on its
      // own left the copy marked held forever with no loan behind it, so issue
      // it to the reader it was held for, exactly as the desk scanner would.
      if (!isUuid(body.holdId)) throw new RuleError('Reservation not found', 404)
      const [hold] = await sql<{ status: string; accession_number: string | null; uiu_id: string }[]>`
        select h.status::text, c.accession_number, u.uiu_id
        from holds h join users u on u.id = h.user_id left join copies c on c.id = h.copy_id
        where h.id = ${body.holdId}`
      if (!hold) throw new RuleError('Reservation not found', 404)
      if (hold.status !== 'ready' || !hold.accession_number) {
        throw new RuleError('Only a reservation that is ready at the desk can be collected.')
      }
      return issueCopy(user.id, hold.accession_number, hold.uiu_id)
    }

    throw new RuleError('Unknown action.')
  }, { staff: true })
