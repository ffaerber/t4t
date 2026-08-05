import type {Address} from 'viem'
import type {ChainClient} from '../../lib/chain'
import {getOfferings, getOpenJobs, getProvider, listProviders} from '../../lib/chain'
import type {ModelOffering, ProviderRow} from '../../lib/types'

export type SelectionStrategy = 'cheapest' | 'top_rep_cheapest' | 'manual'

export interface SelectionContext {
  modelId: string
  /** Optional cap on (input + output) xBZZ wei per 1M tokens combined. */
  maxPrice?: bigint
  /** Required when strategy = 'manual'. */
  manualProvider?: Address
}

function combinedPrice(o: ModelOffering): bigint {
  return o.inputPricePerMillionTokens + o.outputPricePerMillionTokens
}

export interface CandidateProvider {
  provider: ProviderRow
  offering: ModelOffering
  /** Current on-chain in-flight job count for this provider. */
  openJobs: number
  /** True if `openJobs >= maxConcurrentJobs` and the provider published a cap.
   *  Selectors use this to skip the candidate without filtering it out of the
   *  pool entirely — the gateway's wait loop needs to know how many are busy. */
  atCapacity: boolean
}

const MIN_TOTAL_JOBS = 20
const MIN_SUCCESS_RATE = 0.95
/** Share of routes given to new providers so they can build reputation. */
const EXPLORATION_SHARE = 0.05
/** Matches `ProviderRegistry.HEARTBEAT_TTL`. Providers stale past this drop
 *  from the selectable set, even if `active` is still true on-chain. */
const HEARTBEAT_TTL_SECONDS = 600

/**
 * Pull the active provider set, filter to those that offer the requested model
 * within budget, then rank per the selected strategy. See spec §8.
 *
 * Returns the best **available** candidate (under its advertised capacity). If
 * every match is at capacity, returns `null` and the caller's wait loop
 * (see `selectProviderWithDetail`) re-polls. For richer fallback / wait
 * decisions, callers should use `selectProviderWithDetail` instead.
 */
export async function selectProvider(
  chain: ChainClient,
  strategy: SelectionStrategy,
  ctx: SelectionContext,
): Promise<CandidateProvider | null> {
  const {chosen} = await selectProviderWithDetail(chain, strategy, ctx)
  return chosen
}

export interface SelectionResult {
  /** Picked candidate, or null if no available provider after filtering. */
  chosen: CandidateProvider | null
  /** All matches for the model, regardless of capacity — lets the caller
   *  decide whether to wait (some at capacity, eventually free) or fail
   *  fast (zero matches). */
  matches: CandidateProvider[]
  /** Subset of `matches` whose `atCapacity` is true. */
  busy: CandidateProvider[]
}

export async function selectProviderWithDetail(
  chain: ChainClient,
  strategy: SelectionStrategy,
  ctx: SelectionContext,
): Promise<SelectionResult> {
  if (strategy === 'manual') {
    if (!ctx.manualProvider) throw new Error('manual strategy requires T4T_MANUAL_PROVIDER')
    const c = await matchOffering(chain, ctx.manualProvider, ctx)
    if (!c) return {chosen: null, matches: [], busy: []}
    const matches = [c]
    const busy = c.atCapacity ? matches : []
    return {chosen: c.atCapacity ? null : c, matches, busy}
  }

  const matches: CandidateProvider[] = []
  const now = Math.floor(Date.now() / 1000)
  let cursor = 0n
  for (let i = 0; i < 20; i++) {
    const {page, nextCursor} = await listProviders(chain, cursor, 50n)
    for (const provider of page) {
      if (!provider.active) continue
      if (!isHeartbeatFresh(provider.lastHeartbeat, now)) continue
      const offerings = await getOfferings(chain, provider.owner)
      const offering = offerings.find(
        o =>
          o.modelId === ctx.modelId &&
          (ctx.maxPrice === undefined || combinedPrice(o) <= ctx.maxPrice),
      )
      if (!offering) continue
      const openJobs = await getOpenJobs(chain, provider.owner).catch(() => 0)
      const atCapacity = isAtCapacity(provider, openJobs)
      matches.push({provider, offering, openJobs, atCapacity})
    }
    if (nextCursor === cursor || page.length === 0) break
    cursor = nextCursor
  }
  const available = matches.filter(c => !c.atCapacity)
  const busy = matches.filter(c => c.atCapacity)
  return {chosen: rank(available, strategy), matches, busy}
}

/** A provider is at capacity when it has published a `maxConcurrentJobs > 0`
 *  cap and its on-chain `openJobs` has reached or exceeded it. Providers that
 *  haven't published a cap (legacy default `0`) are treated as routable —
 *  the contract's stake-collateral check in `JobEscrow.postJob` remains the
 *  hard backstop in that case. */
export function isAtCapacity(provider: ProviderRow, openJobs: number): boolean {
  const cap = provider.maxConcurrentJobs
  if (!cap || cap === 0) return false
  return openJobs >= cap
}

export function isHeartbeatFresh(lastHeartbeat: number | bigint, nowSeconds: number): boolean {
  const last = typeof lastHeartbeat === 'bigint' ? Number(lastHeartbeat) : lastHeartbeat
  if (last === 0) return false
  return last + HEARTBEAT_TTL_SECONDS >= nowSeconds
}

async function matchOffering(
  chain: ChainClient,
  owner: Address,
  ctx: SelectionContext,
): Promise<CandidateProvider | null> {
  const offerings = await getOfferings(chain, owner)
  const offering = offerings.find(
    o => o.modelId === ctx.modelId && (ctx.maxPrice === undefined || combinedPrice(o) <= ctx.maxPrice),
  )
  if (!offering) return null
  // Read the row directly rather than scanning `listProviders` — a paged scan
  // would have to walk the whole registry to find one address, and the caller
  // needs the real `pssPublicKey` / `swarmOverlay` to encrypt and route the
  // request. A synthesized stub would blow up at encryption time instead.
  const provider = await getProvider(chain, owner)
  if (!provider || isZeroAddress(provider.owner)) return null
  const openJobs = await getOpenJobs(chain, owner).catch(() => 0)
  return {provider, offering, openJobs, atCapacity: isAtCapacity(provider, openJobs)}
}

function isZeroAddress(a: string | undefined): boolean {
  return !a || /^0x0{40}$/i.test(a)
}

function rank(candidates: CandidateProvider[], strategy: SelectionStrategy): CandidateProvider | null {
  if (candidates.length === 0) return null

  if (strategy === 'cheapest') {
    return [...candidates].sort((a, b) => Number(combinedPrice(a.offering) - combinedPrice(b.offering)))[0]!
  }

  // top_rep_cheapest
  const newcomers = candidates.filter(c => c.provider.totalJobs < MIN_TOTAL_JOBS)
  const seasoned = candidates
    .filter(c => c.provider.totalJobs >= MIN_TOTAL_JOBS)
    .filter(c => successRate(c.provider) >= MIN_SUCCESS_RATE)

  if (seasoned.length > 0 && newcomers.length > 0 && Math.random() < EXPLORATION_SHARE) {
    return newcomers[Math.floor(Math.random() * newcomers.length)]!
  }
  const pool = seasoned.length > 0 ? seasoned : candidates
  return [...pool].sort((a, b) => Number(combinedPrice(a.offering) - combinedPrice(b.offering)))[0]!
}

function successRate(p: ProviderRow): number {
  return p.totalJobs === 0 ? 0 : p.successfulJobs / p.totalJobs
}
