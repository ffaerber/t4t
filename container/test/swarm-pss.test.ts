import {describe, expect, it, vi} from 'vitest'
import {privateKeyToAccount} from 'viem/accounts'
import {PssTransport, addressesEqual} from '../src/lib/swarm'
import {signEnvelope} from '../src/lib/envelope'
import type {Envelope, Hex} from '../src/lib/types'

const SELF = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const PROVIDER = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const STRANGER = privateKeyToAccount(`0x${'33'.repeat(32)}`)

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  child: () => silentLogger,
} as never

/** Stand-in for bee-js' pssSubscribe: captures the handlers so the test can
 *  push messages through the same path a real PSS delivery takes. */
function mkBee() {
  let onMessage: ((msg: {toUtf8: () => string}) => void | Promise<void>) | undefined
  return {
    bee: {
      pssSubscribe: (_topic: unknown, handlers: {onMessage: typeof onMessage}) => {
        onMessage = handlers.onMessage
        return {cancel: () => {}}
      },
    } as never,
    deliver: async (env: Envelope) => {
      await onMessage?.({toUtf8: () => JSON.stringify(env)})
    },
  }
}

function mkTransport(received: Envelope[]) {
  const {bee, deliver} = mkBee()
  const pss = new PssTransport({
    bee,
    postageBatchId: 'batch',
    logger: silentLogger,
    selfAddress: SELF.address as Hex,
  })
  pss.subscribe({topic: 't4t:client:test', onEnvelope: env => void received.push(env)})
  return {deliver}
}

function sign(account: typeof SELF, to: Hex, body: Record<string, unknown> = {jobId: '0xjob'}) {
  return signEnvelope(
    {from: account.address as Hex, to, type: 'job_deliver', body},
    msg => account.signMessage({message: msg}) as Promise<Hex>,
  )
}

describe('PssTransport recipient filtering', () => {
  it('delivers an envelope addressed to us', async () => {
    const received: Envelope[] = []
    const {deliver} = mkTransport(received)
    await deliver(await sign(PROVIDER, SELF.address as Hex))
    expect(received).toHaveLength(1)
    expect(addressesEqual(received[0]!.from, PROVIDER.address)).toBe(true)
  })

  it('drops a validly-signed envelope addressed to somebody else', async () => {
    // PSS topics are derived from public on-chain addresses, so anyone can
    // post to ours. A good signature only proves who sent it, not that it was
    // meant for us.
    const received: Envelope[] = []
    const {deliver} = mkTransport(received)
    await deliver(await sign(PROVIDER, STRANGER.address as Hex))
    expect(received).toHaveLength(0)
  })

  it('drops an envelope whose signature does not match its `from`', async () => {
    const received: Envelope[] = []
    const {deliver} = mkTransport(received)
    const env = await sign(PROVIDER, SELF.address as Hex)
    await deliver({...env, from: STRANGER.address as Hex})
    expect(received).toHaveLength(0)
  })

  it('drops a malformed `to` without throwing out of the message handler', async () => {
    const received: Envelope[] = []
    const {deliver} = mkTransport(received)
    const env = await sign(PROVIDER, SELF.address as Hex)
    await expect(deliver({...env, to: 'not-an-address' as Hex})).resolves.toBeUndefined()
    expect(received).toHaveLength(0)
  })

  it('dedups a replayed envelope', async () => {
    const received: Envelope[] = []
    const {deliver} = mkTransport(received)
    const env = await sign(PROVIDER, SELF.address as Hex)
    await deliver(env)
    await deliver(env)
    expect(received).toHaveLength(1)
  })
})

describe('addressesEqual', () => {
  it('is case-insensitive across checksum forms', () => {
    expect(addressesEqual(SELF.address, SELF.address.toLowerCase())).toBe(true)
  })

  it('is false for junk instead of throwing', () => {
    expect(addressesEqual('nope', SELF.address)).toBe(false)
    expect(addressesEqual(undefined, SELF.address)).toBe(false)
    expect(addressesEqual(null, null)).toBe(false)
    expect(addressesEqual(12 as never, SELF.address)).toBe(false)
  })
})

describe('gateway sender authorization', () => {
  // Mirrors the check wired into the gateway's ack/deliver handlers: the
  // routing id is public (JobPosted is indexed, jobs[jobId].requestHash is
  // readable), so `jobMeta` — written when we chose the provider — is the
  // only thing that says who may answer for a given job.
  function authorize(jobMeta: Map<string, {provider: string}>, from: string, jobId: unknown): boolean {
    if (typeof jobId !== 'string') return false
    const meta = jobMeta.get(jobId)
    if (!meta) return false
    return addressesEqual(from, meta.provider)
  }

  it('accepts the provider the job was posted to', () => {
    const meta = new Map([['0xjob', {provider: PROVIDER.address}]])
    expect(authorize(meta, PROVIDER.address, '0xjob')).toBe(true)
  })

  it('rejects a third party forging a delivery for a known job', () => {
    const meta = new Map([['0xjob', {provider: PROVIDER.address}]])
    expect(authorize(meta, STRANGER.address, '0xjob')).toBe(false)
  })

  it('rejects an unknown or non-string job id', () => {
    const meta = new Map([['0xjob', {provider: PROVIDER.address}]])
    expect(authorize(meta, PROVIDER.address, '0xnope')).toBe(false)
    expect(authorize(meta, PROVIDER.address, undefined)).toBe(false)
    expect(authorize(meta, PROVIDER.address, {})).toBe(false)
  })
})

describe('worker on-chain verification gate', () => {
  it('refuses to run inference when no JobPosted matches the notify', async () => {
    const {processJob} = await import('../src/modes/provider/worker')
    const inference = {chatCompletion: vi.fn()}
    const deps = {
      bee: {} as never,
      postageBatchId: 'b',
      pss: {send: vi.fn()} as never,
      inference: inference as never,
      cipher: {encrypt: async (x: Uint8Array) => x, decrypt: async (x: Uint8Array) => x},
      selfAddress: SELF.address as Hex,
      signMessage: (msg: string) => SELF.signMessage({message: msg}) as Promise<Hex>,
      resolveOnChainJob: async () => null,
      onDelivered: vi.fn(),
      pricingFor: () => null,
      logger: silentLogger,
    }
    const notify = await signEnvelope(
      {
        from: PROVIDER.address as Hex,
        to: SELF.address as Hex,
        type: 'job_notify' as const,
        body: {
          jobId: '0xrouting' as Hex,
          requestHash: 'ab'.repeat(32),
          modelId: 'm',
          maxPayment: '1000',
          deliveryDeadline: 0,
          clientPssPubKey: `0x${'11'.repeat(32)}` as Hex,
          clientSwarmOverlay: `0x${'22'.repeat(32)}` as Hex,
          clientReplyUrl: 'http://127.0.0.1:1/reply',
        },
      },
      msg => PROVIDER.signMessage({message: msg}) as Promise<Hex>,
    )
    await expect(processJob(deps as never, notify)).rejects.toThrow(/no on-chain JobPosted/)
    expect(inference.chatCompletion).not.toHaveBeenCalled()
    expect(deps.onDelivered).not.toHaveBeenCalled()
  })
})
