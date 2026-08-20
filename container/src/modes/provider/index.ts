import {Bee} from '@ethersphere/bee-js'
import {join} from 'node:path'
import type {ProviderConfig} from '../../lib/config'
import {walletKeyFilePath} from '../../lib/config'
import {startOnboardingServer, isZeroAddress} from '../../lib/onboarding'
import {discoverUsableBatchId} from '../../lib/swarm'
import {ensureManagedStamp, hasReusableLabeledBatch, topUpIfBelow, type ManagedStamp} from '../../lib/stamps'
import {readPersistedBatch, writePersistedBatch} from '../../lib/postage-state'
import {privateKeyToAccount} from 'viem/accounts'
import {
  claimJob,
  JOB_STATUS_CLAIMED,
  deactivateProvider,
  getOfferings,
  ackJob,
  getProvider,
  makeChain,
  readJob,
  readMinStake,
  readXbzzBalance,
  registerProvider,
  sendHeartbeat,
  setMaxConcurrentJobs,
  updateOfferings,
  ensureAllowance,
} from '../../lib/chain'
import {logger} from '../../lib/logger'
import {PssTransport} from '../../lib/swarm'
import {providerTopic} from '../../lib/envelope'
import {EciesCipher} from '../../lib/crypto'
import {JobPostedIndex} from '../../lib/job-index'
import {JobsDb} from '../../lib/jobs-db'
import {InferenceClient, InferenceRouter} from '../../lib/inference'
import {
  EndpointsFileError,
  endpointsFilePath,
  loadEndpoints,
  setDeclaredPrice,
  writeEndpoints,
  type InferenceEndpoint,
} from '../../lib/endpoints'
import {parseBzzToPlur} from '../../lib/admin-html'
import {loadOrCreatePssKey} from '../../lib/keys'
import type {Hex, ModelOffering} from '../../lib/types'
import {startAdminServer} from './admin'
import {processJob, type WorkerProgress} from './worker'
import {JobQueue, isJobNotify} from './listener'

// xBZZ has 16 decimals on Gnosis (NOT 18). MIN_STAKE in ProviderRegistry is
// `100 * 1e16` — 100 BZZ. Mismatch here used to silently produce a 10,000-BZZ
// stake request that crashed the container on transferFrom.
const PROVIDER_INITIAL_STAKE = 100n * 10n ** 16n // 100 xBZZ

export async function startProvider(cfg: ProviderConfig): Promise<void> {
  const log = logger.child({mode: 'provider'})

  // Onboarding-only mode covers two pre-flight states:
  //   1) no wallet yet → show create/import UI
  //   2) wallet exists but protocol addresses are still placeholder zeros →
  //      show "configure addresses" UI (won't try chain calls and crash-loop).
  const contractsMissing =
    isZeroAddress(cfg.REGISTRY_ADDRESS) ||
    isZeroAddress(cfg.ESCROW_ADDRESS) ||
    isZeroAddress(cfg.XBZZ_ADDRESS)
  const onboardingBase = {
    role: 'provider' as const,
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
  //      T4T_STAMP_LABEL changes (treated as an explicit re-resolve signal)
  //      or when the persisted batch is no longer usable on Bee.
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

  // Background TTL-watch: runs whenever managed mode is on, regardless of how
  // we resolved the batch (newly bought, persisted, or discovered).
  if (autoManage) {
    const tickMs = cfg.T4T_HEARTBEAT_INTERVAL_SECONDS * 1000
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
    }, tickMs).unref()
  }

  const chain = makeChain({
    rpcUrl: cfg.GNOSIS_RPC_URL,
    privateKey: cfg.walletKey,
    registry: cfg.REGISTRY_ADDRESS,
    escrow: cfg.ESCROW_ADDRESS,
    xbzz: cfg.XBZZ_ADDRESS,
  })

  // Open the db here (before any chain write) so register/allowance/heartbeat
  // txs all flow into the `transactions` table.
  const db = new JobsDb({path: join(cfg.T4T_DATA_DIR, 'jobs.db')})
  chain.onTx = e => db.recordTx({hash: e.hash, kind: e.kind, fromAddress: chain.address, toAddress: e.toAddress, note: e.note ?? null})

  const pssKeyPath = cfg.T4T_PSS_KEY_PATH ?? join(cfg.T4T_DATA_DIR, 'pss.key')
  const pssKeys = loadOrCreatePssKey(pssKeyPath)
  log.info({pssKeyPath, pssPubKeyX: pssKeys.publicKeyX}, 'PSS keypair loaded')

  // First-run register. Idempotent: we read state, then write if missing.
  const existing = await getProvider(chain, chain.address)
  if (!existing.owner || existing.owner === '0x0000000000000000000000000000000000000000') {
    // Pre-flight balance check — we'd otherwise crash on transferFrom with an
    // opaque revert. The contract's MIN_STAKE is the source of truth so we read
    // it instead of trusting our local constant.
    const minStake = await readMinStake(chain).catch(() => PROVIDER_INITIAL_STAKE)
    const balance = await readXbzzBalance(chain, chain.address).catch(() => 0n)
    if (balance < minStake) {
      log.warn(
        {address: chain.address, balance: balance.toString(), required: minStake.toString()},
        'wallet under-funded for provider registration — entering onboarding',
      )
      startOnboardingServer({
        ...onboardingBase,
        funding: {required: minStake, current: balance},
        // Auto-restart once the wallet is funded — no manual `docker compose restart`.
        recheck: async () => (await readXbzzBalance(chain, chain.address)) >= minStake,
      })
      return
    }
    await ensureAllowance(chain, cfg.REGISTRY_ADDRESS, PROVIDER_INITIAL_STAKE)
    const overlay = (await bee.getNodeAddresses().catch(() => null))?.overlay ?? '0x' + '00'.repeat(32)
    await registerProvider(chain, {
      pssPublicKey: pssKeys.publicKeyX,
      swarmOverlay: ('0x' + overlay.toString().replace(/^0x/, '')) as Hex,
      metadataURI: '',
      initialStake: PROVIDER_INITIAL_STAKE,
    })
    log.info('registered on-chain')
  } else if (!existing.active) {
    // Registered but deactivated. `isLive()` is false, so gateways will never
    // route to us — and ProviderRegistry has no reactivate path, so heartbeats
    // won't bring us back. Nothing the container can do about it, but silently
    // heartbeating into the void is worse than saying so.
    log.error(
      {address: chain.address, stake: existing.stake.toString()},
      'provider is registered but INACTIVE on-chain — deactivate() is irreversible in ' +
        'ProviderRegistry, so this wallet can no longer receive jobs. Withdraw the stake ' +
        'after the unbonding period and register from a fresh wallet.',
    )
  } else if (existing.pssPublicKey.toLowerCase() !== pssKeys.publicKeyX.toLowerCase()) {
    // The registry has a different PSS pubkey than what we just loaded from
    // disk. Clients fetch the on-chain key to encrypt requests, so they will
    // encrypt to a key we cannot decrypt — every incoming job will fail until
    // this is fixed (either deactivate + re-register, or restore the original
    // key file from backup). Log loudly and continue so the operator can act.
    log.error(
      {onChain: existing.pssPublicKey, local: pssKeys.publicKeyX},
      'on-chain PSS pubkey differs from local key file — incoming jobs will be undecryptable',
    )
  }

  // Publish concurrency cap so gateways can route around us when our local
  // queue is full. Re-fetch in case the registry was just populated by the
  // `register` call above. Only writes when the on-chain value differs to
  // skip a tx on every restart.
  try {
    const current = (await getProvider(chain, chain.address)).maxConcurrentJobs ?? 0
    if (Number(current) !== cfg.T4T_MAX_CONCURRENT_JOBS) {
      await setMaxConcurrentJobs(chain, cfg.T4T_MAX_CONCURRENT_JOBS)
      log.info(
        {previous: Number(current), cap: cfg.T4T_MAX_CONCURRENT_JOBS},
        'published maxConcurrentJobs on-chain',
      )
    }
  } catch (err) {
    log.warn({err}, 'failed to publish maxConcurrentJobs; gateways will treat us as uncapped')
  }

  let endpoints: InferenceEndpoint[]
  try {
    endpoints = loadEndpoints(cfg.T4T_DATA_DIR)
  } catch (err) {
    if (err instanceof EndpointsFileError) {
      log.fatal(
        {path: err.path},
        `${err.message} — example: [{"name":"ollama","url":"http://ollama:11434"},{"name":"openai","url":"https://api.openai.com","apiKey":"sk-..."}]`,
      )
    } else {
      log.fatal({err, path: endpointsFilePath(cfg.T4T_DATA_DIR)}, 'failed to load inference endpoints')
    }
    process.exit(1)
  }
  const inference = new InferenceRouter(
    endpoints.map(e => new InferenceClient(e.name, e.url, e.apiKey)),
    log,
  )
  log.info({endpoints: endpoints.map(e => ({name: e.name, url: e.url}))}, 'inference endpoints loaded')
  // Offerings = whatever the configured backends currently serve. To stop
  // offering a model, remove it from the backend (e.g. `ollama rm <model>`)
  // or drop the backend from endpoints.json and restart.
  const modelIds = await inference.listModels()
  if (modelIds.length === 0) {
    log.fatal(
      {endpoints: endpoints.map(e => e.name)},
      'no models reachable on any configured inference endpoint; cannot determine offerings',
    )
    process.exit(1)
  }
  // Merge precedence (high → low): endpoints.json declared price → on-chain
  // price (preserves prior UI edits) → env defaults. UI edits write the new
  // price back to endpoints.json on save, so prior edits survive a restart
  // even if the chain read fails.
  const onChainOfferings = await getOfferings(chain, chain.address).catch(() => [] as ModelOffering[])
  const existingByModel = new Map(onChainOfferings.map(o => [o.modelId, o]))
  function declaredPriceFor(exposedId: string): {inputPlur: bigint; outputPlur: bigint} | null {
    const route = inference.routeFor(exposedId)
    if (!route) return null
    const endpoint = endpoints.find(e => e.name === route.endpointName)
    const declared = endpoint?.models?.[route.backendModelId]
    if (!declared) return null
    try {
      return {inputPlur: parseBzzToPlur(declared.inputBzz), outputPlur: parseBzzToPlur(declared.outputBzz)}
    } catch (err) {
      log.warn({err, exposedId}, 'declared price in endpoints.json is invalid; ignoring')
      return null
    }
  }
  function resolveOffering(modelId: string): ModelOffering {
    const prior = existingByModel.get(modelId)
    const declared = declaredPriceFor(modelId)
    return {
      modelId,
      inputPricePerMillionTokens:
        declared?.inputPlur ?? prior?.inputPricePerMillionTokens ?? cfg.T4T_INPUT_PRICE_DEFAULT,
      outputPricePerMillionTokens:
        declared?.outputPlur ?? prior?.outputPricePerMillionTokens ?? cfg.T4T_OUTPUT_PRICE_DEFAULT,
      maxContextTokens: prior?.maxContextTokens ?? 0n,
      maxLatencySeconds: prior?.maxLatencySeconds ?? 120n,
    }
  }
  // Probe-filter at startup too: `inference.listModels()` returns whatever the
  // backends advertise on `/v1/models`, but Groq (and similar) lists STT/TTS
  // models like whisper / orpheus that 400 on /v1/chat/completions. If we
  // published the raw list, on-chain would show e.g. `whisper-large-v3` until
  // the first healthTick filtered it out, and the gateway's /models page would
  // surface a broken model in the meantime. Probing here costs ~one /v1/chat
  // round-trip per model on cold start — acceptable.
  const liveModelIds: string[] = []
  for (const id of modelIds) {
    try {
      await inference.probeModel(id)
      liveModelIds.push(id)
    } catch (err) {
      log.warn({err, model: id}, 'startup probe failed; excluding from initial offerings')
    }
  }
  if (liveModelIds.length === 0) {
    log.fatal(
      {endpoints: endpoints.map(e => e.name), discovered: modelIds.length},
      'no models survived startup probe; cannot publish offerings',
    )
    process.exit(1)
  }
  const offeringsByModel = new Map<string, ModelOffering>()
  for (const modelId of liveModelIds) offeringsByModel.set(modelId, resolveOffering(modelId))

  // Reflects the live offerings map back into endpoints.json so the file is
  // always a complete inventory of what the provider serves — even for models
  // first discovered from `/v1/models` with env-default prices. No-op when the
  // file already matches.
  function syncEndpointsFile(): void {
    let dirty = false
    for (const [exposedId, offering] of offeringsByModel) {
      const route = inference.routeFor(exposedId)
      if (!route) continue
      const endpoint = endpoints.find(e => e.name === route.endpointName)
      if (!endpoint) continue
      if (
        setDeclaredPrice(
          endpoint,
          route.backendModelId,
          offering.inputPricePerMillionTokens,
          offering.outputPricePerMillionTokens,
        )
      ) {
        dirty = true
      }
    }
    if (!dirty) return
    try {
      writeEndpoints(cfg.T4T_DATA_DIR, endpoints)
      log.info('endpoints.json synced with current offerings')
    } catch (err) {
      log.warn({err}, 'failed to sync endpoints.json with current offerings')
    }
  }

  // First-run sync: writes any newly-discovered models (with their resolved
  // prices) into the file so operators can see everything in one place.
  syncEndpointsFile()

  async function publishOfferings(): Promise<void> {
    const arr = [...offeringsByModel.values()]
    if (arr.length === 0) {
      log.warn(
        {endpoints: endpoints.map(e => e.name)},
        'no models reachable on any configured endpoint — provider will not receive jobs until at least one model is loaded',
      )
      return
    }
    await updateOfferings(chain, arr)
    log.info({count: arr.length, models: arr.map(o => o.modelId)}, 'offerings published')
  }

  // Publish only if the merged set differs from on-chain — avoids gas on a noop restart.
  const sameAsChain =
    onChainOfferings.length === offeringsByModel.size &&
    onChainOfferings.every(o => {
      const cur = offeringsByModel.get(o.modelId)
      return (
        cur &&
        cur.inputPricePerMillionTokens === o.inputPricePerMillionTokens &&
        cur.outputPricePerMillionTokens === o.outputPricePerMillionTokens
      )
    })
  if (!sameAsChain) await publishOfferings()
  else log.info({count: offeringsByModel.size}, 'offerings already match on-chain; skip publish')

  function buildOffering(modelId: string): ModelOffering {
    // The in-memory offerings map carries prior UI edits — prefer it over a
    // fresh resolve so heartbeat ticks don't undo an unsaved declared-price
    // override. New models that appeared after startup fall through to the
    // resolver and pick up JSON declarations / on-chain / defaults.
    const cached = offeringsByModel.get(modelId)
    if (cached) return cached
    return resolveOffering(modelId)
  }

  function offeringsDiffer(next: Map<string, ModelOffering>): boolean {
    if (next.size !== offeringsByModel.size) return true
    for (const [id, n] of next) {
      const cur = offeringsByModel.get(id)
      if (!cur) return true
      if (cur.inputPricePerMillionTokens !== n.inputPricePerMillionTokens) return true
      if (cur.outputPricePerMillionTokens !== n.outputPricePerMillionTokens) return true
    }
    return false
  }

  async function healthTick(): Promise<void> {
    // 1. Backend reachable?
    let modelIds: string[]
    try {
      modelIds = await inference.listModels()
    } catch (err) {
      log.warn({err}, 'skip heartbeat — backend listModels failed; on-chain liveness will lapse')
      return
    }

    // 2. Probe each model the backend claims to serve. A model that fails the
    //    probe is dropped from offerings this round; clients won't route to it.
    const live: string[] = []
    for (const id of modelIds) {
      try {
        await inference.probeModel(id)
        live.push(id)
      } catch (err) {
        log.warn({err, model: id}, 'model probe failed; dropping from offerings')
      }
    }
    if (live.length === 0) {
      log.warn('no models survived probe — skip heartbeat')
      return
    }

    // 3. Sync the on-chain offering set with what's actually live.
    const next = new Map<string, ModelOffering>()
    for (const id of live) next.set(id, buildOffering(id))
    if (offeringsDiffer(next)) {
      try {
        await updateOfferings(chain, [...next.values()])
        offeringsByModel.clear()
        for (const [k, v] of next) offeringsByModel.set(k, v)
        log.info({models: [...offeringsByModel.keys()]}, 'offerings re-published after backend change')
        syncEndpointsFile()
      } catch (err) {
        log.warn({err}, 'updateOfferings failed; keeping previous on-chain set')
      }
    }

    // 4. Heartbeat — only now do we tell the chain we're alive.
    try {
      await sendHeartbeat(chain)
    } catch (err) {
      log.warn({err}, 'heartbeat failed')
    }
  }

  // Fire one tick immediately so a newly-started (or just-restarted) provider
  // gets its on-chain liveness refreshed without waiting up to 5 minutes.
  healthTick().catch(err => log.warn({err}, 'initial health tick failed'))
  setInterval(() => {
    healthTick().catch(err => log.warn({err}, 'health tick crashed'))
  }, cfg.T4T_HEARTBEAT_INTERVAL_SECONDS * 1000)

  const cipher = new EciesCipher(pssKeys.privateKey)
  const pss = new PssTransport({
    bee,
    postageBatchId,
    logger: log,
    selfAddress: chain.address,
  })
  const queue = new JobQueue(cfg.T4T_MAX_CONCURRENT_JOBS)
  const jobIndex = new JobPostedIndex(chain, chain.address, log)
  jobIndex.start()
  const signMessage = async (msg: string) =>
    (await chain.wallet.signMessage({account: chain.wallet.account!, message: msg})) as Hex

  function persistProgress(p: WorkerProgress): void {
    const status = p.stage === 'acked' ? 'running' : p.stage === 'inferred' ? 'running' : 'delivered'
    db.recordProviderJob({
      jobId: p.jobIdRouting,
      client: p.client,
      modelId: p.modelId,
      status,
      receivedAt: p.timestamp, // overridden by COALESCE on upsert
      ackedAt: p.stage === 'acked' ? p.timestamp : null,
      completedAt: p.stage === 'delivered' ? p.timestamp : null,
      claimedAt: null,
      promptTokens: p.promptTokens ?? null,
      completionTokens: p.completionTokens ?? null,
      earnedXBZZ: null,
      errorMessage: null,
    })
  }

  /**
   * Routing ids already taken up this process.
   *
   * PSS is best-effort and redelivers: the same job_notify can arrive twice,
   * and without this the whole pipeline reran — a second inference on the same
   * prompt, then a second claimJob that reverted BadStatus because the first
   * had already claimed. Seen live: one job claimed for 2901000000000 and a
   * duplicate attempting 7881000000000, recorded as "failed" on a job that had
   * in fact succeeded and been paid.
   *
   * Never deleted. A routing id is claimed at most once for the life of this
   * process, which is exactly the guarantee wanted — re-running a finished job
   * has no upside, and the GPU time is the expensive part.
   */
  const seenNotifies = new Set<string>()

  pss.subscribe({
    topic: providerTopic(chain.address),
    onEnvelope: async env => {
      if (!isJobNotify(env)) return
      if (seenNotifies.has(env.body.jobId)) {
        log.info({jobId: env.body.jobId}, 'duplicate job_notify ignored')
        return
      }
      seenNotifies.add(env.body.jobId)
      if (!queue.tryAcquire()) {
        log.warn({inFlight: queue.inFlight}, 'queue full; dropping notify')
        return
      }
      const jobIdRouting = env.body.jobId
      db.recordProviderJob({
        jobId: jobIdRouting,
        client: env.from,
        modelId: env.body.modelId,
        status: 'queued',
        receivedAt: Math.floor(Date.now() / 1000),
        ackedAt: null,
        completedAt: null,
        claimedAt: null,
        promptTokens: null,
        completionTokens: null,
        earnedXBZZ: null,
        errorMessage: null,
      })
      try {
        await processJob(
          {
            bee,
            postageBatchId,
            pss,
            inference,
            cipher,
            selfAddress: chain.address,
            signMessage,
            pricingFor: (modelId: string) => {
              const o = offeringsByModel.get(modelId)
              if (!o) return null
              return {
                inputPricePerMillionTokens: o.inputPricePerMillionTokens,
                outputPricePerMillionTokens: o.outputPricePerMillionTokens,
              }
            },
            resolveOnChainJob: routing => waitForOnChainJobId(jobIndex, routing),
            ackOnChain: async onChainJobId => { await ackJob(chain, onChainJobId) },
            onChainStatus: async onChainJobId => (await readJob(chain, onChainJobId)).status,
            onDelivered: async ({onChainJobId, responseHash, promptTokens, completionTokens}) => {
              const o = offeringsByModel.get(env.body.modelId)
              const inPrice = o?.inputPricePerMillionTokens ?? cfg.T4T_INPUT_PRICE_DEFAULT
              const outPrice = o?.outputPricePerMillionTokens ?? cfg.T4T_OUTPUT_PRICE_DEFAULT
              const actual =
                (inPrice * BigInt(promptTokens) + outPrice * BigInt(completionTokens)) /
                1_000_000n
              // Belt to the suspenders from the in-worker max_tokens cap:
              // a backend that ignored max_tokens (some don't) can still
              // overshoot. Re-read the on-chain maxPayment so the gateway
              // can't trick us via a tampered notify, then clip — we'd
              // rather collect maxPayment than revert with PaymentTooHigh
              // and get slashed at the delivery deadline.
              const onChain = await readJob(chain, onChainJobId).catch(err => {
                log.warn({err, onChainJobId}, 'readJob failed; falling back to notify.maxPayment')
                return null
              })
              const ceiling = onChain?.maxPayment ?? BigInt(env.body.maxPayment)
              const clipped = actual > ceiling ? ceiling : actual
              if (clipped !== actual) {
                log.warn(
                  {onChainJobId, actual: actual.toString(), ceiling: ceiling.toString()},
                  'clipping actualPayment to on-chain maxPayment to avoid PaymentTooHigh',
                )
              }
              try {
                await claimJob(chain, {
                  jobId: onChainJobId,
                  responseHash: ('0x' + responseHash) as Hex,
                  actualPayment: clipped,
                })
                log.info({onChainJobId, actual: clipped.toString()}, 'claim submitted')
              } catch (err) {
                // BadStatus here is ambiguous: the job may already be Claimed
                // (this work landed, and something is retrying) or Cancelled
                // (it did not). Only the chain can tell them apart, and the
                // difference decides whether this is a success or a loss —
                // reporting a paid job as failed is what sent us looking for a
                // bug that was not there.
                const after = await readJob(chain, onChainJobId).catch(() => null)
                if (after?.status === JOB_STATUS_CLAIMED) {
                  log.info(
                    {onChainJobId},
                    'claim already recorded on-chain — treating as success',
                  )
                } else {
                  throw err
                }
              }
              db.recordProviderJob({
                jobId: jobIdRouting,
                client: env.from,
                modelId: env.body.modelId,
                status: 'claimed',
                receivedAt: 0,
                ackedAt: null,
                completedAt: null,
                claimedAt: Math.floor(Date.now() / 1000),
                promptTokens: null,
                completionTokens: null,
                earnedXBZZ: clipped.toString(),
                errorMessage: null,
              })
            },
            onProgress: persistProgress,
            logger: log,
          },
          env,
        )
      } catch (err) {
        log.error({err}, 'job failed')
        db.recordProviderJob({
          jobId: jobIdRouting,
          client: env.from,
          modelId: env.body.modelId,
          status: 'failed',
          receivedAt: 0,
          ackedAt: null,
          completedAt: null,
          claimedAt: null,
          promptTokens: null,
          completionTokens: null,
          earnedXBZZ: null,
          errorMessage: String((err as Error)?.message ?? err),
        })
      } finally {
        queue.release()
      }
    },
  })

  startAdminServer({
    host: cfg.T4T_ADMIN_HOST,
    port: cfg.T4T_ADMIN_PORT,
    statusRefreshSeconds: cfg.T4T_STATUS_REFRESH_SECONDS,
    db,
    chain,
    bee,
    postageBatchId,
    stampManaged: managed !== null && cfg.T4T_STAMP_MANAGE,
    stampDryRun: cfg.T4T_STAMP_DRY_RUN,
    stampTtlDays: cfg.T4T_STAMP_TTL_DAYS,
    queue,
    logger: log,
    offerings: offeringsByModel,
    publishOfferings,
    endpoints,
    dataDir: cfg.T4T_DATA_DIR,
    router: inference,
  })

  if (cfg.T4T_DEACTIVATE_ON_SHUTDOWN) {
    let shuttingDown = false
    const onSignal = (sig: NodeJS.Signals) => {
      if (shuttingDown) return
      shuttingDown = true
      log.info({sig}, 'signal received — deactivating before exit')
      deactivateProvider(chain)
        .then(tx => log.info({tx}, 'deactivate tx sent'))
        .catch(err => log.error({err}, 'deactivate on shutdown failed'))
        .finally(() => process.exit(0))
    }
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)
  }

  log.info({offerings: offeringsByModel.size, concurrency: cfg.T4T_MAX_CONCURRENT_JOBS}, 'provider ready')
}

/**
 * Polls the JobPostedIndex briefly for the routing-id match. The PSS notify
 * may arrive before the chain event, so we give the indexer a short window
 * to catch up rather than dropping the claim outright.
 */
async function waitForOnChainJobId(
  index: JobPostedIndex,
  routingId: Hex,
  timeoutMs = 15_000,
  pollMs = 500,
): Promise<Hex | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = index.get(routingId)
    if (hit) return hit
    await new Promise(r => setTimeout(r, pollMs))
  }
  return null
}

