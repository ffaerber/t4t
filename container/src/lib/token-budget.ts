import type {OpenAIChatRequest} from './types'

/** Rough char-to-token ratio used as a tokenizer-free fallback. 4 chars/token
 *  is the canonical OpenAI heuristic for English; code and non-Latin scripts
 *  drift but the multiplicative headroom (see `computeMaxPayment`) absorbs it. */
const CHARS_PER_TOKEN = 4

/** Token charge for a non-text content part (image_url, input_audio, …). We
 *  can't estimate these from character counts — a base64 data URI is megabytes
 *  of characters but only ~1k tokens once tiled — so we bill a flat rate near
 *  OpenAI's high-detail image cost instead. Expressed in chars so it flows
 *  through the same `/CHARS_PER_TOKEN` divisor as everything else. */
const NON_TEXT_PART_CHARS = 1024 * CHARS_PER_TOKEN

/** Lower bound for estimated prompt tokens. Stops near-empty requests from
 *  escrowing zero, which would cap the response at no tokens via the same
 *  multiplicative buffer applied to both sides. */
const MIN_PROMPT_TOKEN_FLOOR = 256n

export interface TokenBudgetConfig {
  /** Fallback output cap when the request omits `max_tokens`. */
  defaultMaxOutputTokens: bigint
  /** Multiplicative safety buffer applied to both sides. 0.2 = +20%.
   *  Encoded as parts-per-million to stay in integer math. */
  headroomPpm: bigint
  /** Optional per-job escrow ceiling (xBZZ wei). If the computed maxPayment
   *  exceeds this, the request is rejected before any on-chain work. */
  maxEscrowPerJob: bigint | null
}

export interface ModelPricing {
  inputPricePerMillionTokens: bigint
  outputPricePerMillionTokens: bigint
}

export interface MaxPaymentBreakdown {
  estimatedPromptTokens: bigint
  budgetedPromptTokens: bigint
  budgetedCompletionTokens: bigint
  maxPayment: bigint
}

export class EscrowCapExceededError extends Error {
  readonly httpStatus = 413
  constructor(readonly maxPayment: bigint, readonly cap: bigint) {
    super(
      `request would escrow ${maxPayment} wei xBZZ, exceeding T4T_MAX_ESCROW_PER_JOB=${cap}. ` +
        `Lower max_tokens, shorten the prompt, or raise the cap.`,
    )
    this.name = 'EscrowCapExceededError'
  }
}

/**
 * Character weight of one message's `content`.
 *
 * The OpenAI schema allows three shapes here and we have to handle all of
 * them, because under-counting silently under-sizes the escrow: the provider
 * still does the work but `claimJob` gets clipped to the too-small
 * `maxPayment`, so it eats the difference.
 *
 *   - string          — the common case, count its characters.
 *   - null/undefined  — legal on assistant messages that carry `tool_calls`
 *                       instead of prose. Contributes nothing (but the
 *                       per-message overhead below still applies).
 *   - array of parts  — multimodal / "content parts". Text parts count their
 *                       own characters; anything else is billed at the flat
 *                       `NON_TEXT_PART_CHARS` rate.
 *
 * Anything else (a number, a stray object) falls back to its JSON length,
 * which over-counts rather than under-counts.
 */
export function contentChars(content: unknown): number {
  if (content == null) return 0
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    let chars = 0
    for (const part of content) {
      if (typeof part === 'string') {
        chars += part.length
        continue
      }
      const text = (part as {text?: unknown})?.text
      chars += typeof text === 'string' ? text.length : NON_TEXT_PART_CHARS
    }
    return chars
  }
  try {
    return JSON.stringify(content)?.length ?? 0
  } catch {
    return NON_TEXT_PART_CHARS
  }
}

/** Flatten a message's `content` to plain text for logging / the admin UI's
 *  prompt column. Non-text parts are elided rather than billed — this is a
 *  display path, not a pricing one. */
export function contentToText(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        const text = (part as {text?: unknown})?.text
        if (typeof text === 'string') return text
        const type = (part as {type?: unknown})?.type
        return typeof type === 'string' ? `[${type}]` : '[part]'
      })
      .join(' ')
  }
  return String(content)
}

/** Estimate prompt tokens from an OpenAI chat request. We sum the character
 *  weight of every message's content (plus a small per-message overhead for
 *  the role tag and chat-template boilerplate) and divide by CHARS_PER_TOKEN,
 *  rounding up. This intentionally overshoots — the escrow is a ceiling, the
 *  provider claims the actual count from the inference backend's usage. */
export function estimatePromptTokens(req: OpenAIChatRequest): bigint {
  let chars = 0
  for (const m of req.messages ?? []) {
    chars += contentChars(m?.content)
    // Chat templates add ~4 tokens per message for the role markers + separators.
    chars += 16
  }
  const tokens = BigInt(Math.ceil(chars / CHARS_PER_TOKEN))
  return tokens < MIN_PROMPT_TOKEN_FLOOR ? MIN_PROMPT_TOKEN_FLOOR : tokens
}

/** Apply the multiplicative headroom to a token count. Uses ppm so the math
 *  stays in bigint and lossless for any ratio expressible as a fraction. */
function applyHeadroom(tokens: bigint, headroomPpm: bigint): bigint {
  return (tokens * (1_000_000n + headroomPpm) + 999_999n) / 1_000_000n
}

/** Compute the on-chain maxPayment for a chat request. Sizes the prompt side
 *  off the estimated input length (not max_tokens), and the completion side
 *  off the requested or default output cap, each padded by `headroomPpm`. */
export function computeMaxPayment(
  req: OpenAIChatRequest,
  pricing: ModelPricing,
  cfg: TokenBudgetConfig,
): MaxPaymentBreakdown {
  const promptEstimate = estimatePromptTokens(req)
  const requestedOutput =
    req.max_tokens != null && req.max_tokens > 0
      ? BigInt(req.max_tokens)
      : cfg.defaultMaxOutputTokens

  const promptBudget = applyHeadroom(promptEstimate, cfg.headroomPpm)
  const outputBudget = applyHeadroom(requestedOutput, cfg.headroomPpm)

  const inPay = pricing.inputPricePerMillionTokens * promptBudget
  const outPay = pricing.outputPricePerMillionTokens * outputBudget
  const maxPayment = (inPay + outPay + 999_999n) / 1_000_000n

  if (cfg.maxEscrowPerJob !== null && maxPayment > cfg.maxEscrowPerJob) {
    throw new EscrowCapExceededError(maxPayment, cfg.maxEscrowPerJob)
  }

  return {
    estimatedPromptTokens: promptEstimate,
    budgetedPromptTokens: promptBudget,
    budgetedCompletionTokens: outputBudget,
    maxPayment,
  }
}

/** Maximum completion tokens the provider can serve for `maxPayment` given a
 *  (conservatively over-estimated) prompt token count. Inverts the contract's
 *  cost formula `actualWei = (inPrice·prompt + outPrice·completion) / 1e6`
 *  to solve for `completion ≤ (maxPayment·1e6 − inPrice·promptCeil) / outPrice`,
 *  rounded down so `actualWei ≤ maxPayment` is guaranteed when the backend
 *  honors `max_tokens`. Returns 0n when the prompt alone already exhausts the
 *  escrow — the caller should treat that as "refuse the job", not "serve zero
 *  tokens", since a 0-token completion is rarely a useful answer. */
export function maxAffordableCompletionTokens(args: {
  maxPayment: bigint
  promptTokenCeiling: bigint
  inputPricePerMillionTokens: bigint
  outputPricePerMillionTokens: bigint
}): bigint {
  // A free model is uncappable from cost — defer to the caller's own ceiling.
  if (args.outputPricePerMillionTokens === 0n) return -1n
  const budgetWei = args.maxPayment * 1_000_000n
  const promptCostWei = args.inputPricePerMillionTokens * args.promptTokenCeiling
  if (promptCostWei >= budgetWei) return 0n
  return (budgetWei - promptCostWei) / args.outputPricePerMillionTokens
}
