import {Bee} from '@ethersphere/bee-js'
import {keccak256, toBytes, toHex} from 'viem'
import {join} from 'node:path'
import type {GatewayConfig} from '../../lib/config'
import {walletKeyFilePath} from '../../lib/config'
import {startOnboardingServer, isZeroAddress} from '../../lib/onboarding'
import {discoverUsableBatchId} from '../../lib/swarm'
import {ensureManagedStamp, hasReusableLabeledBatch, topUpIfBelow, type ManagedStamp} from '../../lib/stamps'
import {readPersistedBatch, writePersistedBatch} from '../../lib/postage-state'
import {privateKeyToAccount} from 'viem/accounts'
import {ACK_WINDOW_SECONDS, cancelJob, ensureAllowance, makeChain, postJob, timeoutJob} from '../../lib/chain'
import {jobEscrowAbi} from '../../lib/abi'
import {ModelDiscovery} from './models'
import {logger} from '../../lib/logger'
import {PssTransport, addressesEqual, uploadChunk, downloadChunk} from '../../lib/swarm'
import {signEnvelope, clientTopic, providerTopic} from '../../lib/envelope'
import {EciesCipher, jsonDecrypt, jsonEncrypt} from '../../lib/crypto'
import {JobsDb} from '../../lib/jobs-db'
import {loadOrCreatePssKey} from '../../lib/keys'
import {selectProviderWithDetail, type CandidateProvider} from './selector'
import {startAdminServer} from './admin'
import {computeMaxPayment, contentToText} from '../../lib/token-budget'
import type {
  Hex,
  JobAckBody,
  JobDeliverBody,
  JobNotifyBody,
  OpenAIChatRequest,
  OpenAIChatResponse,
  ProgressEvent,
  RequestPayload,
  ResponsePayload,
} from '../../lib/types'

const PROTOCOL_VERSION = 1 as const

export async function startGateway(cfg: GatewayConfig): Promise<void> {
  const log = logger.child({mode: 'gateway'})

  // Onboarding-only mode covers two pre-flight states:
  //   1) no wallet yet → show create/import UI
  //   2) wallet exists but protocol addresses are still placeholder zeros →
  //      show "configure addresses" UI (won't try chain calls and crash-loop).
  const contractsMissing =
    isZeroAddress(cfg.REGISTRY_ADDRESS) ||
    isZeroAddress(cfg.ESCROW_ADDRESS) ||
    isZeroAddress(cfg.XBZZ_ADDRESS)
  const onboardingBase = {
    role: 'gateway' as const,
    host: cfg.T4T_ADMIN_HOST,
    port: cfg.T4T_ADMIN_PORT,
    walletFilePath: walletKeyFilePath(cfg.T4T_DATA_DIR),
    existingAddress: cfg.walletKey ? privateKeyToAccount(cfg.walletKey).address : null,
    protocol: {registry: cfg.REGISTRY_ADDRESS, escrow: cfg.ESCROW_ADDRESS, xbzz: cfg.XBZZ_ADDRESS},
    logger: log,
  }
  if (!cfg.walletKey || contractsMissing) {
    startOnboardingServer(onboardingBase)
    return
  }

  const bee = new Bee(cfg.BEE_API_URL)

  // Resolve postage batch:
  //   1. POSTAGE_BATCH_ID env wins — operator owns the lifecycle, no auto-manage.
  //   2. Persisted file at ${T4T_DATA_DIR}/postage-batch.json — sticks to the
  //      batch we resolved on a previous boot so multi-batch Bee nodes don't
  //      drift to a different batch each restart. Invalidated when
  //      T4T_STAMP_LABEL changes or when the persisted batch is no longer
  //      usable on Bee.
  //   3. T4T_STAMP_MANAGE=true (default) → only reuse or buy a batch labelled
  //      T4T_STAMP_LABEL. If that fails (e.g. Bee wallet out of funds), enter
  //      onboarding rather than silently picking a random unlabelled batch.
  //   4. T4T_STAMP_MANAGE=false → legacy discover-any-usable-batch.
  // No usable batch in any path = onboarding.
  const autoManage = !cfg.POSTAGE_BATCH_ID && cfg.T4T_STAMP_MANAGE
  let managed: ManagedStamp | null = null
  let resolved: string | null = cfg.POSTAGE_BATCH_ID ?? null
  let source: string = cfg.POSTAGE_BATCH_ID ? 'env' : 'unknown'
  if (!resolved) {
    const persisted = readPersistedBatch(cfg.T4T_DATA_DIR)
    if (persisted && persisted.label === cfg.T4T_STAMP_LABEL) {
      const stillUsable = await bee
        .getPostageBatch(persisted.batchId)
        .then(b => (b as unknown as {usable: boolean}).usable)
        .catch(() => false)
      if (stillUsable) {
        resolved = persisted.batchId
        source = `persisted:${persisted.source}`
        log.info({batchId: persisted.batchId, label: persisted.label}, 'using persisted postage batch')
      } else {
        log.warn({batchId: persisted.batchId}, 'persisted postage batch no longer usable on Bee — re-resolving')
      }
    }
  }
  if (!resolved && cfg.T4T_STAMP_MANAGE) {
    try {
      managed = await ensureManagedStamp({
        bee,
        logger: log,
        opts: {
          depth: cfg.T4T_STAMP_DEPTH,
          ttlDays: cfg.T4T_STAMP_TTL_DAYS,
          minTtlDays: cfg.T4T_STAMP_MIN_TTL_DAYS,
          label: cfg.T4T_STAMP_LABEL,
          dryRun: cfg.T4T_STAMP_DRY_RUN,
        },
      })
      resolved = managed.batchID
      source = managed.source
    } catch (err) {
      log.error(
        {err, label: cfg.T4T_STAMP_LABEL},
        'managed stamp ensure failed — refusing to fall back to an unlabelled batch',
      )
    }
  }
  if (!resolved && !cfg.T4T_STAMP_MANAGE) {
    resolved = await discoverUsableBatchId(bee).catch(() => null)
    if (resolved) source = 'discover'
  }
  if (!resolved) {
    log.warn(
      {beeUrl: cfg.BEE_API_URL, label: cfg.T4T_STAMP_LABEL, manage: cfg.T4T_STAMP_MANAGE},
      'no usable postage batch — entering onboarding',
    )
    startOnboardingServer({
      ...onboardingBase,
      stamp: {missing: true, beeUrl: cfg.BEE_API_URL},
      recheck: async () => {
        if (cfg.POSTAGE_BATCH_ID) return true
        if (cfg.T4T_STAMP_MANAGE) {
          return hasReusableLabeledBatch(bee, cfg.T4T_STAMP_LABEL, cfg.T4T_STAMP_MIN_TTL_DAYS)
        }
        return (await discoverUsableBatchId(bee).catch(() => null)) !== null
      },
    })
    return
  }
  const postageBatchId: string = resolved
  log.info({postageBatchId, source, label: cfg.T4T_STAMP_LABEL}, 'postage batch resolved')

  // Persist for next boot. POSTAGE_BATCH_ID env path skips this — env is
  // authoritative and the operator controls the lifecycle there.
  if (!cfg.POSTAGE_BATCH_ID) {
    try {
      writePersistedBatch(cfg.T4T_DATA_DIR, {
        batchId: postageBatchId,
        label: cfg.T4T_STAMP_LABEL,
        source,
      })
    } catch (err) {
      log.warn({err}, 'failed to persist postage batch state')
    }
  }

  // Background TTL-watch on a fixed 5-minute tick (gateway has no heartbeat
  // loop to piggyback on like provider does). Runs whenever managed mode is
  // on, regardless of how we resolved the batch.
  if (autoManage) {
    setInterval(() => {
      topUpIfBelow({
        bee,
        logger: log,
        batchId: postageBatchId,
        ttlDays: cfg.T4T_STAMP_TTL_DAYS,
        minTtlDays: cfg.T4T_STAMP_MIN_TTL_DAYS,
        maxUtilization: cfg.T4T_STAMP_MAX_UTILIZATION,
        maxDepth: cfg.T4T_STAMP_MAX_DEPTH,
        dryRun: cfg.T4T_STAMP_DRY_RUN,
      }).catch(err => log.warn({err}, 'stamp tick failed'))
    }, 300_000).unref()
  }

  const chain = makeChain({
    rpcUrl: cfg.GNOSIS_RPC_URL,
    privateKey: cfg.walletKey,
    registry: cfg.REGISTRY_ADDRESS,
    escrow: cfg.ESCROW_ADDRESS,
    xbzz: cfg.XBZZ_ADDRESS,
  })

  // Open the db here (before any chain write) so postJob/cancelJob/etc.
  // flow into the `transactions` table.
  const db = new JobsDb({path: join(cfg.T4T_DATA_DIR, 'jobs.db')})
  chain.onTx = e => db.recordTx({hash: e.hash, kind: e.kind, fromAddress: chain.address, toAddress: e.toAddress, note: e.note ?? null})

  // Watch JobClaimed so the gateway's job rows record the actual paid amount
  // (the on-chain Job struct doesn't carry it — the event is the only source).
  // We can't filter by client (the event only indexes jobId), so we receive
  // every JobClaimed and join by `onChainJobId` against our own rows.
  //
  // Use eth_getLogs polling, NOT viem's default eth_newFilter + getFilterChanges.
  // Public RPCs like rpc.gnosischain.com are load-balanced/stateless and forget
  // filter ids between requests, producing "filter not found" errors. Stateless
  // getLogs over [last, current] survives that.
  //
  // The cursor is anchored lazily on the first tick that reaches the RPC. It
  // must never fall back to 0 on error: `fromBlock: 1` asks a public RPC for
  // every log since genesis, which it refuses, so the catch below would fire
  // forever and the cursor would never advance past 0.
  let lastBlock: bigint | null = null
  const JOB_CLAIMED_POLL_MS = 10_000
  setInterval(async () => {
    try {
      const current = await chain.pub.getBlockNumber()
      if (lastBlock === null) {
        lastBlock = current > 0n ? current - 1n : 0n
        return
      }
      if (current <= lastBlock) return
      const logs = await chain.pub.getContractEvents({
        address: chain.escrow,
        abi: jobEscrowAbi,
        eventName: 'JobClaimed',
        fromBlock: lastBlock + 1n,
        toBlock: current,
      })
      for (const ev of logs) {
        const id = ev.args.jobId as Hex | undefined
        const paid = ev.args.paid as bigint | undefined
        if (!id || paid === undefined) continue
        const changes = db.applyGatewayClaim({
          onChainJobId: id,
          actualPayment: paid.toString(),
          claimedAt: Math.floor(Date.now() / 1000),
        })
        if (changes > 0) log.info({onChainJobId: id, paid: paid.toString()}, 'JobClaimed applied')
      }
      lastBlock = current
    } catch (err) {
      log.warn({err}, 'JobClaimed poll failed (will retry)')
    }
  }, JOB_CLAIMED_POLL_MS).unref()

  const pssKeyPath = cfg.T4T_PSS_KEY_PATH ?? join(cfg.T4T_DATA_DIR, 'pss.key')
  const pssKeys = loadOrCreatePssKey(pssKeyPath)
  log.info({pssKeyPath, pssPubKeyX: pssKeys.publicKeyX}, 'PSS keypair loaded')

  // Gateway's own Bee overlay — included in the JobNotify envelope so the
  // provider can PSS-route ACK/deliver back without looking us up on-chain.
  const selfOverlay = ('0x' + (
    ((await bee.getNodeAddresses().catch(() => null))?.overlay?.toString() ?? '00'.repeat(32))
      .replace(/^0x/, '')
  )) as Hex
  const cipher = new EciesCipher(pssKeys.privateKey)
  const pss = new PssTransport({
    bee,
    postageBatchId,
    logger: log,
    selfAddress: chain.address,
  })
  const jobMeta = new Map<string, {provider: string; modelId: string}>()

  if (cfg.T4T_PERSIST_PAYLOADS) {
    setInterval(() => {
      const cutoff = Math.floor(Date.now() / 1000) - cfg.T4T_PAYLOAD_RETENTION_HOURS * 3600
      const redacted = db.redactGatewayPayloadsBefore(cutoff)
      if (redacted > 0) log.info({redacted}, 'expired payloads redacted')
    }, 3600_000)
  }

  // JobStatus enum order from JobEscrow.sol — keep in sync.
  const JOB_STATUS = ['none', 'pending', 'acked', 'delivered', 'claimed', 'cancelled', 'timed_out'] as const
  type DbJobStatus = 'cancelled' | 'timed_out'
  // True when the gateway should treat the DB row as terminal and stop sweeping.
  function dbStatusFromOnChain(onChain: number): DbJobStatus | null {
    if (onChain === 5) return 'cancelled'
    if (onChain === 6) return 'timed_out'
    return null
  }

  // Stale-job sweeper — safety net for the in-process per-job failure timer.
  // The fast path fires ~60s after postJob if PSS never delivers, but those
  // timers don't survive a container restart, so any job in flight at restart
  // gets orphaned in `posted` status forever and bloats the provider's
  // openJobs counter (which eventually trips InsufficientStakeForJob on new
  // postJob calls). This sweeper picks up the slack: every minute it scans
  // the gateway DB for rows still in `posted` after STALE_POSTED_SECONDS and
  // cancels them on-chain. A revert just leaves the row alone for the next
  // tick — usually means the provider mid-flight acked or the row already
  // resolved out-of-band.
  const STALE_POSTED_SECONDS = 10 * 60
  async function sweepStalePostedJobs(): Promise<void> {
    const cutoff = Math.floor(Date.now() / 1000) - STALE_POSTED_SECONDS
    const rows = db.listStalePostedGatewayJobs(cutoff)
    if (rows.length === 0) return
    log.info({count: rows.length, cutoffSeconds: STALE_POSTED_SECONDS}, 'sweeping stale posted jobs')
    for (const r of rows) {
      try {
        const tx = await cancelJob(chain, r.onChainJobId as Hex)
        db.applyGatewayStatusByOnChain({
          onChainJobId: r.onChainJobId!,
          status: 'cancelled',
          errorMessage: `auto-cancelled after ${STALE_POSTED_SECONDS}s in posted`,
        })
        log.info({onChainJobId: r.onChainJobId, tx, ageSec: Math.floor(Date.now() / 1000) - r.postedAt}, 'stale job auto-cancelled')
      } catch (err) {
        // The most common revert here is BadStatus() — the job is no longer
        // Pending on-chain because it was settled out-of-band (a stray manual
        // cancel, a late claim, a prior cancel that we didn't update the DB
        // for). Read the on-chain status; if it's terminal, heal the DB row
        // so the sweeper stops retrying every minute.
        try {
          const job = await chain.pub.readContract({
            address: cfg.ESCROW_ADDRESS,
            abi: jobEscrowAbi,
            functionName: 'jobs',
            args: [r.onChainJobId as Hex],
          }) as readonly unknown[]
          const onChainStatus = Number(job[10])
          const dbStatus = dbStatusFromOnChain(onChainStatus)
          if (dbStatus) {
            db.applyGatewayStatusByOnChain({
              onChainJobId: r.onChainJobId!,
              status: dbStatus,
              errorMessage: `auto-cancel reverted; on-chain status ${JOB_STATUS[onChainStatus] ?? onChainStatus} — DB healed`,
            })
            log.info({onChainJobId: r.onChainJobId, dbStatus}, 'DB row healed from on-chain terminal state')
            continue
          }
          // Non-terminal (None/Pending/Acked/Delivered/Claimed) — leave the
          // row alone. Pending shouldn't normally reach BadStatus, so log it.
          log.warn(
            {err, onChainJobId: r.onChainJobId, onChainStatus: JOB_STATUS[onChainStatus] ?? onChainStatus},
            'auto-cancel reverted; on-chain status is non-terminal — will retry next sweep',
          )
        } catch (readErr) {
          log.warn({err: readErr, onChainJobId: r.onChainJobId}, 'auto-cancel reverted and on-chain read failed; will retry next sweep')
        }
      }
    }
  }
  // Fire once on startup to clear restart-orphans, then on a 60s tick.
  sweepStalePostedJobs().catch(err => log.warn({err}, 'initial stale-job sweep failed'))
  setInterval(() => {
    sweepStalePostedJobs().catch(err => log.warn({err}, 'stale-job sweep crashed'))
  }, 60_000)

  // Pending jobs awaiting delivery; resolved on `job_deliver`.
  //
  // `onProgress` is the SSE progress sink wired up by the HTTP layer. Holding
  // it here (rather than on a side-channel keyed by jobId) lets the PSS
  // subscriber, which is where job_ack/job_deliver land, emit lifecycle events
  // without having to know which HTTP response a given job belongs to.
  const pending = new Map<
    Hex,
    {
      resolve: (r: OpenAIChatResponse) => void
      reject: (e: unknown) => void
      onProgress?: (e: ProgressEvent) => void
    }
  >()

  // Per-job failure timers — schedule on-chain cancel/timeout when the provider
  // fails liveness (spec §3). Both timers use a grace beyond the on-chain
  // deadline so `block.timestamp > deadline` holds when the tx mines. 30s
  // absorbs proposer clock skew + local RPC lag — 5s used to revert with
  // DeadlineNotPassed when the gateway's wallclock raced the chain's view.
  const FAILURE_GRACE_SECONDS = 30
  interface FailureSlot {
    onChainJobId: Hex
    deliveryDeadline: number
    cancelTimer?: NodeJS.Timeout
    timeoutTimer?: NodeJS.Timeout
  }
  const failureTimers = new Map<Hex, FailureSlot>()

  function clearFailureTimers(routing: Hex): void {
    const slot = failureTimers.get(routing)
    if (!slot) return
    if (slot.cancelTimer) clearTimeout(slot.cancelTimer)
    if (slot.timeoutTimer) clearTimeout(slot.timeoutTimer)
    failureTimers.delete(routing)
  }

  function rejectAndCleanup(routing: Hex, err: Error): void {
    pending.get(routing)?.reject(err)
    pending.delete(routing)
    jobMeta.delete(routing)
    clearFailureTimers(routing)
  }

  function persistFailureRow(routing: Hex, status: 'cancelled' | 'timed_out', errorMessage: string): void {
    const meta = jobMeta.get(routing)
    if (!meta) return
    db.recordGatewayJob({
      jobId: routing,
      onChainJobId: null,
      provider: meta.provider,
      modelId: meta.modelId,
      status,
      maxPayment: '0',
      actualPayment: null,
      postedAt: 0,
      ackedAt: null,
      deliveredAt: null,
      claimedAt: null,
      prompt: null,
      response: null,
      promptTokens: null,
      completionTokens: null,
      errorMessage,
    })
  }

  async function onAckTimeout(routing: Hex): Promise<void> {
    const slot = failureTimers.get(routing)
    if (!slot) return
    // Chain-time guard: cancelJob reverts with DeadlineNotPassed if the local
    // RPC's latest block is still <= ackDeadline. If the RPC is lagging behind
    // wallclock, reschedule a short retry instead of burning the cancel attempt.
    try {
      const block = await chain.pub.getBlock()
      const job = await chain.pub.readContract({
        address: cfg.ESCROW_ADDRESS,
        abi: jobEscrowAbi,
        functionName: 'jobs',
        args: [slot.onChainJobId],
      }) as readonly unknown[]
      const ackDeadline = job[8] as bigint
      if (block.timestamp <= ackDeadline) {
        const waitSec = Number(ackDeadline - block.timestamp) + FAILURE_GRACE_SECONDS
        log.warn({routing, blockTs: block.timestamp, ackDeadline, waitSec}, 'cancel too early per chain time — rescheduling')
        const t = setTimeout(() => {
          onAckTimeout(routing).catch(e => log.error({err: e, routing}, 'rescheduled onAckTimeout threw'))
        }, waitSec * 1000)
        slot.cancelTimer = t
        return
      }
    } catch (err) {
      // Chain read failed — fall through to the original cancel attempt; the
      // try/catch below still handles a revert without crashing.
      log.warn({err, routing}, 'pre-cancel chain time check failed; attempting cancelJob anyway')
    }
    try {
      const tx = await cancelJob(chain, slot.onChainJobId)
      log.warn({tx, routing, onChainJobId: slot.onChainJobId}, 'no ACK within window — cancelled on-chain')
      persistFailureRow(routing, 'cancelled', 'no PSS ack within ACK_WINDOW; cancelled on-chain')
      rejectAndCleanup(routing, new Error('provider failed to ACK within window'))
    } catch (err) {
      log.warn({err, routing}, 'cancelJob failed — provider likely acked on-chain mid-flight')
      // Provider may have on-chain-acked between our deadline check and tx — leave the
      // delivery timer to handle the unhappy path if no PSS deliver arrives.
    }
  }

  async function onDeliveryTimeout(routing: Hex): Promise<void> {
    const slot = failureTimers.get(routing)
    if (!slot) return
    // Spec §3: prefer timeoutJob (3× slash). Falls back to cancelJob if the
    // provider PSS-acked but never on-chain-acked — status stays Pending and
    // timeoutJob reverts with BadStatus, but cancelJob still applies.
    try {
      const tx = await timeoutJob(chain, slot.onChainJobId)
      log.warn({tx, routing, onChainJobId: slot.onChainJobId}, 'delivery deadline missed — timed out on-chain')
      persistFailureRow(routing, 'timed_out', 'no PSS delivery before deadline; timeoutJob applied')
      rejectAndCleanup(routing, new Error('provider failed to deliver before deadline'))
      return
    } catch (err) {
      log.warn({err, routing}, 'timeoutJob reverted — falling back to cancelJob')
    }
    try {
      const tx = await cancelJob(chain, slot.onChainJobId)
      log.warn({tx, routing, onChainJobId: slot.onChainJobId}, 'cancelJob fallback applied')
      persistFailureRow(routing, 'cancelled', 'no PSS delivery before deadline; cancelJob fallback applied')
      rejectAndCleanup(routing, new Error('provider failed to deliver before deadline'))
    } catch (err) {
      log.error({err, routing}, 'both timeoutJob and cancelJob failed — job stuck in escrow')
      rejectAndCleanup(routing, new Error('delivery deadline missed; settlement failed'))
    }
  }

  /** Authorize an inbound ack/deliver against the job it claims to be for.
   *
   *  A signature only proves the envelope came from *some* wallet, and the
   *  routing id is public: `JobPosted` is an indexed event, `jobs[jobId]`
   *  exposes `requestHash`, and the routing id is just its keccak. Without
   *  this check any observer could forge a `job_deliver` to hand our caller
   *  attacker-chosen content — or force the decrypt to fail, which drops the
   *  pending slot and clears the failure timers, stranding the escrow.
   *
   *  `jobMeta` is written at postJob time and holds the provider we actually
   *  selected, so it's the authority on who is allowed to answer. */
  function authorizeJobEnvelope(env: {from: Hex; type: string}, jobId: unknown): boolean {
    if (typeof jobId !== 'string') return false
    const meta = jobMeta.get(jobId)
    if (!meta) {
      // No record of this job: either it already settled, or it was never
      // ours. Either way nothing legitimate is waiting on it.
      log.warn({from: env.from, type: env.type, jobId}, 'dropping envelope for an unknown job')
      return false
    }
    if (!addressesEqual(env.from, meta.provider)) {
      log.warn(
        {from: env.from, expected: meta.provider, type: env.type, jobId},
        'dropping envelope from a wallet that is not this job’s provider',
      )
      return false
    }
    return true
  }

  pss.subscribe({
    topic: clientTopic(chain.address),
    onEnvelope: async env => {
      if (env.type === 'job_ack') {
        const body = env.body as JobAckBody
        if (!authorizeJobEnvelope(env, body?.jobId)) return
        log.info({jobId: body.jobId, eta: body.estimatedCompletion}, 'ack received')
        pending.get(body.jobId)?.onProgress?.({
          kind: 'provider_acked',
          estimatedCompletion: body.estimatedCompletion,
        })
        pending.get(body.jobId)?.onProgress?.({kind: 'awaiting_delivery'})
        const slot = failureTimers.get(body.jobId)
        if (slot) {
          if (slot.cancelTimer) {
            clearTimeout(slot.cancelTimer)
            slot.cancelTimer = undefined
          }
          if (!slot.timeoutTimer) {
            const msUntilTimeout = Math.max(
              0,
              (slot.deliveryDeadline + FAILURE_GRACE_SECONDS) * 1000 - Date.now(),
            )
            slot.timeoutTimer = setTimeout(() => {
              onDeliveryTimeout(body.jobId).catch(err =>
                log.error({err, routing: body.jobId}, 'onDeliveryTimeout threw'),
              )
            }, msUntilTimeout)
          }
        }
        const meta = jobMeta.get(body.jobId)
        if (meta) {
          db.recordGatewayJob({
            jobId: body.jobId,
            onChainJobId: null,
            provider: meta.provider,
            modelId: meta.modelId,
            status: 'acked',
            maxPayment: '0', // overridden by COALESCE
            actualPayment: null,
            postedAt: 0,
            ackedAt: Math.floor(Date.now() / 1000),
            deliveredAt: null,
            claimedAt: null,
            prompt: null,
            response: null,
            promptTokens: null,
            completionTokens: null,
            errorMessage: null,
          })
        }
      } else if (env.type === 'job_deliver') {
        const body = env.body as JobDeliverBody
        if (!authorizeJobEnvelope(env, body?.jobId)) return
        const slot = pending.get(body.jobId)
        if (!slot) return
        try {
          const bytes = await downloadChunk({bee, postageBatchId, logger: log}, body.responseHash)
          const payload = await jsonDecrypt<ResponsePayload>(cipher, bytes)
          const meta = jobMeta.get(body.jobId)
          if (meta) {
            const content = payload.openaiResponse.choices[0]?.message.content ?? ''
            db.recordGatewayJob({
              jobId: body.jobId,
              onChainJobId: null,
              provider: meta.provider,
              modelId: meta.modelId,
              status: 'delivered',
              maxPayment: '0',
              actualPayment: null,
              postedAt: 0,
              ackedAt: null,
              deliveredAt: Math.floor(Date.now() / 1000),
              claimedAt: null,
              prompt: null,
              response: cfg.T4T_PERSIST_PAYLOADS ? content : '[redacted]',
              promptTokens: payload.openaiResponse.usage?.prompt_tokens ?? null,
              completionTokens: payload.openaiResponse.usage?.completion_tokens ?? null,
              errorMessage: null,
            })
          }
          slot.onProgress?.({
            kind: 'delivered',
            promptTokens: payload.openaiResponse.usage?.prompt_tokens ?? null,
            completionTokens: payload.openaiResponse.usage?.completion_tokens ?? null,
          })
          slot.resolve(payload.openaiResponse)
        } catch (err) {
          slot.reject(err)
        } finally {
          pending.delete(body.jobId)
          jobMeta.delete(body.jobId)
          clearFailureTimers(body.jobId)
        }
      }
    },
  })

  /** Pick a provider, waiting up to `T4T_PROVIDER_WAIT_SECONDS` for one to
   *  free a slot if every match for `modelId` is currently at its advertised
   *  `maxConcurrentJobs`. Re-polls the registry every
   *  `T4T_PROVIDER_WAIT_POLL_SECONDS`; emits `waiting_for_capacity` progress
   *  events so the SSE client sees what's happening. */
  async function selectWithCapacityWait(
    modelId: string,
    onProgress?: (e: ProgressEvent) => void,
  ): Promise<CandidateProvider> {
    const startedAt = Date.now()
    const ctx = {
      modelId,
      maxPrice: cfg.T4T_MAX_PRICE_PER_MILLION_TOKENS,
      manualProvider: cfg.T4T_MANUAL_PROVIDER,
    }
    while (true) {
      const {chosen, matches, busy} = await selectProviderWithDetail(
        chain,
        cfg.T4T_SELECTION_STRATEGY,
        ctx,
      )
      if (chosen) return chosen
      const waitedSeconds = Math.floor((Date.now() - startedAt) / 1000)
      // No match at all → no point waiting. The registry isn't going to
      // sprout a new provider mid-request.
      if (matches.length === 0) {
        throw new Error(`no provider matches model=${modelId}`)
      }
      // All matches are at capacity. Wait if the operator allows it.
      if (waitedSeconds >= cfg.T4T_PROVIDER_WAIT_SECONDS) {
        throw new Error(
          `all ${busy.length} provider(s) for model=${modelId} are at capacity ` +
            `(waited ${waitedSeconds}s, limit ${cfg.T4T_PROVIDER_WAIT_SECONDS}s)`,
        )
      }
      onProgress?.({
        kind: 'waiting_for_capacity',
        modelId,
        busyProviders: busy.length,
        waitedSeconds,
      })
      log.info(
        {modelId, busyProviders: busy.length, waitedSeconds, totalBudget: cfg.T4T_PROVIDER_WAIT_SECONDS},
        'all matching providers at capacity; waiting for a free slot',
      )
      await new Promise(resolve => setTimeout(resolve, cfg.T4T_PROVIDER_WAIT_POLL_SECONDS * 1000))
    }
  }

  async function handleChat(
    req: OpenAIChatRequest,
    onProgress?: (e: ProgressEvent) => void,
  ): Promise<OpenAIChatResponse> {
    onProgress?.({kind: 'selecting_provider', modelId: req.model})
    const target = await selectWithCapacityWait(req.model, onProgress)
    onProgress?.({kind: 'provider_selected', provider: target.provider.owner, modelId: req.model})

    // Size the escrow off the actual prompt (estimated chars/4) and either the
    // requested `max_tokens` or `T4T_DEFAULT_MAX_OUTPUT_TOKENS`, padded by
    // T4T_ESCROW_HEADROOM_RATIO. The provider only claims the actual usage —
    // unused budget is refunded by the contract. Throws EscrowCapExceededError
    // when T4T_MAX_ESCROW_PER_JOB is set and the request would breach it.
    const {maxPayment} = computeMaxPayment(req, target.offering, {
      defaultMaxOutputTokens: cfg.T4T_DEFAULT_MAX_OUTPUT_TOKENS,
      headroomPpm: BigInt(Math.round(cfg.T4T_ESCROW_HEADROOM_RATIO * 1_000_000)),
      maxEscrowPerJob: cfg.T4T_MAX_ESCROW_PER_JOB ?? null,
    })
    await ensureAllowance(chain, cfg.ESCROW_ADDRESS, maxPayment)

    const jobIdLocal = toHex(crypto.getRandomValues(new Uint8Array(32)))

    const reqPayload: RequestPayload = {
      v: PROTOCOL_VERSION,
      jobId: jobIdLocal,
      client: chain.address,
      modelId: req.model,
      openaiRequest: req,
      clientPssPubKey: pssKeys.publicKeyX,
      ts: Math.floor(Date.now() / 1000),
    }
    const encrypted = await jsonEncrypt(cipher, target.provider.pssPublicKey, reqPayload)
    log.info({postageBatchId, bytes: encrypted.length, provider: target.provider.owner, model: req.model}, 'uploading request to swarm')
    let requestHash: string
    try {
      requestHash = await uploadChunk(
        {bee, postageBatchId, logger: log},
        encrypted,
      )
    } catch (err) {
      const e = err as {status?: number; responseBody?: unknown; url?: string; config?: {url?: string}; message?: string}
      log.error({
        postageBatchId,
        beeStatus: e?.status,
        beeResponseBody: e?.responseBody,
        beeUrl: e?.url ?? e?.config?.url,
        errMessage: e?.message,
      }, 'swarm upload of request failed — check the gateway Bee node postage batch')
      throw err
    }

    const deliveryDeadline = Math.floor(Date.now() / 1000) + cfg.T4T_DEFAULT_DEADLINE_SECONDS
    onProgress?.({kind: 'posting_job', provider: target.provider.owner, maxPayment: maxPayment.toString()})
    const {txHash, jobId: onChainJobId} = await postJob(chain, {
      provider: target.provider.owner,
      requestHash: ('0x' + requestHash) as Hex,
      modelId: req.model,
      maxPayment,
      deliveryDeadline,
    })
    log.info({txHash, onChainJobId, provider: target.provider.owner}, 'job posted on-chain')
    onProgress?.({kind: 'job_posted', txHash, onChainJobId})

    // The PSS notify carries `requestHash`-derived id; the provider matches
    // it to the chain via its JobPostedIndex. We keep the on-chain id alongside
    // so we can call cancelJob/timeoutJob on liveness failure.
    const jobIdRouting = keccak256(toBytes('0x' + requestHash))

    const promptText = req.messages.map(m => `${m.role}: ${contentToText(m.content)}`).join('\n')
    db.recordGatewayJob({
      jobId: jobIdRouting,
      onChainJobId,
      provider: target.provider.owner,
      modelId: req.model,
      status: 'posted',
      maxPayment: maxPayment.toString(),
      actualPayment: null,
      postedAt: Math.floor(Date.now() / 1000),
      ackedAt: null,
      deliveredAt: null,
      claimedAt: null,
      prompt: cfg.T4T_PERSIST_PAYLOADS ? promptText : '[redacted]',
      response: null,
      promptTokens: null,
      completionTokens: null,
      errorMessage: null,
    })
    jobMeta.set(jobIdRouting, {provider: target.provider.owner, modelId: req.model})

    const settled = new Promise<OpenAIChatResponse>((resolve, reject) => {
      pending.set(jobIdRouting, {resolve, reject, onProgress})
    })

    const cancelTimer = setTimeout(() => {
      onAckTimeout(jobIdRouting).catch(err =>
        log.error({err, routing: jobIdRouting}, 'onAckTimeout threw'),
      )
    }, (ACK_WINDOW_SECONDS + FAILURE_GRACE_SECONDS) * 1000)
    failureTimers.set(jobIdRouting, {onChainJobId, deliveryDeadline, cancelTimer})

    // Out-of-band notify so providers can start work before they observe the
    // chain event. The on-chain `JobPosted` is the source of truth for payment.
    onProgress?.({kind: 'notifying_provider', provider: target.provider.owner})
    const env = await signEnvelope<JobNotifyBody>(
      {
        from: chain.address,
        to: target.provider.owner,
        type: 'job_notify',
        body: {
          jobId: jobIdRouting,
          requestHash,
          modelId: req.model,
          maxPayment: maxPayment.toString(),
          deliveryDeadline,
          clientPssPubKey: pssKeys.publicKeyX,
          clientSwarmOverlay: selfOverlay,
        },
      },
      msg => chain.wallet.signMessage({account: chain.wallet.account!, message: msg}),
    )
    try {
      await pss.send({
        topic: providerTopic(target.provider.owner),
        recipientOverlay: target.provider.swarmOverlay,
        recipientPssKey: target.provider.pssPublicKey,
        envelope: env,
      })
    } catch (err) {
      // If we never managed to PSS-notify the provider, the orphaned `settled`
      // promise would later be rejected by the ACK-timeout timer and crash the
      // process (unhandledRejection). Drop the pending state synchronously so
      // the timer becomes a no-op, then surface the error to the HTTP layer.
      pending.delete(jobIdRouting)
      jobMeta.delete(jobIdRouting)
      clearFailureTimers(jobIdRouting)
      throw err
    }

    return settled
  }

  const discovery = new ModelDiscovery({
    chain,
    allowedModels: cfg.T4T_ALLOWED_MODELS,
    minProvidersPerModel: cfg.T4T_MIN_PROVIDERS_PER_MODEL,
    cacheTtlSeconds: cfg.T4T_MODELS_CACHE_TTL_SECONDS,
  })

  async function listModels() {
    const summaries = await discovery.list()
    const created = Math.floor(Date.now() / 1000)
    return summaries.map(m => ({id: m.id, object: 'model' as const, created, owned_by: 't4t'}))
  }

  startAdminServer({
    host: cfg.T4T_ADMIN_HOST,
    port: cfg.T4T_ADMIN_PORT,
    statusRefreshSeconds: cfg.T4T_STATUS_REFRESH_SECONDS,
    payloadsPersisted: cfg.T4T_PERSIST_PAYLOADS,
    fakeStreaming: cfg.T4T_FAKE_STREAMING,
    handleChat,
    listModels,
    db,
    chain,
    bee,
    postageBatchId,
    stampManaged: managed !== null && cfg.T4T_STAMP_MANAGE,
    stampDryRun: cfg.T4T_STAMP_DRY_RUN,
    stampTtlDays: cfg.T4T_STAMP_TTL_DAYS,
    discovery,
    pendingCount: () => pending.size,
    logger: log,
  })
}
