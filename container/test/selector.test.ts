import {describe, expect, it} from 'vitest'
import type {ChainClient} from '../src/lib/chain'
import {isAtCapacity, isHeartbeatFresh, selectProviderWithDetail} from '../src/modes/gateway/selector'
import type {ModelOffering, ProviderRow} from '../src/lib/types'

describe('isHeartbeatFresh', () => {
  const NOW = 1_700_000_000
  const TTL = 600

  it('treats a zero heartbeat as never alive', () => {
    expect(isHeartbeatFresh(0, NOW)).toBe(false)
  })

  it('accepts a recent heartbeat', () => {
    expect(isHeartbeatFresh(NOW - 5, NOW)).toBe(true)
  })

  it('accepts the boundary heartbeat exactly at TTL', () => {
    expect(isHeartbeatFresh(NOW - TTL, NOW)).toBe(true)
  })

  it('rejects a heartbeat older than TTL', () => {
    expect(isHeartbeatFresh(NOW - TTL - 1, NOW)).toBe(false)
  })

  it('accepts bigint heartbeats (registry returns uint64)', () => {
    expect(isHeartbeatFresh(BigInt(NOW - 10), NOW)).toBe(true)
  })
})

describe('isAtCapacity', () => {
  const base: ProviderRow = {
    owner: '0x0000000000000000000000000000000000000001',
    pssPublicKey: '0x0',
    swarmOverlay: '0x0',
    metadataURI: '',
    stake: 0n,
    lastHeartbeat: 0,
    totalJobs: 0,
    successfulJobs: 0,
    active: true,
    maxConcurrentJobs: 0,
  }

  it('treats maxConcurrentJobs=0 as unset/uncapped', () => {
    expect(isAtCapacity({...base, maxConcurrentJobs: 0}, 99)).toBe(false)
  })

  it('flags providers at or above their advertised cap', () => {
    expect(isAtCapacity({...base, maxConcurrentJobs: 2}, 2)).toBe(true)
    expect(isAtCapacity({...base, maxConcurrentJobs: 2}, 3)).toBe(true)
  })

  it('leaves headroom below the cap', () => {
    expect(isAtCapacity({...base, maxConcurrentJobs: 2}, 1)).toBe(false)
    expect(isAtCapacity({...base, maxConcurrentJobs: 2}, 0)).toBe(false)
  })
})

// ---------------------------------------------------------------
// selectProviderWithDetail — capacity-aware filtering & failover
// ---------------------------------------------------------------

const ALICE = '0x0000000000000000000000000000000000000001' as const
const BOB = '0x0000000000000000000000000000000000000002' as const

function mkProvider(over: Partial<ProviderRow> = {}): ProviderRow {
  const now = Math.floor(Date.now() / 1000)
  return {
    owner: ALICE,
    pssPublicKey: '0x0',
    swarmOverlay: '0x0',
    metadataURI: '',
    stake: 0n,
    lastHeartbeat: now,
    totalJobs: 100,
    successfulJobs: 100,
    active: true,
    maxConcurrentJobs: 0,
    ...over,
  }
}

function mkChain(
  providers: ProviderRow[],
  offerings: Map<string, ModelOffering[]>,
  openJobs: Map<string, number>,
): ChainClient {
  return {
    pub: {
      readContract: async ({functionName, args}: {functionName: string; args: unknown[]}) => {
        if (functionName === 'listProviders') {
          const cursor = Number(args[0] as bigint)
          const limit = Number(args[1] as bigint)
          if (cursor >= providers.length) return [[], BigInt(providers.length)]
          const end = Math.min(cursor + limit, providers.length)
          return [providers.slice(cursor, end), BigInt(end)]
        }
        if (functionName === 'getOfferings') {
          const owner = (args[0] as string).toLowerCase()
          return offerings.get(owner) ?? []
        }
        if (functionName === 'getProvider') {
          const owner = (args[0] as string).toLowerCase()
          return (
            providers.find(p => p.owner.toLowerCase() === owner) ?? {
              owner: '0x0000000000000000000000000000000000000000',
            }
          )
        }
        if (functionName === 'openJobs') {
          const owner = (args[0] as string).toLowerCase()
          return BigInt(openJobs.get(owner) ?? 0)
        }
        throw new Error(`unexpected ${functionName}`)
      },
    },
    registry: '0x0' as never,
    escrow: '0x0' as never,
    xbzz: '0x0' as never,
    address: '0x0' as never,
    wallet: {} as never,
  } as unknown as ChainClient
}

const cheapOffering: ModelOffering = {
  modelId: 'llama3:8b',
  inputPricePerMillionTokens: 50n,
  outputPricePerMillionTokens: 100n,
  maxContextTokens: 0n,
  maxLatencySeconds: 60n,
}
const pricierOffering: ModelOffering = {
  modelId: 'llama3:8b',
  inputPricePerMillionTokens: 80n,
  outputPricePerMillionTokens: 200n,
  maxContextTokens: 0n,
  maxLatencySeconds: 60n,
}

describe('selectProviderWithDetail', () => {
  it('falls over to a less-busy provider when the cheaper one is at capacity', async () => {
    const providers = [
      mkProvider({owner: ALICE, maxConcurrentJobs: 2}),
      mkProvider({owner: BOB, maxConcurrentJobs: 2}),
    ]
    const offerings = new Map<string, ModelOffering[]>([
      [ALICE.toLowerCase(), [cheapOffering]],
      [BOB.toLowerCase(), [pricierOffering]],
    ])
    const openJobs = new Map<string, number>([
      [ALICE.toLowerCase(), 2], // cheaper one is full
      [BOB.toLowerCase(), 0],
    ])
    const chain = mkChain(providers, offerings, openJobs)
    const {chosen, matches, busy} = await selectProviderWithDetail(chain, 'cheapest', {modelId: 'llama3:8b'})
    expect(matches).toHaveLength(2)
    expect(busy).toHaveLength(1)
    expect(chosen?.provider.owner).toBe(BOB)
  })

  it('returns chosen=null when every match is at capacity', async () => {
    const providers = [
      mkProvider({owner: ALICE, maxConcurrentJobs: 1}),
      mkProvider({owner: BOB, maxConcurrentJobs: 1}),
    ]
    const offerings = new Map<string, ModelOffering[]>([
      [ALICE.toLowerCase(), [cheapOffering]],
      [BOB.toLowerCase(), [pricierOffering]],
    ])
    const openJobs = new Map<string, number>([
      [ALICE.toLowerCase(), 1],
      [BOB.toLowerCase(), 1],
    ])
    const chain = mkChain(providers, offerings, openJobs)
    const {chosen, matches, busy} = await selectProviderWithDetail(chain, 'cheapest', {modelId: 'llama3:8b'})
    expect(chosen).toBeNull()
    expect(matches).toHaveLength(2)
    expect(busy).toHaveLength(2)
  })

  it('treats maxConcurrentJobs=0 as uncapped — picks even with many open jobs', async () => {
    const providers = [mkProvider({owner: ALICE, maxConcurrentJobs: 0})]
    const offerings = new Map<string, ModelOffering[]>([[ALICE.toLowerCase(), [cheapOffering]]])
    const openJobs = new Map<string, number>([[ALICE.toLowerCase(), 999]])
    const chain = mkChain(providers, offerings, openJobs)
    const {chosen, busy} = await selectProviderWithDetail(chain, 'cheapest', {modelId: 'llama3:8b'})
    expect(chosen?.provider.owner).toBe(ALICE)
    expect(busy).toHaveLength(0)
  })

  it('returns matches=[] when nobody offers the model — caller fails fast', async () => {
    const providers = [mkProvider({owner: ALICE, maxConcurrentJobs: 2})]
    const offerings = new Map<string, ModelOffering[]>([[ALICE.toLowerCase(), [cheapOffering]]])
    const openJobs = new Map<string, number>([[ALICE.toLowerCase(), 0]])
    const chain = mkChain(providers, offerings, openJobs)
    const {chosen, matches} = await selectProviderWithDetail(chain, 'cheapest', {modelId: 'qwen2.5:72b'})
    expect(chosen).toBeNull()
    expect(matches).toHaveLength(0)
  })
})

describe('selectProviderWithDetail — manual strategy', () => {
  it('resolves a provider that is not first in the registry', async () => {
    // Regression: manual mode read only `listProviders(0, 1)` and fell back to
    // a synthesized stub, which lacked the pssPublicKey/swarmOverlay the
    // gateway needs to encrypt and route — it threw at encryption time.
    const providers = [
      mkProvider({owner: ALICE}),
      mkProvider({owner: BOB, pssPublicKey: '0xbeef', swarmOverlay: '0xcafe', maxConcurrentJobs: 4}),
    ]
    const offerings = new Map<string, ModelOffering[]>([
      [ALICE.toLowerCase(), [cheapOffering]],
      [BOB.toLowerCase(), [pricierOffering]],
    ])
    const chain = mkChain(providers, offerings, new Map([[BOB.toLowerCase(), 1]]))
    const {chosen} = await selectProviderWithDetail(chain, 'manual', {
      modelId: 'llama3:8b',
      manualProvider: BOB,
    })
    expect(chosen?.provider.owner).toBe(BOB)
    expect(chosen?.provider.pssPublicKey).toBe('0xbeef')
    expect(chosen?.provider.swarmOverlay).toBe('0xcafe')
    expect(chosen?.provider.maxConcurrentJobs).toBe(4)
    expect(chosen?.openJobs).toBe(1)
  })

  it('honours the manual provider’s real concurrency cap', async () => {
    const providers = [mkProvider({owner: ALICE}), mkProvider({owner: BOB, maxConcurrentJobs: 2})]
    const offerings = new Map<string, ModelOffering[]>([[BOB.toLowerCase(), [cheapOffering]]])
    const chain = mkChain(providers, offerings, new Map([[BOB.toLowerCase(), 2]]))
    const {chosen, busy} = await selectProviderWithDetail(chain, 'manual', {
      modelId: 'llama3:8b',
      manualProvider: BOB,
    })
    expect(chosen).toBeNull()
    expect(busy).toHaveLength(1)
  })

  it('returns no match for an address that is not registered', async () => {
    const providers = [mkProvider({owner: ALICE})]
    const offerings = new Map<string, ModelOffering[]>([[BOB.toLowerCase(), [cheapOffering]]])
    const chain = mkChain(providers, offerings, new Map())
    const {chosen, matches} = await selectProviderWithDetail(chain, 'manual', {
      modelId: 'llama3:8b',
      manualProvider: BOB,
    })
    expect(chosen).toBeNull()
    expect(matches).toHaveLength(0)
  })
})
