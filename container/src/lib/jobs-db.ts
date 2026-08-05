import Database, {type Database as Db} from 'better-sqlite3'
import {mkdirSync} from 'node:fs'
import {dirname} from 'node:path'

/**
 * Embedded SQLite store backing both admin UIs (US-2, US-3). One file per
 * container, two role-specific tables — opening the same path in both modes
 * is a misconfiguration but doesn't corrupt anything since the schemas don't
 * overlap.
 *
 * Design notes:
 * - bigint columns (`maxPayment`, `actualPayment`, `earnedXBZZ`) are stored
 *   as TEXT to avoid SQLite's 64-bit signed cap. Convert at the boundary.
 * - `prompt` / `response` are NULL unless T4T_PERSIST_PAYLOADS=true (client
 *   mode only). The provider side never persists decrypted bodies.
 */

export type JobStatus =
  | 'queued'
  | 'running'
  | 'delivered'
  | 'claimed'
  | 'failed'
  | 'posted'
  | 'acked'
  | 'cancelled'
  | 'timed_out'

export interface ProviderJobRow {
  jobId: string
  client: string
  modelId: string
  status: JobStatus
  receivedAt: number
  ackedAt: number | null
  completedAt: number | null
  claimedAt: number | null
  promptTokens: number | null
  completionTokens: number | null
  /** xBZZ wei as a base-10 string; NULL until claim. */
  earnedXBZZ: string | null
  errorMessage: string | null
}

export interface GatewayJobRow {
  jobId: string
  /** On-chain bytes32 jobId from JobEscrow. Joins the row to JobClaimed events
   *  so we can update `actualPayment` when the provider claims. */
  onChainJobId: string | null
  provider: string
  modelId: string
  status: JobStatus
  maxPayment: string
  actualPayment: string | null
  postedAt: number
  ackedAt: number | null
  deliveredAt: number | null
  claimedAt: number | null
  prompt: string | null
  response: string | null
  promptTokens: number | null
  completionTokens: number | null
  errorMessage: string | null
}

const PROVIDER_SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_jobs (
  jobId            TEXT PRIMARY KEY,
  client           TEXT NOT NULL,
  modelId          TEXT NOT NULL,
  status           TEXT NOT NULL,
  receivedAt       INTEGER NOT NULL,
  ackedAt          INTEGER,
  completedAt      INTEGER,
  claimedAt        INTEGER,
  promptTokens     INTEGER,
  completionTokens INTEGER,
  earnedXBZZ       TEXT,
  errorMessage     TEXT
);
CREATE INDEX IF NOT EXISTS provider_jobs_received ON provider_jobs(receivedAt);
CREATE INDEX IF NOT EXISTS provider_jobs_status ON provider_jobs(status);
`

const GATEWAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS gateway_jobs (
  jobId            TEXT PRIMARY KEY,
  onChainJobId     TEXT,
  provider         TEXT NOT NULL,
  modelId          TEXT NOT NULL,
  status           TEXT NOT NULL,
  maxPayment       TEXT NOT NULL,
  actualPayment    TEXT,
  postedAt         INTEGER NOT NULL,
  ackedAt          INTEGER,
  deliveredAt      INTEGER,
  claimedAt        INTEGER,
  prompt           TEXT,
  response         TEXT,
  promptTokens     INTEGER,
  completionTokens INTEGER,
  errorMessage     TEXT
);
CREATE INDEX IF NOT EXISTS client_jobs_posted ON gateway_jobs(postedAt);
CREATE INDEX IF NOT EXISTS client_jobs_status ON gateway_jobs(status);
CREATE INDEX IF NOT EXISTS gateway_jobs_onchain ON gateway_jobs(onChainJobId);
`

const TX_SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  hash         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  submittedAt  INTEGER NOT NULL,
  fromAddress  TEXT NOT NULL,
  toAddress    TEXT NOT NULL,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS transactions_submitted ON transactions(submittedAt);
`

export interface TxRow {
  hash: string
  kind: string
  submittedAt: number
  fromAddress: string
  toAddress: string
  note: string | null
}

export interface JobsDbOpts {
  /** ":memory:" for tests, absolute path otherwise. */
  path: string
  /** Open both schemas — handy in tests so we don't need a second DB. */
  bothRoles?: boolean
}

export class JobsDb {
  readonly db: Db
  constructor(opts: JobsDbOpts) {
    if (opts.path !== ':memory:') mkdirSync(dirname(opts.path), {recursive: true})
    this.db = new Database(opts.path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(PROVIDER_SCHEMA)
    this.db.exec(GATEWAY_SCHEMA)
    this.db.exec(TX_SCHEMA)
    // Schemas use `CREATE TABLE IF NOT EXISTS`, so they apply only to fresh
    // databases. Pre-existing tables are NOT altered — operators with old
    // databases that lack newer columns should wipe `jobs.db*` to recreate
    // (see docs / admin UI for the path).
  }

  // ---------- transactions (shared) ----------

  /** Append a tx row. Duplicate hashes are silently ignored (e.g. on idempotent
   *  retries). The chain client calls this after each successful submission. */
  recordTx(row: Omit<TxRow, 'submittedAt'> & {submittedAt?: number}): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO transactions(hash, kind, submittedAt, fromAddress, toAddress, note)
         VALUES (@hash, @kind, @submittedAt, @fromAddress, @toAddress, @note)`,
      )
      .run({
        ...row,
        submittedAt: row.submittedAt ?? Math.floor(Date.now() / 1000),
        note: row.note ?? null,
      })
  }

  listTransactions(opts: {limit?: number; sinceSeconds?: number} = {}): TxRow[] {
    const limit = opts.limit ?? 100
    if (opts.sinceSeconds !== undefined) {
      return this.db
        .prepare(`SELECT * FROM transactions WHERE submittedAt > ? ORDER BY submittedAt DESC LIMIT ?`)
        .all(opts.sinceSeconds, limit) as TxRow[]
    }
    return this.db
      .prepare(`SELECT * FROM transactions ORDER BY submittedAt DESC LIMIT ?`)
      .all(limit) as TxRow[]
  }

  close(): void {
    this.db.close()
  }

  // ---------- provider ----------

  recordProviderJob(row: ProviderJobRow): void {
    this.db
      .prepare(
        `INSERT INTO provider_jobs(jobId, client, modelId, status, receivedAt, ackedAt, completedAt, claimedAt, promptTokens, completionTokens, earnedXBZZ, errorMessage)
         VALUES (@jobId, @client, @modelId, @status, @receivedAt, @ackedAt, @completedAt, @claimedAt, @promptTokens, @completionTokens, @earnedXBZZ, @errorMessage)
         ON CONFLICT(jobId) DO UPDATE SET
           status           = excluded.status,
           ackedAt          = COALESCE(excluded.ackedAt, provider_jobs.ackedAt),
           completedAt      = COALESCE(excluded.completedAt, provider_jobs.completedAt),
           claimedAt        = COALESCE(excluded.claimedAt, provider_jobs.claimedAt),
           promptTokens     = COALESCE(excluded.promptTokens, provider_jobs.promptTokens),
           completionTokens = COALESCE(excluded.completionTokens, provider_jobs.completionTokens),
           earnedXBZZ       = COALESCE(excluded.earnedXBZZ, provider_jobs.earnedXBZZ),
           errorMessage     = COALESCE(excluded.errorMessage, provider_jobs.errorMessage)`,
      )
      .run(row)
  }

  listProviderJobs(opts: {sinceSeconds?: number; limit?: number} = {}): ProviderJobRow[] {
    const since = opts.sinceSeconds ?? Math.floor(Date.now() / 1000) - 7 * 86400
    const limit = opts.limit ?? 500
    return this.db
      .prepare(
        `SELECT * FROM provider_jobs WHERE receivedAt >= ? ORDER BY receivedAt DESC LIMIT ?`,
      )
      .all(since, limit) as ProviderJobRow[]
  }

  countProviderByStatus(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) as n FROM provider_jobs GROUP BY status`)
      .all() as {status: string; n: number}[]
    return Object.fromEntries(rows.map(r => [r.status, r.n]))
  }

  // ---------- client ----------

  recordGatewayJob(row: GatewayJobRow): void {
    this.db
      .prepare(
        `INSERT INTO gateway_jobs(jobId, onChainJobId, provider, modelId, status, maxPayment, actualPayment, postedAt, ackedAt, deliveredAt, claimedAt, prompt, response, promptTokens, completionTokens, errorMessage)
         VALUES (@jobId, @onChainJobId, @provider, @modelId, @status, @maxPayment, @actualPayment, @postedAt, @ackedAt, @deliveredAt, @claimedAt, @prompt, @response, @promptTokens, @completionTokens, @errorMessage)
         ON CONFLICT(jobId) DO UPDATE SET
           onChainJobId     = COALESCE(excluded.onChainJobId, gateway_jobs.onChainJobId),
           status           = excluded.status,
           actualPayment    = COALESCE(excluded.actualPayment, gateway_jobs.actualPayment),
           ackedAt          = COALESCE(excluded.ackedAt, gateway_jobs.ackedAt),
           deliveredAt      = COALESCE(excluded.deliveredAt, gateway_jobs.deliveredAt),
           claimedAt        = COALESCE(excluded.claimedAt, gateway_jobs.claimedAt),
           prompt           = COALESCE(excluded.prompt, gateway_jobs.prompt),
           response         = COALESCE(excluded.response, gateway_jobs.response),
           promptTokens     = COALESCE(excluded.promptTokens, gateway_jobs.promptTokens),
           completionTokens = COALESCE(excluded.completionTokens, gateway_jobs.completionTokens),
           errorMessage     = COALESCE(excluded.errorMessage, gateway_jobs.errorMessage)`,
      )
      .run(row)
  }

  /** Apply a `JobClaimed(onChainJobId, _, paid)` event to whichever gateway
   *  row tracks that on-chain job. Idempotent; safe to re-apply. */
  applyGatewayClaim(args: {onChainJobId: string; actualPayment: string; claimedAt: number}): number {
    const r = this.db
      .prepare(
        `UPDATE gateway_jobs
            SET status        = 'claimed',
                actualPayment = COALESCE(actualPayment, @actualPayment),
                claimedAt     = COALESCE(claimedAt, @claimedAt)
          WHERE onChainJobId = @onChainJobId`,
      )
      .run(args)
    return r.changes
  }

  /** Mark a gateway row as cancelled/timed-out from the on-chain side. Lets
   *  the admin UI's Cancel button update the row's pill (and hide the button
   *  on the next refresh) without waiting for an event watcher. */
  applyGatewayStatusByOnChain(args: {onChainJobId: string; status: 'cancelled' | 'timed_out'; errorMessage?: string}): number {
    const r = this.db
      .prepare(
        `UPDATE gateway_jobs
            SET status       = @status,
                errorMessage = COALESCE(@errorMessage, errorMessage)
          WHERE onChainJobId = @onChainJobId`,
      )
      .run({...args, errorMessage: args.errorMessage ?? null})
    return r.changes
  }

  /** Gateway rows still sitting in `posted` past `cutoffSeconds`, oldest
   *  first. Deliberately not expressed through `listGatewayJobs`: that one
   *  windows to the last 7 days and returns newest-first, so the stale rows
   *  this sweeps — the oldest ones — fall off the end of the page exactly
   *  when there are enough of them to matter. */
  listStalePostedGatewayJobs(cutoffSeconds: number, limit = 200): GatewayJobRow[] {
    return this.db
      .prepare(
        `SELECT * FROM gateway_jobs
          WHERE status = 'posted' AND onChainJobId IS NOT NULL AND postedAt < ?
          ORDER BY postedAt ASC LIMIT ?`,
      )
      .all(cutoffSeconds, limit) as GatewayJobRow[]
  }

  /** Timestamp of the most recent job that reached delivered/claimed, or null
   *  if there has never been one. */
  lastGatewaySuccessAt(): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(COALESCE(claimedAt, deliveredAt)) AS ts FROM gateway_jobs
          WHERE status IN ('delivered', 'claimed')`,
      )
      .get() as {ts: number | null} | undefined
    return row?.ts ?? null
  }

  listGatewayJobs(opts: {sinceSeconds?: number; limit?: number} = {}): GatewayJobRow[] {
    const since = opts.sinceSeconds ?? Math.floor(Date.now() / 1000) - 7 * 86400
    const limit = opts.limit ?? 500
    return this.db
      .prepare(`SELECT * FROM gateway_jobs WHERE postedAt >= ? ORDER BY postedAt DESC LIMIT ?`)
      .all(since, limit) as GatewayJobRow[]
  }

  countGatewayByStatus(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) as n FROM gateway_jobs GROUP BY status`)
      .all() as {status: string; n: number}[]
    return Object.fromEntries(rows.map(r => [r.status, r.n]))
  }

  /** Total xBZZ spent across claimed client jobs. Sums actualPayment as bigint. */
  totalSpentXBZZ(): bigint {
    const rows = this.db
      .prepare(`SELECT actualPayment FROM gateway_jobs WHERE actualPayment IS NOT NULL`)
      .all() as {actualPayment: string}[]
    return rows.reduce((acc, r) => acc + BigInt(r.actualPayment), 0n)
  }

  /** Total xBZZ earned across claimed provider jobs. */
  totalEarnedXBZZ(): bigint {
    const rows = this.db
      .prepare(`SELECT earnedXBZZ FROM provider_jobs WHERE earnedXBZZ IS NOT NULL`)
      .all() as {earnedXBZZ: string}[]
    return rows.reduce((acc, r) => acc + BigInt(r.earnedXBZZ), 0n)
  }

  /** Wipe stored prompts/responses older than `cutoffSeconds`. */
  redactGatewayPayloadsBefore(cutoffSeconds: number): number {
    const res = this.db
      .prepare(
        `UPDATE gateway_jobs SET prompt = '[expired]', response = '[expired]' WHERE postedAt < ? AND (prompt IS NOT NULL OR response IS NOT NULL)`,
      )
      .run(cutoffSeconds)
    return res.changes
  }
}
