import 'server-only'
import { sql } from './db'
import type {
  CopyRow, HoldRow, LoanRow, NotificationRow, SearchResult, TitleRow,
} from './types'

/* ============================================================ search */

export interface SearchParams {
  q?: string
  type?: string
  available?: boolean
  subject?: string
  zone?: string
  language?: string
  yearFrom?: number
  yearTo?: number
  sort?: 'relevance' | 'newest' | 'popular' | 'rating' | 'title'
  page?: number
  perPage?: number
}

export interface SearchResponse {
  results: SearchResult[]
  total: number
  facets: {
    types: { value: string; count: number }[]
    subjects: { value: string; count: number }[]
    zones: { value: string; count: number }[]
    languages: { value: string; count: number }[]
  }
}

export async function searchCatalogue(p: SearchParams): Promise<SearchResponse> {
  const q = (p.q ?? '').trim()
  const perPage = p.perPage ?? 20
  const page = Math.max(1, p.page ?? 1)
  const offset = (page - 1) * perPage

  // websearch_to_tsquery understands quoted phrases and OR, and never throws
  // on user input the way to_tsquery does.
  const tsq = q ? sql`websearch_to_tsquery('english', ${q})` : null

  const where = sql`
    where true
    ${q ? sql`and (t.search_tsv @@ ${tsq!} or t.title ilike ${'%' + q + '%'})` : sql``}
    ${p.type ? sql`and t.type = ${p.type}::title_type` : sql``}
    ${p.language ? sql`and t.language = ${p.language}` : sql``}
    ${p.yearFrom ? sql`and t.year >= ${p.yearFrom}` : sql``}
    ${p.yearTo ? sql`and t.year <= ${p.yearTo}` : sql``}
    ${p.subject ? sql`and exists (select 1 from title_subjects ts join subjects s on s.id=ts.subject_id
                                   where ts.title_id = t.id and s.name = ${p.subject})` : sql``}
    ${p.zone ? sql`and exists (select 1 from copies c where c.title_id = t.id and c.location_zone = ${p.zone})` : sql``}
    ${p.available ? sql`and (t.type = 'ebook' or exists (select 1 from copies c where c.title_id = t.id and c.status = 'available'))` : sql``}
  `

  const order =
    p.sort === 'newest' ? sql`t.added_at desc`
    : p.sort === 'popular' ? sql`t.borrow_count desc, t.rating_count desc`
    : p.sort === 'rating' ? sql`t.rating_avg desc, t.rating_count desc`
    : p.sort === 'title' ? sql`t.title asc`
    : q ? sql`rank desc, t.borrow_count desc`
    : sql`t.borrow_count desc, t.title asc`

  const results = await sql<SearchResult[]>`
    select
      t.*,
      ${q ? sql`ts_rank(t.search_tsv, ${tsq!})` : sql`0::real`} as rank,
      coalesce(av.copies_total, 0)     as copies_total,
      coalesce(av.copies_available, 0) as copies_available,
      av.next_due,
      coalesce(au.names, '{}')  as authors,
      coalesce(su.names, '{}')  as subjects
    from titles t
    left join title_availability av on av.title_id = t.id
    left join lateral (
      select array_agg(a.name order by ta.ord) as names
      from title_authors ta join authors a on a.id = ta.author_id where ta.title_id = t.id
    ) au on true
    left join lateral (
      select array_agg(s.name order by s.name) as names
      from title_subjects ts join subjects s on s.id = ts.subject_id where ts.title_id = t.id
    ) su on true
    ${where}
    order by ${order}
    limit ${perPage} offset ${offset}`

  const [{ count }] = await sql<{ count: string }[]>`
    select count(*)::text as count from titles t ${where}`

  // Facets are computed against the same filter set minus the facet's own
  // dimension would be ideal; for a catalogue this size the simpler
  // "counts within the current result set" reads more predictably.
  const [types, subjects, zones, languages] = await Promise.all([
    sql<{ value: string; count: number }[]>`
      select t.type::text as value, count(*)::int as count from titles t ${where} group by 1 order by 2 desc`,
    sql<{ value: string; count: number }[]>`
      select s.name as value, count(*)::int as count
      from titles t join title_subjects ts on ts.title_id = t.id join subjects s on s.id = ts.subject_id
      ${where} group by 1 order by 2 desc, 1 limit 18`,
    sql<{ value: string; count: number }[]>`
      select c.location_zone as value, count(distinct t.id)::int as count
      from titles t join copies c on c.title_id = t.id ${where} group by 1 order by 2 desc`,
    sql<{ value: string; count: number }[]>`
      select t.language as value, count(*)::int as count from titles t ${where} group by 1 order by 2 desc`,
  ])

  return { results, total: Number(count), facets: { types, subjects, zones, languages } }
}

export async function searchSuggestions(q: string, limit = 6) {
  if (!q.trim()) return []
  return sql<{ id: string; title: string; type: string; cover_hue: number; authors: string[] }[]>`
    select t.id, t.title, t.type::text, t.cover_hue,
           coalesce((select array_agg(a.name order by ta.ord) from title_authors ta
                     join authors a on a.id=ta.author_id where ta.title_id=t.id), '{}') as authors
    from titles t
    where t.title ilike ${'%' + q + '%'}
       or t.search_tsv @@ websearch_to_tsquery('english', ${q})
    order by t.borrow_count desc limit ${limit}`
}

/* ============================================================ title detail */

export async function getTitle(id: string) {
  const rows = await sql<(SearchResult & { digital: boolean })[]>`
    select t.*,
      coalesce(av.copies_total,0) as copies_total,
      coalesce(av.copies_available,0) as copies_available,
      av.next_due,
      coalesce((select array_agg(a.name order by ta.ord) from title_authors ta
                join authors a on a.id=ta.author_id where ta.title_id=t.id), '{}') as authors,
      coalesce((select array_agg(s.name order by s.name) from title_subjects ts
                join subjects s on s.id=ts.subject_id where ts.title_id=t.id), '{}') as subjects,
      exists(select 1 from digital_assets d where d.title_id = t.id) as digital
    from titles t
    left join title_availability av on av.title_id = t.id
    where t.id = ${id}`
  return rows[0] ?? null
}

export async function getCopies(titleId: string) {
  return sql<CopyRow[]>`
    select id, accession_number, location_zone, shelf_bay, copy_type::text, status::text, due_back
    from copies where title_id = ${titleId}
    order by location_zone, shelf_bay, accession_number`
}

export async function getReviews(titleId: string) {
  return sql<{ id: string; stars: number; review: string | null; created_at: string; name: string; avatar_hue: number }[]>`
    select r.id, r.stars, r.review, r.created_at, u.name, u.avatar_hue
    from ratings r join users u on u.id = r.user_id
    where r.title_id = ${titleId} and r.review is not null
    order by r.created_at desc limit 8`
}

export async function getRatingBreakdown(titleId: string) {
  const rows = await sql<{ stars: number; count: number }[]>`
    select stars, count(*)::int as count from ratings where title_id = ${titleId} group by stars`
  const map = new Map(rows.map((r) => [r.stars, r.count]))
  return [5, 4, 3, 2, 1].map((s) => ({ stars: s, count: map.get(s) ?? 0 }))
}

export async function getMyRating(userId: string, titleId: string) {
  const rows = await sql<{ stars: number; review: string | null }[]>`
    select stars, review from ratings where user_id = ${userId} and title_id = ${titleId}`
  return rows[0] ?? null
}

export async function getRelatedTitles(titleId: string, limit = 6) {
  return sql<SearchResult[]>`
    select t.*, coalesce(av.copies_available,0) as copies_available, coalesce(av.copies_total,0) as copies_total,
           av.next_due,
           coalesce((select array_agg(a.name order by ta.ord) from title_authors ta
                     join authors a on a.id=ta.author_id where ta.title_id=t.id),'{}') as authors,
           '{}'::text[] as subjects
    from titles t
    left join title_availability av on av.title_id = t.id
    where t.id <> ${titleId}
      and exists (
        select 1 from title_subjects a join title_subjects b on a.subject_id = b.subject_id
        where a.title_id = ${titleId} and b.title_id = t.id)
    order by t.borrow_count desc limit ${limit}`
}

/* ============================================================ circulation */

export async function getMyLoans(userId: string) {
