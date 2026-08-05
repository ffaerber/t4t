import {Bee, Topic, type PssSubscription} from '@ethersphere/bee-js'
import {isAddressEqual} from 'viem'
import type {Envelope, Hex} from './types'
import {decodeEnvelope, encodeEnvelope, envelopeKey, DedupCache, verifyEnvelope} from './envelope'
import type {Logger} from './logger'

/** Address equality that tolerates the garbage an attacker can put in a PSS
 *  envelope — viem's `isAddressEqual` throws on anything that isn't a
 *  well-formed address, and a throw here would surface as a decode failure
 *  rather than a clean drop. */
export function addressesEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  try {
    return isAddressEqual(a as Hex, b as Hex)
  } catch {
    return false
  }
}

export interface SwarmClientOpts {
  bee: Bee
  postageBatchId: string
  logger: Logger
}

/** Returns true if the Bee error means "the postage batch ran out of bucket
 *  capacity" (HTTP 402 with `code:402, message:"batch is overissued"`). */
function isBatchOverissued(err: unknown): boolean {
  const e = err as {status?: number; responseBody?: {message?: string; code?: number}} | null
  if (!e || e.status !== 402) return false
  const msg = e.responseBody?.message ?? ''
  return /overissued|insufficient/i.test(msg) || e.responseBody?.code === 402
}

/** Detect HTTP 429 from Bee. bee-js surfaces this as either an axios-style
 *  message ("Request failed with status code 429") or as `{status: 429}` on
 *  its error object — match both. */
function isRateLimited(err: unknown): boolean {
  const e = err as {status?: number; message?: string} | null
  if (!e) return false
  if (e.status === 429) return true
  return typeof e.message === 'string' && /status code 429|\b429\b/.test(e.message)
}

/** Retry a Bee call that 429-ed with exponential backoff. PSS in particular
 *  can be rate-limited when the gateway and provider share a Bee node — a
 *  small retry loop turns a transient throttle into a slightly slower request
 *  instead of a user-visible failure. Non-429 errors propagate immediately. */
async function withRateLimitRetry<T>(
  logger: Logger,
  label: string,
  fn: () => Promise<T>,
  delaysMs: readonly number[] = [1000, 3000, 9000],
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i <= delaysMs.length; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isRateLimited(err) || i === delaysMs.length) throw err
      const delay = delaysMs[i]!
      logger.warn({label, attempt: i + 1, delay}, 'bee 429 — backing off and retrying')
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastErr
}

/** Emergency self-heal: when a Bee call fails because the batch is full,
 *  dilute it by +1 depth (doubles bucket capacity, halves remaining TTL) and
 *  retry the call exactly once. Logged so the operator sees the recovery.
 *  Bee handles the dilute tx from its own wallet — we don't pay xBZZ here. */
const EMERGENCY_DILUTE_MAX_DEPTH = 28
async function withBatchRecovery<T>(opts: SwarmClientOpts, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!isBatchOverissued(err)) throw err
    const batches = await opts.bee.getAllPostageBatch().catch(() => [])
    const batch = batches.find(b => b.batchID.toString() === opts.postageBatchId)
    if (!batch) throw err
    if (batch.depth >= EMERGENCY_DILUTE_MAX_DEPTH) {
      opts.logger.error({batchId: opts.postageBatchId, depth: batch.depth}, 'batch overissued and at depth cap — cannot self-heal')
      throw err
    }
    const newDepth = batch.depth + 1
    opts.logger.warn(
      {batchId: opts.postageBatchId, from: batch.depth, to: newDepth},
      'batch overissued — emergency dilute then retry',
    )
    await opts.bee.diluteBatch(opts.postageBatchId, newDepth)
    // Bee's diluteBatch returns when the tx is SUBMITTED, not mined. The local
    // node won't accept writes at the new depth until the tx confirms on
    // Gnosis (~5-15s). Poll until the batch's depth actually reflects the
    // dilute, with a 30s ceiling. Without this, the retry races the chain and
    // hits the same 402.
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const refreshed = await opts.bee.getAllPostageBatch().catch(() => [])
      const b = refreshed.find(x => x.batchID.toString() === opts.postageBatchId)
      if (b && b.depth >= newDepth) {
        opts.logger.info({batchId: opts.postageBatchId, depth: b.depth}, 'dilute confirmed')
        break
      }
      await new Promise(r => setTimeout(r, 1500))
    }
    return await fn()
  }
}

/** Upload a single chunk and return its Swarm reference (hex). */
export async function uploadChunk(
  opts: SwarmClientOpts,
  bytes: Uint8Array,
): Promise<string> {
  return withBatchRecovery(opts, async () => {
    const {reference} = await opts.bee.uploadData(opts.postageBatchId, bytes)
    return reference.toString()
  })
}

export async function downloadChunk(opts: SwarmClientOpts, reference: string): Promise<Uint8Array> {
  const data = await opts.bee.downloadData(reference)
  return data.toUint8Array()
}

/** Pick the most usable postage batch the Bee node already owns. We prefer
 *  batches that Bee marks as `usable: true` (i.e. enough block confirmations
 *  and not expired), with the largest remaining capacity as a tiebreaker.
 *  Returns null when the node has no usable batch — the caller should surface
 *  this so the operator can buy or top-up one. */
export async function discoverUsableBatchId(bee: Bee): Promise<string | null> {
  const all = await bee.getAllPostageBatch().catch(() => [])
  const usable = all.filter(b => b.usable)
  if (usable.length === 0) return null
  // Pick the longest-lived as a proxy for "still valid for the next while".
  usable.sort((a, b) => b.duration.toSeconds() - a.duration.toSeconds())
  return usable[0]!.batchID.toString()
}

export interface PssTransportOpts extends SwarmClientOpts {
  selfAddress: Hex
  dedupCapacity?: number
}

export interface PssSendArgs {
  topic: string
  /** Target's Swarm overlay address (hex, 0x-prefixed). */
  recipientOverlay: Hex
  /** Recipient's PSS public key (hex, 0x-prefixed compressed pubkey). */
  recipientPssKey: Hex
  envelope: Envelope
}

export interface PssSubscribeArgs {
  topic: string
  onEnvelope: (env: Envelope) => void | Promise<void>
  onError?: (err: unknown) => void
}

/** Managed subscription handle. The underlying bee-js subscription may be
 *  recreated on disconnect; `cancel` stops the reconnect loop and closes the
 *  active subscription. */
export interface ManagedPssSubscription {
  cancel: () => void
}

/**
 * Thin wrapper over bee-js PSS that signs nothing and verifies everything.
 * Envelope signing happens upstream in `envelope.ts`; this layer only routes.
 */
export class PssTransport {
  private readonly dedup: DedupCache

  constructor(private readonly opts: PssTransportOpts) {
    this.dedup = new DedupCache(opts.dedupCapacity ?? 10_000)
  }

  async send(args: PssSendArgs): Promise<void> {
    const topic = Topic.fromString(args.topic)
    // First 2 bytes of the overlay narrow PSS forwarding without doxxing
    // the full target address (Bee convention).
    const target = args.recipientOverlay.slice(2, 6)
    // The on-chain registry stores `pssPublicKey` as bytes32 (X coord only)
    // and our keygen guarantees even-Y parity (see lib/keys.ts), so prepend
    // 0x02 to rebuild the 33-byte compressed pubkey form bee-js' PublicKey
    // class accepts. Passing bare 32 bytes throws
    //   "Bytes#checkByteLength: bytes length is 32 but expected 64".
    const x = args.recipientPssKey.replace(/^0x/, '')
    if (x.length !== 64) {
      throw new Error(`recipient PSS pubkey must be 32-byte X coord (got ${x.length / 2} bytes)`)
    }
    const pubKey = '02' + x
    await withRateLimitRetry(this.opts.logger, 'pssSend', () =>
      withBatchRecovery(this.opts, () =>
        this.opts.bee.pssSend(
          this.opts.postageBatchId,
          topic,
          target,
          encodeEnvelope(args.envelope),
          pubKey,
        ),
      ),
    )
  }

  /** Subscribe to a PSS topic with auto-reconnect on disconnect.
   *
   *  Bee-js delivers `onClose` / `onError` when the SSE stream backing
   *  pssSubscribe drops (Bee restart, network blip, idle timeout). The plain
   *  bee-js subscription does NOT auto-recover, which silently drops every
   *  subsequent message and is the root cause of the "job_deliver never
   *  arrived" / "provider failed to ACK" symptoms we hit when Bee or its RPC
   *  flapped. This wrapper re-subscribes with exponential backoff (capped at
   *  60s) and resets the backoff after 60s of stability. */
  subscribe(args: PssSubscribeArgs): ManagedPssSubscription {
    const topic = Topic.fromString(args.topic)
    let cancelled = false
    let activeSub: PssSubscription | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let stableTimer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const scheduleReconnect = (reason: string): void => {
      if (cancelled || reconnectTimer) return
      if (stableTimer) {
        clearTimeout(stableTimer)
        stableTimer = undefined
      }
      const delay = Math.min(60_000, 500 * 2 ** attempt)
      attempt++
      this.opts.logger.warn({topic: args.topic, reason, delay, attempt}, 'pss reconnecting')
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        open()
      }, delay)
    }

    const open = (): void => {
      if (cancelled) return
      activeSub = this.opts.bee.pssSubscribe(topic, {
        onMessage: async msg => {
          try {
            const env = decodeEnvelope(msg.toUtf8())
            const key = envelopeKey(env)
            if (this.dedup.has(key)) return
            if (!(await verifyEnvelope(env))) {
              this.opts.logger.warn({from: env.from}, 'envelope signature verification failed')
              return
            }
            // A valid signature only proves the envelope came from *some*
            // wallet — topics are public and derived from an on-chain address,
            // so anyone can post to ours. Drop anything not addressed to us
            // before it reaches the handler. Callers still have to authorize
            // the *sender* against their own job state; see the `from` checks
            // in the gateway's ack/deliver handlers.
            if (!addressesEqual(env.to, this.opts.selfAddress)) {
              this.opts.logger.warn(
                {from: env.from, to: env.to, type: env.type},
                'dropping envelope addressed to someone else',
              )
              return
            }
            this.dedup.mark(key)
            await args.onEnvelope(env)
          } catch (err) {
            args.onError?.(err)
            this.opts.logger.error({err}, 'pss decode failure')
          }
        },
        onError: err => {
          args.onError?.(err)
          this.opts.logger.error({err, topic: args.topic}, 'pss subscription error')
          scheduleReconnect('error')
        },
        onClose: () => {
          this.opts.logger.warn({topic: args.topic}, 'pss subscription closed')
          scheduleReconnect('close')
        },
      })
      // Reset backoff once we've held the connection for a stable window.
      // Without this, a long-running container that hits a flap an hour from
      // now would jump straight to the 60s cap.
      stableTimer = setTimeout(() => {
        attempt = 0
        stableTimer = undefined
      }, 60_000)
    }

    open()

    return {
      cancel: () => {
        cancelled = true
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
          reconnectTimer = undefined
        }
        if (stableTimer) {
          clearTimeout(stableTimer)
          stableTimer = undefined
        }
        try {
          activeSub?.cancel()
        } catch {
          // bee-js sometimes throws if cancel() is called on an already-closed
          // subscription; harmless.
        }
      },
    }
  }
}
