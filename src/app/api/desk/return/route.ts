import { route } from '@/lib/api'
import { returnCopy } from '@/lib/circulation'

export const POST = route<{ accession: string }>(
  async ({ body }) => returnCopy(String(body.accession ?? '').trim()),
  { staff: true },
)
