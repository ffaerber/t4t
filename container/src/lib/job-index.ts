import {keccak256, type Address} from 'viem'
import {jobEscrowAbi} from './abi'
import type {ChainClient} from './chain'
import {readJob} from './chain'
import type {Logger} from './logger'
import type {Hex} from './types'

/**
 * Maps the routing id (`keccak256(requestHash)`) to the on-chain jobId emitted
 * by `JobEscrow.JobPosted`. The provider needs this map to call `claimJob` —
 * the PSS notify carries the requestHash, but the contract addresses jobs by
 * `keccak256(chainid, escrow, client, counter)`.
 *
 * Implementation: poll `eth_getLogs` over `JobPosted(provider=self)` between
 * the last seen block and head, then read `jobs[jobId]` to extract the
 * requestHash and store the reverse lookup. Bounded LRU so a long-running
 * provider doesn't leak memory.
 *
 * We poll getLogs rather than using viem's `watchContractEvent`, because
 * public RPCs like rpc.gnosischain.com are load-balanced/stateless and forget
 * filter ids between requests, breaking `eth_newFilter` + `eth_getFilterChanges`.
 * Same rationale as the gateway's JobClaimed loop.
 */
const POLL_INTERVAL_MS = 4_000

export class JobPostedIndex {
  private readonly byRouting = new Map<Hex, Hex>()
  private readonly order: Hex[] = []
  private timer?: ReturnType<typeof setInterval>
  private lastBlock = 0n
  private polling = false

  constructor(
    private readonly chain: ChainClient,
    private readonly provider: Address,
    private readonly log: Logger,
    private readonly capacity = 4096,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.poll()
    }, POLL_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const current = await this.chain.pub.getBlockNumber()
      if (this.lastBlock === 0n) {
        // Anchor cursor to head on first successful tick — match prior
        // watchContractEvent semantics (future events only, no backfill).
        // Step back one block so the anchor block itself is still scanned:
        // the next poll starts at `lastBlock + 1`, so anchoring exactly at
        // head would silently drop a JobPosted mined in that same block, and
        // the provider would deliver work it can never claim.
        this.lastBlock = current > 0n ? current - 1n : 0n
        return
      }
      if (current <= this.lastBlock) return
      const logs = await this.chain.pub.getContractEvents({
        address: this.chain.escrow,
        abi: jobEscrowAbi,
        eventName: 'JobPosted',
        args: {provider: this.provider},
        fromBlock: this.lastBlock + 1n,
        toBlock: current,
      })
      for (const ev of logs) {
        const jobId = ev.args.jobId as Hex | undefined
        if (!jobId) continue
        try {
          await this.ingest(jobId)
        } catch (err) {
          this.log.warn({err, jobId}, 'failed to ingest JobPosted')
        }
      }
      this.lastBlock = current
    } catch (err) {
      this.log.warn({err}, 'JobPosted poll failed (will retry)')
    } finally {
      this.polling = false
    }
  }

  /** Resolve a routing id (from the PSS notify) to its on-chain jobId. */
  get(routingId: Hex): Hex | undefined {
    return this.byRouting.get(routingId.toLowerCase() as Hex)
  }

  /** Manual seed — used when the worker computes routing ahead of the event. */
  async ingest(jobId: Hex): Promise<Hex | null> {
    const job = await readJob(this.chain, jobId)
    if (!job.requestHash) return null
    const routing = keccak256(job.requestHash)
    this.set(routing, jobId)
    return routing
  }

  private set(routing: Hex, jobId: Hex): void {
    const key = routing.toLowerCase() as Hex
    if (this.byRouting.has(key)) return
    this.byRouting.set(key, jobId)
    this.order.push(key)
    while (this.order.length > this.capacity) {
      const oldest = this.order.shift()
      if (oldest) this.byRouting.delete(oldest)
    }
  }

  get size(): number {
    return this.byRouting.size
  }
}
