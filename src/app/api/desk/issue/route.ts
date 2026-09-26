import { route } from '@/lib/api'
import { issueCopy } from '@/lib/circulation'

export const POST = route<{ accession: string; member: string }>(
  async ({ user, body }) => issueCopy(user.id, String(body.accession ?? '').trim(), String(body.member ?? '').trim()),
  { staff: true },
)
