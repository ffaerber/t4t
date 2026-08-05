import {describe, expect, it} from 'vitest'
import {JobsDb, type GatewayJobRow} from '../src/lib/jobs-db'

function mkDb() {
  return new JobsDb({path: ':memory:'})
}

describe('JobsDb provider lifecycle', () => {
  it('records and upserts a job through queued → running → claimed', () => {
    const db = mkDb()
    db.recordProviderJob({
      jobId: '0x1',
      client: '0xaaa',
      modelId: 'm',
      status: 'queued',
      receivedAt: 100,
      ackedAt: null,
      completedAt: null,
      claimedAt: null,
      promptTokens: null,
      completionTokens: null,
      earnedXBZZ: null,
      errorMessage: null,
    })
    db.recordProviderJob({
      jobId: '0x1',
      client: '0xaaa',
      modelId: 'm',
      status: 'running',
      receivedAt: 0,
      ackedAt: 110,
      completedAt: null,
      claimedAt: null,
      promptTokens: 10,
      completionTokens: null,
      earnedXBZZ: null,
      errorMessage: null,
    })
    db.recordProviderJob({
      jobId: '0x1',
      client: '0xaaa',
      modelId: 'm',
      status: 'claimed',
      receivedAt: 0,
      ackedAt: null,
      completedAt: 200,
      claimedAt: 210,
      promptTokens: null,
      completionTokens: 50,
      earnedXBZZ: '5000000000000000000',
      errorMessage: null,
    })
    const rows = db.listProviderJobs({sinceSeconds: 0})
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.status).toBe('claimed')
    expect(r.receivedAt).toBe(100)
    expect(r.ackedAt).toBe(110)
    expect(r.completedAt).toBe(200)
    expect(r.claimedAt).toBe(210)
    expect(r.promptTokens).toBe(10)
    expect(r.completionTokens).toBe(50)
    expect(r.earnedXBZZ).toBe('5000000000000000000')
  })

  it('sums earned xBZZ across jobs as bigint', () => {
    const db = mkDb()
    for (let i = 0; i < 3; i++) {
      db.recordProviderJob({
        jobId: `0x${i}`,
        client: '0xa',
        modelId: 'm',
        status: 'claimed',
        receivedAt: 1,
        ackedAt: null,
        completedAt: null,
        claimedAt: null,
        promptTokens: null,
        completionTokens: null,
        earnedXBZZ: '1000000000000000000',
        errorMessage: null,
      })
    }
    expect(db.totalEarnedXBZZ()).toBe(3n * 10n ** 18n)
  })

  it('groups by status', () => {
    const db = mkDb()
    db.recordProviderJob({
      jobId: '0x1', client: 'c', modelId: 'm', status: 'queued', receivedAt: 1,
      ackedAt: null, completedAt: null, claimedAt: null, promptTokens: null,
      completionTokens: null, earnedXBZZ: null, errorMessage: null,
    })
    db.recordProviderJob({
      jobId: '0x2', client: 'c', modelId: 'm', status: 'failed', receivedAt: 1,
      ackedAt: null, completedAt: null, claimedAt: null, promptTokens: null,
      completionTokens: null, earnedXBZZ: null, errorMessage: 'boom',
    })
    expect(db.countProviderByStatus()).toEqual({queued: 1, failed: 1})
  })
})

describe('JobsDb client lifecycle', () => {
  it('persists prompts only when explicitly stored', () => {
    const db = mkDb()
    db.recordGatewayJob({ onChainJobId: null,
      jobId: '0xa',
      provider: '0xprov',
      modelId: 'm',
      status: 'posted',
      maxPayment: '1000',
      actualPayment: null,
      postedAt: 100,
      ackedAt: null,
      deliveredAt: null,
      claimedAt: null,
      prompt: '[redacted]',
      response: null,
      promptTokens: null,
      completionTokens: null,
      errorMessage: null,
    })
    const r = db.listGatewayJobs({sinceSeconds: 0})[0]!
    expect(r.prompt).toBe('[redacted]')
    expect(r.response).toBeNull()
  })

  it('redactGatewayPayloadsBefore replaces prompts past cutoff', () => {
    const db = mkDb()
    db.recordGatewayJob({ onChainJobId: null,
      jobId: '0xa', provider: 'p', modelId: 'm', status: 'delivered',
      maxPayment: '1', actualPayment: null,
      postedAt: 100, ackedAt: null, deliveredAt: null, claimedAt: null,
      prompt: 'hi', response: 'hello',
      promptTokens: null, completionTokens: null, errorMessage: null,
    })
    db.recordGatewayJob({ onChainJobId: null,
      jobId: '0xb', provider: 'p', modelId: 'm', status: 'delivered',
      maxPayment: '1', actualPayment: null,
      postedAt: 1000, ackedAt: null, deliveredAt: null, claimedAt: null,
      prompt: 'keep', response: 'me',
      promptTokens: null, completionTokens: null, errorMessage: null,
    })
    const changed = db.redactGatewayPayloadsBefore(500)
    expect(changed).toBe(1)
    const rows = db.listGatewayJobs({sinceSeconds: 0})
    const old = rows.find(r => r.jobId === '0xa')!
    const fresh = rows.find(r => r.jobId === '0xb')!
    expect(old.prompt).toBe('[expired]')
    expect(fresh.prompt).toBe('keep')
  })

  it('sums total spent xBZZ', () => {
    const db = mkDb()
    db.recordGatewayJob({ onChainJobId: null,
      jobId: '0x1', provider: 'p', modelId: 'm', status: 'claimed',
      maxPayment: '10', actualPayment: '7',
      postedAt: 1, ackedAt: null, deliveredAt: null, claimedAt: null,
      prompt: null, response: null,
      promptTokens: null, completionTokens: null, errorMessage: null,
    })
    db.recordGatewayJob({ onChainJobId: null,
      jobId: '0x2', provider: 'p', modelId: 'm', status: 'claimed',
      maxPayment: '10', actualPayment: '5',
      postedAt: 1, ackedAt: null, deliveredAt: null, claimedAt: null,
      prompt: null, response: null,
      promptTokens: null, completionTokens: null, errorMessage: null,
    })
    expect(db.totalSpentXBZZ()).toBe(12n)
  })
})

describe('JobsDb sweeper + status queries', () => {
  function posted(db: JobsDb, jobId: string, postedAt: number, over: Partial<GatewayJobRow> = {}) {
    db.recordGatewayJob({
      jobId,
      onChainJobId: `${jobId}-chain`,
      provider: 'p',
      modelId: 'm',
      status: 'posted',
      maxPayment: '1',
      actualPayment: null,
      postedAt,
      ackedAt: null,
      deliveredAt: null,
      claimedAt: null,
      prompt: null,
      response: null,
      promptTokens: null,
      completionTokens: null,
      errorMessage: null,
      ...over,
    })
  }

  it('finds stale posted rows older than the 7d listGatewayJobs window', () => {
    // Regression: the sweeper filtered `listGatewayJobs`, which windows to 7
    // days and orders newest-first — so the oldest orphans, the ones it exists
    // to cancel, were exactly the rows it could not see.
    const db = mkDb()
    const now = Math.floor(Date.now() / 1000)
    posted(db, '0xold', now - 30 * 86400)
    posted(db, '0xrecent', now - 3600)
    const stale = db.listStalePostedGatewayJobs(now - 600)
    expect(stale.map(r => r.jobId)).toEqual(['0xold', '0xrecent'])
  })

  it('returns stale rows oldest-first and respects the limit', () => {
    const db = mkDb()
    const now = Math.floor(Date.now() / 1000)
    for (let i = 0; i < 5; i++) posted(db, `0x${i}`, now - 10_000 + i)
    const stale = db.listStalePostedGatewayJobs(now - 600, 2)
    expect(stale.map(r => r.jobId)).toEqual(['0x0', '0x1'])
  })

  it('skips rows that are not posted, or have no on-chain id', () => {
    const db = mkDb()
    const now = Math.floor(Date.now() / 1000)
    posted(db, '0xdone', now - 10_000, {status: 'claimed'})
    posted(db, '0xnochain', now - 10_000, {onChainJobId: null})
    posted(db, '0xsweep', now - 10_000)
    expect(db.listStalePostedGatewayJobs(now - 600).map(r => r.jobId)).toEqual(['0xsweep'])
  })

  it('leaves rows inside the cutoff alone', () => {
    const db = mkDb()
    const now = Math.floor(Date.now() / 1000)
    posted(db, '0xfresh', now - 60)
    expect(db.listStalePostedGatewayJobs(now - 600)).toHaveLength(0)
  })

  it('reports the newest success even when later jobs failed', () => {
    // Regression: the status page read `listGatewayJobs({limit: 1})` and then
    // filtered it, so "last success" was blank unless the single newest row
    // happened to be delivered/claimed.
    const db = mkDb()
    posted(db, '0xa', 100, {status: 'delivered', deliveredAt: 150})
    posted(db, '0xb', 200, {status: 'claimed', deliveredAt: 250, claimedAt: 260})
    posted(db, '0xc', 300, {status: 'cancelled'})
    expect(db.lastGatewaySuccessAt()).toBe(260)
  })

  it('returns null when nothing has ever succeeded', () => {
    const db = mkDb()
    posted(db, '0xa', 100, {status: 'cancelled'})
    expect(db.lastGatewaySuccessAt()).toBeNull()
  })
})
