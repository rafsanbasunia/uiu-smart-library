import 'server-only'
import { sql } from './db'
import type { Recommendation } from './types'

/**
 * Recommendation ranking — the four signals and weights specified in the
 * project deck. Candidates are drawn *only* from titles the library holds,
 * and every suggestion carries the reason it was shown.
 */
export const WEIGHTS = {
  history: 0.42,
  interests: 0.26,
  courses: 0.18,
  trends: 0.09,
  freshness: 0.05, // recency + diversity jitter
} as const

export const MODE_TILT = {
  balanced: { history: 1, interests: 1, courses: 1, trends: 1 },
  close: { history: 1.45, interests: 1.15, courses: 1, trends: 0.4 },
  surprise: { history: 0.5, interests: 0.8, courses: 0.7, trends: 1.6 },
} as const

interface Raw {
  id: string
  title: string
  subtitle: string | null
  type: string
  cover_hue: number
  year: number | null
  publisher: string | null
  summary: string | null
  rating_avg: string
  rating_count: number
  borrow_count: number
  added_at: string
  language: string
  isbn: string | null
  issn: string | null
  edition: string | null
  pages: number | null
  authors: string[]
  subjects: string[]
  copies_total: number
  copies_available: number
  next_due: string | null
  history_score: number
  interest_score: number
  course_score: number
  trend_score: number
  freshness: number
  history_via: string | null
  author_via: string | null
  interest_via: string | null
  course_via: string | null
  peer_count: number
}

export async function getRecommendations(userId: string, limit = 18): Promise<Recommendation[]> {
  const [settings] = await sql<{ mode: keyof typeof MODE_TILT; use_history: boolean; use_trends: boolean }[]>`
    select mode::text as mode, use_history, use_trends from reco_settings where user_id = ${userId}`
  const mode = settings?.mode ?? 'balanced'
  const useHistory = settings?.use_history ?? true
  const useTrends = settings?.use_trends ?? true
  const tilt = MODE_TILT[mode] ?? MODE_TILT.balanced

  const rows = await sql<Raw[]>`
    with
    -- subjects the reader has actually borrowed, weighted by how often
    my_subjects as (
      select ts.subject_id, count(*)::numeric as n
      from loans l join title_subjects ts on ts.title_id = l.title_id
      where l.user_id = ${userId} group by 1
    ),
    my_subject_max as (select coalesce(max(n),1) as m from my_subjects),
    -- authors the reader has borrowed before
    my_authors as (
      select ta.author_id, count(*)::numeric as n
      from loans l join title_authors ta on ta.title_id = l.title_id
      where l.user_id = ${userId} group by 1
    ),
    -- stated interests, mapped onto subject names
    my_interests as (
      select i.name, ui.weight::numeric from user_interests ui
      join interests i on i.id = ui.interest_id where ui.user_id = ${userId}
    ),
    -- reserves for the courses the reader is enrolled in
    my_reserves as (
      select cr.title_id, c.code
      from enrollments e join courses c on c.id = e.course_id
      join course_reserves cr on cr.course_id = c.id
      where e.user_id = ${userId}
    ),
    -- what readers with overlapping history borrowed
    peers as (
      select l2.user_id from loans l1 join loans l2 on l2.title_id = l1.title_id
      where l1.user_id = ${userId} and l2.user_id <> ${userId} group by l2.user_id
      having count(distinct l1.title_id) >= 1
    ),
    peer_borrows as (
      select l.title_id, count(distinct l.user_id)::numeric as n
      from loans l where l.user_id in (select user_id from peers) group by 1
    ),
    peer_max as (select coalesce(max(n),1) as m from peer_borrows),
    trend as (
      select l.title_id, count(*)::numeric as n from loans l
      where l.issued_at > now() - interval '90 days' group by 1
    ),
    trend_max as (select coalesce(max(n),1) as m from trend),
    -- already read, on loan, or held: never recommend these
    excluded as (
      select title_id from loans where user_id = ${userId}
      union select title_id from holds where user_id = ${userId} and status in ('queued','ready')
      union select title_id from bookmarks where user_id = ${userId}
    )
    select t.id, t.title, t.subtitle, t.type::text, t.cover_hue, t.year, t.publisher, t.summary,
           t.rating_avg::text, t.rating_count, t.borrow_count, t.added_at, t.language,
           t.isbn, t.issn, t.edition, t.pages,
           coalesce((select array_agg(a.name order by ta.ord) from title_authors ta
                     join authors a on a.id=ta.author_id where ta.title_id=t.id),'{}') as authors,
           coalesce((select array_agg(s.name order by s.name) from title_subjects ts
                     join subjects s on s.id=ts.subject_id where ts.title_id=t.id),'{}') as subjects,
           coalesce(av.copies_total,0) as copies_total,
           coalesce(av.copies_available,0) as copies_available,
           av.next_due,

           -- signal 1: borrowing history (shared subjects + shared authors)
           least(1, coalesce((
             select sum(ms.n) / (select m from my_subject_max) / 2
