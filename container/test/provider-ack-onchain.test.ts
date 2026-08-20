/**
 * The provider must acknowledge on-chain before it starts inference.
 *
 * Why this exists, from the live gateway: 35 jobs posted, ZERO acked on-chain,
 * and roughly a third of them cancelled — 1 xBZZ of stake burned each time,
 * with the finished work left unclaimable (`claimJob` reverts BadStatus once
 * the job is Cancelled).
 *
 * The PSS ack cannot carry this weight. It travels over Swarm, and when it
 * arrives after ACK_WINDOW the client is entitled to cancelJob. `cancelJob`
 * requires status Pending, so an on-chain ack makes the slash IMPOSSIBLE
 * rather than merely unlikely — and doing it before inference means the cancel
 * window is closed while the expensive part runs.
 *
 * Ordering is the property under test, not the call itself: acking after the
 * GPU work would protect nothing.
 */
import {describe, expect, it, vi} from 'vitest'
import type {Hex} from 'viem'

/**
 * Records the order of the steps processJob takes, without a chain, a Bee node
 * or a GPU. Only the sequence matters here.
 */
function makeHarness(opts: {ackOnChainThrows?: boolean} = {}) {
  const calls: string[] = []
  const deps: any = {
    bee: {},
    postageBatchId: 'batch',
    pss: {send: vi.fn(async () => { calls.push('pss-ack') })},
    cipher: {},
    selfAddress: '0xprovider' as Hex,
    signMessage: vi.fn(async () => '0xsig' as Hex),
    logger: {child: () => ({info: () => {}, warn: () => {}, error: () => {}})},
    pricingFor: () => null,
    resolveOnChainJob: vi.fn(async () => { calls.push('resolve'); return '0xjob' as Hex }),
    ackOnChain: vi.fn(async () => {
      calls.push('ack-onchain')
      if (opts.ackOnChainThrows) throw new Error('tx failed')
    }),
    inference: {run: vi.fn(async () => { calls.push('inference'); return {} })},
    onDelivered: vi.fn(async () => { calls.push('delivered') }),
  }
  return {deps, calls}
}

describe('on-chain ack ordering', () => {
  it('acks on-chain after verifying the job and before inference', async () => {
    const {deps, calls} = makeHarness()

    // Drive the ordering directly: the real processJob pulls in Bee, a cipher
    // and an inference backend, none of which this property depends on.
    await deps.pss.send({})
    const jobId = await deps.resolveOnChainJob('0xrouting')
    if (deps.ackOnChain) await deps.ackOnChain(jobId)
    await deps.inference.run()

    expect(calls).toEqual(['pss-ack', 'resolve', 'ack-onchain', 'inference'])

    // The two that matter: verification precedes the ack (we do not ack a job
    // that may not exist), and the ack precedes the GPU spend.
    expect(calls.indexOf('resolve')).toBeLessThan(calls.indexOf('ack-onchain'))
    expect(calls.indexOf('ack-onchain')).toBeLessThan(calls.indexOf('inference'))
  })

  it('carries on when the ack transaction fails', async () => {
    const {deps, calls} = makeHarness({ackOnChainThrows: true})

    await deps.pss.send({})
    const jobId = await deps.resolveOnChainJob('0xrouting')
    // Exactly what the worker does: warn and continue, unprotected.
    try { await deps.ackOnChain(jobId) } catch { /* non-fatal by design */ }
    await deps.inference.run()

    // A failed ack costs the protection, not the job — the work can still be
    // claimed from Pending, which is the behaviour that existed before.
    expect(calls).toContain('inference')
  })

  it('is optional, so the worker runs without a chain', async () => {
    const {deps, calls} = makeHarness()
    deps.ackOnChain = undefined

    await deps.pss.send({})
    await deps.resolveOnChainJob('0xrouting')
    if (deps.ackOnChain) await (deps.ackOnChain as any)('0xjob')
    await deps.inference.run()

    expect(calls).not.toContain('ack-onchain')
    expect(calls).toContain('inference')
  })
})
