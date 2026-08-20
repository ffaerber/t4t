import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import {privateKeyToAccount} from 'viem/accounts'
import {gnosis, gnosisChiado} from 'viem/chains'
import {erc20Abi, jobEscrowAbi, providerRegistryAbi} from './abi'
import type {ModelOffering, ProviderRow} from './types'

/** Mirrors `JobEscrow.ACK_WINDOW` (spec §3). Used by the client to schedule
 *  the no-ack cancel deadline locally. Keep in sync with the contract. */
export const ACK_WINDOW_SECONDS = 30

/**
 * JobEscrow.JobStatus, as the enum is ordered on-chain:
 *   None, Pending, Acked, Delivered, Claimed, Cancelled, TimedOut
 *
 * Only the ones the provider reasons about are named. Note `Delivered` is
 * declared in the contract and set by nothing — there is no on-chain state for
 * "work submitted but not yet claimed", which is why an ack is the only thing
 * standing between finished work and a cancel.
 */
export const JOB_STATUS_PENDING = 1
export const JOB_STATUS_ACKED = 2
export const JOB_STATUS_CLAIMED = 4
export const JOB_STATUS_CANCELLED = 5

export interface TxEvent {
  kind: string
  hash: Hex
  toAddress: Address
  note?: string | null
}

export interface ChainClient {
  pub: PublicClient
  wallet: WalletClient
  address: Address
  registry: Address
  escrow: Address
  xbzz: Address
  /** Optional sink for every write tx after it's been submitted. Wired in by
   *  the provider/client startup to persist to `transactions` in jobs.db. */
  onTx?: (e: TxEvent) => void
}

export interface ChainOpts {
  rpcUrl: string
  privateKey: Hex
  registry: Address
  escrow: Address
  xbzz: Address
  chainId?: number
  onTx?: (e: TxEvent) => void
}

export function makeChain(opts: ChainOpts): ChainClient {
  const account = privateKeyToAccount(opts.privateKey)
  const chain = opts.chainId === 10200 ? gnosisChiado : gnosis
  const transport = http(opts.rpcUrl)
  return {
    pub: createPublicClient({chain, transport}),
    wallet: createWalletClient({chain, transport, account}),
    address: account.address,
    registry: opts.registry,
    escrow: opts.escrow,
    xbzz: opts.xbzz,
    onTx: opts.onTx,
  }
}

/** Notify the txLog sink. Swallow any error in the callback so a faulty DB
 *  write never takes down a chain operation. */
function emit(c: ChainClient, e: TxEvent): void {
  try {
    c.onTx?.(e)
  } catch {
    // intentionally ignored
  }
}

// ---------- ProviderRegistry ----------

export async function registerProvider(
  c: ChainClient,
  args: {
    pssPublicKey: Hex
    swarmOverlay: Hex
    metadataURI: string
    initialStake: bigint
  },
): Promise<Hex> {
  const hash = await c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'register',
    args: [args.pssPublicKey as `0x${string}`, args.swarmOverlay as `0x${string}`, args.metadataURI, args.initialStake],
  })
  emit(c, {kind: 'registerProvider', hash, toAddress: c.registry, note: `stake=${args.initialStake.toString()}`})
  return hash
}

export async function updateOfferings(c: ChainClient, offerings: ModelOffering[]): Promise<Hex> {
  const hash = await c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'updateOfferings',
    args: [offerings],
  })
  emit(c, {kind: 'updateOfferings', hash, toAddress: c.registry, note: `models=${offerings.length}`})
  return hash
}

export async function setMaxConcurrentJobs(c: ChainClient, cap: number): Promise<Hex> {
  const hash = await c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'setMaxConcurrentJobs',
    args: [cap],
  })
  emit(c, {kind: 'setMaxConcurrentJobs', hash, toAddress: c.registry, note: `cap=${cap}`})
  return hash
}

export async function getOpenJobs(c: ChainClient, owner: Address): Promise<number> {
  const raw = (await c.pub.readContract({
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'openJobs',
    args: [owner],
  })) as bigint | number
  return Number(raw)
}

export async function sendHeartbeat(c: ChainClient): Promise<Hex> {
  const hash = await c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'heartbeat',
    args: [],
  })
  emit(c, {kind: 'heartbeat', hash, toAddress: c.registry})
  return hash
}

export async function deactivateProvider(c: ChainClient): Promise<Hex> {
  const hash = await c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'deactivate',
    args: [],
  })
  emit(c, {kind: 'deactivateProvider', hash, toAddress: c.registry})
  return hash
}

export async function withdrawStake(c: ChainClient): Promise<Hex> {
  const hash = await c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'withdrawStake',
    args: [],
  })
  emit(c, {kind: 'withdrawStake', hash, toAddress: c.registry})
  return hash
}

/** Send native xDAI (Gnosis gas token) from this wallet to an arbitrary recipient. */
export async function sendXdai(c: ChainClient, to: Address, amountWei: bigint): Promise<Hex> {
  const hash = await c.wallet.sendTransaction({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    to,
    value: amountWei,
  })
  emit(c, {kind: 'sendXdai', hash, toAddress: to, note: amountWei.toString()})
  return hash
}

/** Send xBZZ ERC20 from this wallet to an arbitrary recipient. */
export async function sendXbzz(c: ChainClient, to: Address, amountWei: bigint): Promise<Hex> {
  const hash = await c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.xbzz,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amountWei],
  })
  emit(c, {kind: 'sendXbzz', hash, toAddress: to, note: amountWei.toString()})
  return hash
}

export async function readMinStake(c: ChainClient): Promise<bigint> {
  return (await c.pub.readContract({
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'MIN_STAKE',
    args: [],
  })) as bigint
}

export async function readXbzzBalance(c: ChainClient, owner: Address): Promise<bigint> {
  return (await c.pub.readContract({
    address: c.xbzz,
    abi: [
      {
        type: 'function',
        name: 'balanceOf',
        stateMutability: 'view',
        inputs: [{name: 'o', type: 'address'}],
        outputs: [{type: 'uint256'}],
      },
    ],
    functionName: 'balanceOf',
    args: [owner],
  })) as bigint
}

export async function getProvider(c: ChainClient, owner: Address): Promise<ProviderRow> {
  const raw = await c.pub.readContract({
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'getProvider',
    args: [owner],
  })
  return raw as unknown as ProviderRow
}

export async function getOfferings(c: ChainClient, owner: Address): Promise<ModelOffering[]> {
  const raw = await c.pub.readContract({
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'getOfferings',
    args: [owner],
  })
  return raw as unknown as ModelOffering[]
}

export async function listProviders(
  c: ChainClient,
  cursor = 0n,
  limit = 50n,
): Promise<{page: ProviderRow[]; nextCursor: bigint}> {
  const [page, nextCursor] = (await c.pub.readContract({
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'listProviders',
    args: [cursor, limit],
  })) as unknown as [ProviderRow[], bigint]
  return {page, nextCursor}
}

// ---------- JobEscrow ----------

/** Thrown by `postJob` when the on-chain call can't possibly succeed. Caller
 *  decides how to surface it (the gateway turns it into an OpenAI-compatible
 *  4xx error). Carries `httpStatus` so the gateway doesn't have to switch on
 *  message strings. */
export class PostJobPreflightError extends Error {
  constructor(message: string, readonly httpStatus: number = 402) {
    super(message)
    this.name = 'PostJobPreflightError'
  }
  // Strip the "Error: " prefix so chat clients render the bare message.
  override toString(): string {
    return this.message
  }
}

function formatBzz(plur: bigint): string {
  return (Number(plur) / 1e16).toFixed(4) + ' BZZ'
}

export async function postJob(
  c: ChainClient,
  args: {
    provider: Address
    requestHash: Hex
    modelId: string
    maxPayment: bigint
    deliveryDeadline: number
  },
): Promise<{txHash: Hex; jobId: Hex}> {
  // Pre-flight balance check — the xBZZ ERC20's transferFrom reverts with an
  // opaque "ERC20: insufficient balance" string when the gateway wallet is
  // underfunded, which viem surfaces as just "execution reverted". Catch it
  // here so the operator sees a clean message naming the wallet + the gap.
  const balance = await readXbzzBalance(c, c.address)
  if (balance < args.maxPayment) {
    const shortfall = args.maxPayment - balance
    throw new PostJobPreflightError(
      `gateway wallet out of xBZZ. balance ${formatBzz(balance)}, needed ${formatBzz(args.maxPayment)}. ` +
        `top up wallet ${c.address} on Gnosis with at least ${formatBzz(shortfall)}.`,
    )
  }
  try {
    const txHash = await c.wallet.writeContract({
      chain: c.wallet.chain!,
      account: c.wallet.account!,
      address: c.escrow,
      abi: jobEscrowAbi,
      functionName: 'postJob',
      args: [args.provider, args.requestHash, args.modelId, args.maxPayment, BigInt(args.deliveryDeadline)],
    })
    const receipt = await c.pub.waitForTransactionReceipt({hash: txHash})
    const events = parseEventLogs({abi: jobEscrowAbi, eventName: 'JobPosted', logs: receipt.logs})
    const ev = events[0]
    if (!ev) throw new Error('postJob: JobPosted event missing from receipt')
    const jobId = ev.args.jobId as Hex
    emit(c, {kind: 'postJob', hash: txHash, toAddress: c.escrow, note: `model=${args.modelId} jobId=${jobId}`})
    return {txHash, jobId}
  } catch (err) {
    const friendly = mapPostJobRevert(err, c.address, args)
    if (friendly) throw friendly
    throw err
  }
}

/** Translate a known JobEscrow custom-error selector (or the xBZZ ERC20 string
 *  revert) into a one-line operator-readable message. Returns null for
 *  anything we don't recognise — the caller rethrows the raw viem error. */
function mapPostJobRevert(
  err: unknown,
  wallet: Address,
  args: {provider: Address; maxPayment: bigint; deliveryDeadline: number},
): PostJobPreflightError | null {
  const data = extractRevertData(err)
  // Custom errors (4-byte selectors keccak'd from the signature).
  if (data) {
    if (data.startsWith('0x90b8ec18')) {
      // TransferFailed — xBZZ transferFrom returned false. Almost always means
      // the gateway wallet doesn't have the maxPayment (allowance is checked
      // separately and usually set to max).
      return new PostJobPreflightError(
        `gateway wallet out of xBZZ. needed ${formatBzz(args.maxPayment)}. ` +
          `top up wallet ${wallet} on Gnosis.`,
      )
    }
    if (data.startsWith('0x58ff6916')) {
      // ProviderNotLive
      return new PostJobPreflightError(
        `selected provider ${args.provider} is not live (no recent heartbeat or deactivated). ` +
          `try again — the gateway will pick a different provider.`,
        503,
      )
    }
    if (data.startsWith('0x785077af')) {
      // InsufficientStakeForJob
      return new PostJobPreflightError(
        `provider ${args.provider} doesn't have enough free stake for this job. ` +
          `try again — the gateway will pick a different provider.`,
        503,
      )
    }
    if (data.startsWith('0x710e1ce5')) {
      // BadDeadline — gateway bug, not the operator's problem.
      return new PostJobPreflightError(
        `deliveryDeadline ${args.deliveryDeadline} is too close to now; bump T4T_DEFAULT_DEADLINE_SECONDS.`,
        500,
      )
    }
  }
  // String revert from the xBZZ ERC20 ("ERC20: transfer amount exceeds balance").
  const msg = (err as {message?: string})?.message ?? ''
  if (/transfer amount exceeds balance|insufficient balance/i.test(msg)) {
    return new PostJobPreflightError(
      `gateway wallet out of xBZZ. needed ${formatBzz(args.maxPayment)}. ` +
        `top up wallet ${wallet} on Gnosis.`,
    )
  }
  return null
}

function extractRevertData(err: unknown): string | null {
  // viem nests the raw revert data on the BaseError chain — walk it.
  let e: unknown = err
  for (let i = 0; i < 6 && e; i++) {
    const cur = e as {data?: unknown; raw?: string; cause?: unknown}
    if (typeof cur.raw === 'string' && cur.raw.startsWith('0x') && cur.raw.length >= 10) return cur.raw
    if (typeof cur.data === 'string' && (cur.data as string).startsWith('0x') && (cur.data as string).length >= 10) {
      return cur.data as string
    }
    if (cur.data && typeof cur.data === 'object') {
      const inner = (cur.data as {data?: string}).data
      if (typeof inner === 'string' && inner.startsWith('0x') && inner.length >= 10) return inner
    }
    e = cur.cause
  }
  return null
}

export async function ackJob(c: ChainClient, jobId: Hex): Promise<Hex> {
  const hash = await c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.escrow,
    abi: jobEscrowAbi,
    functionName: 'ackJob',
    args: [jobId],
  })
  emit(c, {kind: 'ackJob', hash, toAddress: c.escrow, note: `jobId=${jobId}`})
  return hash
}

export async function readJob(
  c: ChainClient,
  jobId: Hex,
): Promise<{
  client: Address
  provider: Address
  requestHash: Hex
  responseHash: Hex
  modelId: string
  maxPayment: bigint
  postedAt: bigint
  ackedAt: bigint
  ackDeadline: bigint
  deliveryDeadline: bigint
  status: number
}> {
  const raw = (await c.pub.readContract({
    address: c.escrow,
    abi: jobEscrowAbi,
    functionName: 'jobs',
    args: [jobId],
  })) as readonly [Address, Address, Hex, Hex, string, bigint, bigint, bigint, bigint, bigint, number]
  return {
    client: raw[0],
    provider: raw[1],
    requestHash: raw[2],
    responseHash: raw[3],
    modelId: raw[4],
    maxPayment: raw[5],
    postedAt: raw[6],
    ackedAt: raw[7],
    ackDeadline: raw[8],
    deliveryDeadline: raw[9],
    status: raw[10],
  }
}

export async function cancelJob(c: ChainClient, jobId: Hex): Promise<Hex> {
  const hash = await c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.escrow,
    abi: jobEscrowAbi,
    functionName: 'cancelJob',
    args: [jobId],
  })
  emit(c, {kind: 'cancelJob', hash, toAddress: c.escrow, note: `jobId=${jobId}`})
  return hash
}

export async function timeoutJob(c: ChainClient, jobId: Hex): Promise<Hex> {
  const hash = await c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.escrow,
    abi: jobEscrowAbi,
    functionName: 'timeoutJob',
    args: [jobId],
  })
  emit(c, {kind: 'timeoutJob', hash, toAddress: c.escrow, note: `jobId=${jobId}`})
  return hash
}

export async function claimJob(
  c: ChainClient,
  args: {jobId: Hex; responseHash: Hex; actualPayment: bigint; clientSig?: Hex},
): Promise<Hex> {
  const hash = await c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.escrow,
    abi: jobEscrowAbi,
    functionName: 'claimJob',
    args: [args.jobId, args.responseHash, args.actualPayment, args.clientSig ?? '0x'],
  })
  emit(c, {kind: 'claimJob', hash, toAddress: c.escrow, note: `jobId=${args.jobId} amount=${args.actualPayment.toString()}`})
  return hash
}

// ---------- xBZZ ----------

export async function ensureAllowance(
  c: ChainClient,
  spender: Address,
  needed: bigint,
): Promise<void> {
  const current = (await c.pub.readContract({
    address: c.xbzz,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [c.address, spender],
  })) as bigint
  if (current >= needed) return
  const hash = await c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.xbzz,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, 2n ** 256n - 1n],
  })
  emit(c, {kind: 'approve', hash, toAddress: c.xbzz, note: `spender=${spender} max`})
}
