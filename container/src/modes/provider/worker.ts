import {keccak256, toBytes} from 'viem'
import {jsonDecrypt, jsonEncrypt, type PayloadCipher} from '../../lib/crypto'
import type {Logger} from '../../lib/logger'
import {InferenceRouter} from '../../lib/inference'
import type {PssTransport} from '../../lib/swarm'
import {downloadChunk, uploadChunk} from '../../lib/swarm'
import {estimatePromptTokens, maxAffordableCompletionTokens} from '../../lib/token-budget'
import {JOB_STATUS_ACKED, JOB_STATUS_PENDING} from '../../lib/chain'
import type {Bee} from '@ethersphere/bee-js'
import type {
  Hex,
  JobAckBody,
  JobDeliverBody,
  JobNotifyBody,
  OpenAIChatRequest,
  RequestPayload,
  ResponsePayload,
} from '../../lib/types'
import {clientTopic, signEnvelope} from '../../lib/envelope'
import type {Envelope} from '../../lib/types'

export type WorkerStage = 'acked' | 'inferred' | 'delivered'

export interface WorkerProgress {
  stage: WorkerStage
  jobIdRouting: Hex
  client: Hex
  modelId: string
  promptTokens?: number
  completionTokens?: number
  responseHash?: string
  timestamp: number
}

export interface WorkerDeps {
  bee: Bee
  postageBatchId: string
  pss: PssTransport
  inference: InferenceRouter
  cipher: PayloadCipher
  selfAddress: Hex
  signMessage: (msg: string) => Promise<Hex>
  /** Resolve the routing id to the on-chain jobId, waiting briefly for the
   *  chain event to land. Returning null means no `JobPosted` naming us as
   *  provider carries this requestHash — the notify is unbacked and the job
   *  must not be worked. */
  resolveOnChainJob: (jobIdRouting: Hex) => Promise<Hex | null>
  /**
   * Acknowledge the job ON-CHAIN, once it is verified real.
   *
   * The PSS ack above is best-effort: it travels over Swarm, and when it
   * arrives late the client is entitled to cancelJob, which slashes us
   * MIN_SLASH (1 xBZZ) and leaves the finished work unclaimable with
   * BadStatus. Measured on the live gateway: 35 jobs posted, 0 acked
   * on-chain, and roughly a third cancelled that way.
   *
   * ackJob moves the job to Acked, and cancelJob requires Pending — so the
   * slash becomes impossible rather than unlikely, and the provider gets the
   * full deliveryDeadline instead of a 30-second window. Optional so the
   * worker stays usable in tests without a chain.
   */
  ackOnChain?: (onChainJobId: Hex) => Promise<void>
  /**
   * Current on-chain status, used to refuse work that is already resolved.
   *
   * The in-memory dedupe in the listener only spans one process, so a notify
   * redelivered across a restart would rerun the inference. The chain does not
   * forget: a job that is Claimed, Cancelled or TimedOut has nothing left to
   * do, whatever this process remembers.
   *
   * Deliberately NOT a "have I seen this before" flag in our own database.
   * A crash mid-job leaves a row behind, and skipping on that would turn a job
   * that is still Pending and still claimable into a guaranteed slash. Asking
   * what the chain thinks distinguishes "already finished" from "interrupted
   * and worth resuming"; a local marker cannot.
   */
  onChainStatus?: (onChainJobId: Hex) => Promise<number | null>
  /** Called once the response is uploaded so the listener can submit claimJob. */
  onDelivered: (args: {
    jobIdRouting: Hex
    onChainJobId: Hex
    responseHash: string
    promptTokens: number
    completionTokens: number
  }) => Promise<void>
  /** Optional persistence hook called at each lifecycle stage. */
  onProgress?: (p: WorkerProgress) => void
  /** Resolve per-model pricing so the worker can cap `max_tokens` to whatever
   *  the on-chain `maxPayment` actually pays for. Returning null disables the
   *  cap for that model (e.g. when prices aren't known locally). */
  pricingFor: (modelId: string) => {
    inputPricePerMillionTokens: bigint
    outputPricePerMillionTokens: bigint
  } | null
  logger: Logger
}

const PROTOCOL_VERSION = 1 as const

/**
 * Deliver a signed envelope back to the gateway. Prefers the gateway-supplied
 * HTTPS `clientReplyUrl` when present (hosted-gateway path — Bee 2.8's reverse
 * push-routing is unreliable across NAT-asymmetric peers), and falls back to
 * PSS otherwise. The receiving side verifies the envelope signature either
 * way, so the trust model is unchanged.
 */
async function sendEnvelopeToClient(
  deps: WorkerDeps,
  replyUrl: string | undefined,
  args: {
    topic: string
    recipientOverlay: Hex
    recipientPssKey: Hex
    envelope: Envelope
    log: Logger
  },
): Promise<void> {
  if (replyUrl) {
    try {
      const res = await fetch(replyUrl, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(args.envelope),
      })
      if (res.ok) return
      const text = await res.text().catch(() => '')
      args.log.warn({status: res.status, replyUrl, body: text.slice(0, 200)}, 'replyUrl POST failed — falling back to PSS')
    } catch (err) {
      args.log.warn({err: (err as Error).message, replyUrl}, 'replyUrl POST threw — falling back to PSS')
    }
  }
  await deps.pss.send({
    topic: args.topic,
    recipientOverlay: args.recipientOverlay,
    recipientPssKey: args.recipientPssKey,
    envelope: args.envelope,
  })
}

/** Execute a single job end-to-end: fetch → infer → upload → notify. */
export async function processJob(deps: WorkerDeps, notify: Envelope<JobNotifyBody>): Promise<void> {
  const {body} = notify
  const log = deps.logger.child({jobId: body.jobId, model: body.modelId})
  const jobIdRouting = body.jobId as Hex

  // 1. ACK fast so the client doesn't tip into the no-ack slash path.
  const ackEnv = await signEnvelope<JobAckBody>(
    {
      from: deps.selfAddress,
      to: notify.from,
      type: 'job_ack',
      body: {jobId: body.jobId, estimatedCompletion: Math.floor(Date.now() / 1000) + 60},
    },
    deps.signMessage,
  )
  // The gateway advertises its PSS pubkey + Bee overlay in the signed
  // envelope. We don't look it up on-chain — gateways aren't registered in
  // ProviderRegistry, and the envelope signature already proves the gateway's
  // wallet authorized this routing info.
  const clientPeer = {
    pssPublicKey: body.clientPssPubKey,
    swarmOverlay: body.clientSwarmOverlay,
  }
  await sendEnvelopeToClient(deps, body.clientReplyUrl, {
    topic: clientTopic(notify.from),
    recipientOverlay: clientPeer.swarmOverlay,
    recipientPssKey: clientPeer.pssPublicKey,
    envelope: ackEnv,
    log,
  })
  log.info('acked')
  deps.onProgress?.({
    stage: 'acked',
    jobIdRouting,
    client: notify.from,
    modelId: body.modelId,
    timestamp: Math.floor(Date.now() / 1000),
  })

  // 2. Prove the job is real before spending any GPU on it.
  //
  // The notify is just a signed PSS message on a public topic — anyone can
  // send one, and the signature only proves it came from *some* wallet, not
  // that a paying job exists. A hit in the JobPosted index is the proof we
  // need: it is built from `JobPosted(provider = us)` logs and keyed by
  // `keccak256(jobs[jobId].requestHash)`, so a match means the chain really
  // does hold a job naming us as provider for exactly this request. Without
  // it we'd run the inference and only discover at claim time that there was
  // never anything to claim.
  //
  // We do this *after* the ACK so an honest client never trips the no-ack
  // slash path while we wait for the event to land.
  const onChainJobId = await deps.resolveOnChainJob(jobIdRouting)
  if (!onChainJobId) {
    throw new Error(
      `no on-chain JobPosted matches this notify (routing ${jobIdRouting}); refusing to run inference`,
    )
  }
  log.info({onChainJobId}, 'job verified on-chain')

  // 2a. Refuse work the chain has already resolved.
  //
  // Costs one read and saves a whole inference plus a claim that could only
  // revert. Pending and Acked are the two states with work outstanding;
  // anything else means this notify is a duplicate of something finished.
  if (deps.onChainStatus) {
    const st = await deps.onChainStatus(onChainJobId).catch(() => null)
    if (st != null && st !== JOB_STATUS_PENDING && st !== JOB_STATUS_ACKED) {
      log.info({onChainJobId, status: st}, 'job already resolved on-chain — ignoring redelivered notify')
      return
    }
  }

  // 2b. Ack on-chain, before spending any GPU.
  //
  // Deliberately here and not beside the PSS ack: acking requires the real
  // jobId, which step 2 just established. Doing it before inference is the
  // point — it closes the cancel window while the expensive part runs.
  //
  // Never fatal. A failed ack costs us the protection, not the job: the work
  // can still be claimed from Pending as long as the client does not cancel
  // first, which is exactly the behaviour we had before this existed.
  if (deps.ackOnChain) {
    try {
      await deps.ackOnChain(onChainJobId)
      log.info({onChainJobId}, 'acked on-chain — cancelJob can no longer slash this job')
    } catch (err) {
      log.warn({err, onChainJobId}, 'on-chain ack failed; continuing unprotected from cancelJob')
    }
  }

  // 3. Fetch + decrypt request.
  const ct = await downloadChunk({bee: deps.bee, postageBatchId: deps.postageBatchId, logger: log}, body.requestHash)
  const reqPayload = await jsonDecrypt<RequestPayload>(deps.cipher, ct)
  if (reqPayload.openaiRequest.model !== body.modelId) {
    throw new Error(`model mismatch: envelope=${body.modelId} payload=${reqPayload.openaiRequest.model}`)
  }

  // 4. Cap `max_tokens` to whatever the on-chain escrow actually pays for,
  //    then run inference. If the gateway under-sized the escrow we'd rather
  //    deliver a shorter answer than overshoot — the contract rejects claims
  //    above `maxPayment` (PaymentTooHigh), which would otherwise force the
  //    job to time out and slash the provider for an honest workload.
  const cappedRequest = capRequestToBudget(reqPayload.openaiRequest, body, deps, log)
  const openaiResponse = await deps.inference.chatCompletion(cappedRequest)
  log.info({completionTokens: openaiResponse.usage?.completion_tokens}, 'inference complete')
  deps.onProgress?.({
    stage: 'inferred',
    jobIdRouting,
    client: notify.from,
    modelId: body.modelId,
    promptTokens: openaiResponse.usage?.prompt_tokens,
    completionTokens: openaiResponse.usage?.completion_tokens,
    timestamp: Math.floor(Date.now() / 1000),
  })

  // 5. Upload encrypted response.
  const respPayload: ResponsePayload = {
    v: PROTOCOL_VERSION,
    jobId: body.jobId,
    provider: deps.selfAddress,
    openaiResponse,
    ts: Math.floor(Date.now() / 1000),
  }
  const respCipher = await jsonEncrypt(deps.cipher, clientPeer.pssPublicKey, respPayload)
  const responseHash = await uploadChunk({bee: deps.bee, postageBatchId: deps.postageBatchId, logger: log}, respCipher)

  // 6. Notify client via PSS.
  const deliverEnv = await signEnvelope<JobDeliverBody>(
    {
      from: deps.selfAddress,
      to: notify.from,
      type: 'job_deliver',
      body: {jobId: body.jobId, responseHash},
    },
    deps.signMessage,
  )
  await sendEnvelopeToClient(deps, body.clientReplyUrl, {
    topic: clientTopic(notify.from),
    recipientOverlay: clientPeer.swarmOverlay,
    recipientPssKey: clientPeer.pssPublicKey,
    envelope: deliverEnv,
    log,
  })
  log.info({responseHash}, 'delivered')
  deps.onProgress?.({
    stage: 'delivered',
    jobIdRouting,
    client: notify.from,
    modelId: body.modelId,
    promptTokens: openaiResponse.usage?.prompt_tokens,
    completionTokens: openaiResponse.usage?.completion_tokens,
    responseHash,
    timestamp: Math.floor(Date.now() / 1000),
  })

  // 7. Hand back to the listener for on-chain claim. `routingFromHash` is
  //    recomputed from the requestHash rather than trusted from the notify
  //    body, so a mismatched `jobId` can't redirect the claim.
  const routingFromHash = keccak256(toBytes('0x' + body.requestHash))
  await deps.onDelivered({
    jobIdRouting: routingFromHash,
    onChainJobId,
    responseHash,
    promptTokens: openaiResponse.usage?.prompt_tokens ?? 0,
    completionTokens: openaiResponse.usage?.completion_tokens ?? 0,
  })
}

/** Clamp the request's `max_tokens` to whatever the on-chain `maxPayment`
 *  pays for at the provider's declared prices. We over-estimate prompt
 *  tokens (chars/4 + per-message overhead via `estimatePromptTokens`) so the
 *  derived completion cap stays conservative — the contract's cost check is
 *  the hard wall and we want our claim to land below it on the first try. */
function capRequestToBudget(
  req: OpenAIChatRequest,
  notify: JobNotifyBody,
  deps: WorkerDeps,
  log: Logger,
): OpenAIChatRequest {
  const pricing = deps.pricingFor(notify.modelId)
  if (!pricing) return req
  const maxPayment = (() => {
    try {
      return BigInt(notify.maxPayment)
    } catch {
      return null
    }
  })()
  if (maxPayment === null || maxPayment <= 0n) return req

  const promptCeiling = estimatePromptTokens(req)
  const affordable = maxAffordableCompletionTokens({
    maxPayment,
    promptTokenCeiling: promptCeiling,
    inputPricePerMillionTokens: pricing.inputPricePerMillionTokens,
    outputPricePerMillionTokens: pricing.outputPricePerMillionTokens,
  })
  if (affordable < 0n) return req // unpriced — no derivable cap
  if (affordable === 0n) {
    // The escrow doesn't cover even one output token at the estimated prompt
    // size. Letting inference run would either return nothing or overshoot —
    // refuse so the job times out cleanly instead of producing garbage.
    throw new Error(
      `escrow too small to fit any output (prompt estimate ${promptCeiling} tokens, ` +
        `maxPayment ${maxPayment} wei xBZZ exhausted by prompt at declared prices)`,
    )
  }

  // BigInt → number is safe here: a single chat completion's max_tokens is
  // bounded by model context (≤ 2^20 in practice), well under MAX_SAFE_INTEGER.
  const cap = affordable > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(affordable)
  const requested = req.max_tokens
  if (requested != null && requested <= cap) return req
  if (requested != null) {
    log.warn(
      {requested, cap, maxPayment: maxPayment.toString(), promptCeiling: promptCeiling.toString()},
      'capping max_tokens to fit on-chain escrow budget',
    )
  } else {
    log.info(
      {cap, maxPayment: maxPayment.toString(), promptCeiling: promptCeiling.toString()},
      'request omitted max_tokens; setting cap from on-chain escrow budget',
    )
  }
  return {...req, max_tokens: cap}
}
