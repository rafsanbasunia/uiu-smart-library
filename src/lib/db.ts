import postgres from 'postgres'

declare global {
  // eslint-disable-next-line no-var
  var __sql: ReturnType<typeof postgres> | undefined
}

// On Vercel every serverless instance opens its own pool, so a generous `max`
// multiplies into hundreds of connections against Supabase's pooler. Keep it
// small in serverless and let the pooler do the multiplexing.
const serverless = Boolean(process.env.VERCEL)

/**
 * TLS is required by Supabase. A local Postgres usually runs without it, so
 * DATABASE_SSL=disable turns it off for development.
 */
export function sslOption() {
  return process.env.DATABASE_SSL === 'disable' ? false : ('require' as const)
}

function connect() {
  const connection = process.env.DATABASE_URL
  if (!connection) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.')
  }
  return postgres(connection, {
    ssl: sslOption(),
    max: serverless ? 2 : 8,
    idle_timeout: serverless ? 10 : 20,
    connect_timeout: 15,
    prepare: false, // required when going through Supabase's pooler
  })
}

function client() {
  if (!global.__sql) global.__sql = connect()
  return global.__sql
}

/**
 * The client is created on first use rather than at import. `next build`
 * imports every route to collect its config; connecting (or throwing on a
 * missing DATABASE_URL) at import time made the build fail on any machine or CI
 * runner without database credentials.
 */
export const sql = new Proxy((() => {}) as unknown as ReturnType<typeof postgres>, {
  apply: (_t, _this, args) => Reflect.apply(client() as never, undefined, args),
  get: (_t, prop) => {
    const c = client() as unknown as Record<PropertyKey, unknown>
    const v = c[prop]
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(c) : v
  },
})

/** A transaction-scoped client, or the shared pool when not in a transaction. */
export type Sql = ReturnType<typeof postgres> | postgres.TransactionSql
