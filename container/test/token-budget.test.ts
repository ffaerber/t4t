import {describe, expect, it} from 'vitest'
import type {OpenAIChatRequest} from '../src/lib/types'
import {
  EscrowCapExceededError,
  computeMaxPayment,
  contentToText,
  estimatePromptTokens,
  maxAffordableCompletionTokens,
  type ModelPricing,
  type TokenBudgetConfig,
} from '../src/lib/token-budget'

const PRICING: ModelPricing = {
  // 1 BZZ per 1M tokens on each side (xBZZ has 16 decimals — see config.ts).
  inputPricePerMillionTokens: 1_000_000_000_000_000n,
  outputPricePerMillionTokens: 1_000_000_000_000_000n,
}

const BASE_CFG: TokenBudgetConfig = {
  defaultMaxOutputTokens: 16_384n,
  headroomPpm: 200_000n, // 20%
  maxEscrowPerJob: null,
}

function req(overrides: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
  return {
    model: 'gpt-5',
    messages: [{role: 'user', content: 'hi'}],
    ...overrides,
  }
}

describe('estimatePromptTokens', () => {
  it('floors tiny prompts at MIN_PROMPT_TOKEN_FLOOR (256)', () => {
    expect(estimatePromptTokens(req())).toBe(256n)
  })

  it('scales with message length (chars/4 + per-message overhead)', () => {
    // 4000 chars + 16 overhead = 4016 chars → ceil(4016/4) = 1004 tokens
    const big = 'x'.repeat(4000)
    expect(estimatePromptTokens(req({messages: [{role: 'user', content: big}]}))).toBe(1004n)
  })

  it('sums across messages', () => {
    // Two messages, each 400 chars + 16 overhead = 832 chars → 208 tokens,
    // which is below the 256 floor — still returns the floor.
    const small = 'x'.repeat(400)
    expect(
      estimatePromptTokens(
        req({
          messages: [
            {role: 'system', content: small},
            {role: 'user', content: small},
          ],
        }),
      ),
    ).toBe(256n)
  })

  it('handles a million-character prompt without overflow', () => {
    const huge = 'x'.repeat(1_000_000)
    // 1_000_000 + 16 overhead = 1_000_016 → ceil/4 = 250_004
    expect(estimatePromptTokens(req({messages: [{role: 'user', content: huge}]}))).toBe(250_004n)
  })
})

describe('computeMaxPayment', () => {
  it('uses the default output cap when max_tokens is omitted', () => {
    const r = computeMaxPayment(req(), PRICING, BASE_CFG)
    // Prompt floor 256 × 1.2 = 308 (ceil), output 16384 × 1.2 = 19661 (ceil).
    expect(r.budgetedPromptTokens).toBe(308n)
    expect(r.budgetedCompletionTokens).toBe(19_661n)
    // (308 + 19661) × 1e15 / 1e6 = 1.9969e13 wei (≈ 0.002 BZZ)
    expect(r.maxPayment).toBe(19_969_000_000_000n)
  })

  it('respects an explicit max_tokens value', () => {
    const r = computeMaxPayment(req({max_tokens: 1024}), PRICING, BASE_CFG)
    // Output 1024 × 1.2 = 1229 (ceil).
    expect(r.budgetedCompletionTokens).toBe(1229n)
  })

  it('scales the prompt budget off the actual prompt size, not max_tokens', () => {
    const big = 'x'.repeat(400_000) // ~100k tokens
    const r = computeMaxPayment(
      req({messages: [{role: 'user', content: big}], max_tokens: 1024}),
      PRICING,
      BASE_CFG,
    )
    // ceil((400000+16)/4) = 100004 tokens → × 1.2 = 120005 (ceil).
    expect(r.estimatedPromptTokens).toBe(100_004n)
    expect(r.budgetedPromptTokens).toBe(120_005n)
  })

  it('zero headroom yields exact (estimate, output) sizing', () => {
    const r = computeMaxPayment(
      req({max_tokens: 1000}),
      PRICING,
      {...BASE_CFG, headroomPpm: 0n},
    )
    expect(r.budgetedPromptTokens).toBe(256n)
    expect(r.budgetedCompletionTokens).toBe(1000n)
  })

  it('throws EscrowCapExceededError when the budget breaches the per-job cap', () => {
    const huge = 'x'.repeat(4_000_000) // ~1M tokens
    expect(() =>
      computeMaxPayment(
        req({messages: [{role: 'user', content: huge}]}),
        PRICING,
        {...BASE_CFG, maxEscrowPerJob: 1n},
      ),
    ).toThrow(EscrowCapExceededError)
  })

  it('passes through when maxPayment equals the cap exactly', () => {
    const r1 = computeMaxPayment(req(), PRICING, BASE_CFG)
    const r2 = computeMaxPayment(req(), PRICING, {...BASE_CFG, maxEscrowPerJob: r1.maxPayment})
    expect(r2.maxPayment).toBe(r1.maxPayment)
  })

  it('EscrowCapExceededError carries httpStatus 413 for the server layer', () => {
    try {
      computeMaxPayment(req(), PRICING, {...BASE_CFG, maxEscrowPerJob: 1n})
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(EscrowCapExceededError)
      expect((e as EscrowCapExceededError).httpStatus).toBe(413)
      expect((e as EscrowCapExceededError).cap).toBe(1n)
    }
  })
})

describe('maxAffordableCompletionTokens', () => {
  const PRICE_1_BZZ_PER_M = 1_000_000_000_000_000n // 1 BZZ wei / 1M tokens

  it('solves for the completion cap that exactly fits the budget', () => {
    // 2 BZZ escrow, 1k prompt @ 1 BZZ/M, 1 BZZ/M out → 2e15·1e6 = 2e21
    // promptCost = 1e15·1000 = 1e18. remaining = 2e21 - 1e18 = 1.999e21.
    // cap = 1.999e21 / 1e15 = 1_999_000
    const cap = maxAffordableCompletionTokens({
      maxPayment: 2_000_000_000_000_000n,
      promptTokenCeiling: 1000n,
      inputPricePerMillionTokens: PRICE_1_BZZ_PER_M,
      outputPricePerMillionTokens: PRICE_1_BZZ_PER_M,
    })
    expect(cap).toBe(1_999_000n)
  })

  it('returns 0 when the prompt alone exhausts the budget', () => {
    const cap = maxAffordableCompletionTokens({
      maxPayment: 1_000n,
      promptTokenCeiling: 1_000_000n,
      inputPricePerMillionTokens: PRICE_1_BZZ_PER_M,
      outputPricePerMillionTokens: PRICE_1_BZZ_PER_M,
    })
    expect(cap).toBe(0n)
  })

  it('returns -1n (uncapped) for a zero-price output model', () => {
    const cap = maxAffordableCompletionTokens({
      maxPayment: 100n,
      promptTokenCeiling: 50n,
      inputPricePerMillionTokens: PRICE_1_BZZ_PER_M,
      outputPricePerMillionTokens: 0n,
    })
    expect(cap).toBe(-1n)
  })

  it('floors the cap so the contract-side actualWei stays within maxPayment', () => {
    // Set up a budget where the integer division would round down meaningfully.
    const maxPayment = 1_000_001n
    const inPrice = PRICE_1_BZZ_PER_M
    const outPrice = 3n
    const promptCeiling = 0n
    const cap = maxAffordableCompletionTokens({
      maxPayment,
      promptTokenCeiling: promptCeiling,
      inputPricePerMillionTokens: inPrice,
      outputPricePerMillionTokens: outPrice,
    })
    // Verify the rounded cap fits: (inPrice·prompt + outPrice·cap)/1e6 ≤ maxPayment.
    const actualWei = (inPrice * promptCeiling + outPrice * cap) / 1_000_000n
    expect(actualWei).toBeLessThanOrEqual(maxPayment)
  })
})

describe('estimatePromptTokens — non-string content shapes', () => {
  it('treats null content as empty instead of throwing', () => {
    // Legal on assistant turns that carry `tool_calls` rather than prose.
    const messages = [{role: 'assistant' as const, content: null}]
    expect(() => estimatePromptTokens(req({messages}))).not.toThrow()
    expect(estimatePromptTokens(req({messages}))).toBe(256n)
  })

  it('counts characters inside content parts, not the number of parts', () => {
    // Regression: `content.length` on an array returned the part count, so a
    // 40k-char multimodal prompt priced as the 256-token floor and the
    // provider ate the difference at claim time.
    const long = 'x'.repeat(40_000)
    const messages = [{role: 'user' as const, content: [{type: 'text', text: long}]}]
    // 40000 chars + 16 overhead = 40016 → ceil(40016/4) = 10004
    expect(estimatePromptTokens(req({messages}))).toBe(10_004n)
  })

  it('sums across mixed text parts', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          {type: 'text', text: 'a'.repeat(2000)},
          {type: 'text', text: 'b'.repeat(2000)},
        ],
      },
    ]
    expect(estimatePromptTokens(req({messages}))).toBe(1004n)
  })

  it('bills non-text parts at a flat rate rather than their payload size', () => {
    // A base64 data URI is megabytes of characters but ~1k tokens once tiled;
    // charging by character length would over-escrow by orders of magnitude.
    const dataUri = 'data:image/png;base64,' + 'A'.repeat(1_000_000)
    const messages = [
      {role: 'user' as const, content: [{type: 'image_url', image_url: {url: dataUri}}]},
    ]
    // 1024 tokens for the part + 16 chars overhead → 1024 + 4 = 1028
    expect(estimatePromptTokens(req({messages}))).toBe(1028n)
  })

  it('falls back to JSON length for unexpected content types', () => {
    const messages = [{role: 'user' as const, content: {weird: 'x'.repeat(4000)} as never}]
    expect(estimatePromptTokens(req({messages}))).toBeGreaterThan(900n)
  })
})

describe('contentToText', () => {
  it('passes strings through and flattens parts', () => {
    expect(contentToText('hello')).toBe('hello')
    expect(contentToText(null)).toBe('')
    expect(contentToText([{type: 'text', text: 'a'}, {type: 'text', text: 'b'}])).toBe('a b')
  })

  it('labels non-text parts by type instead of dumping their payload', () => {
    expect(contentToText([{type: 'image_url', image_url: {url: 'data:…'}}])).toBe('[image_url]')
  })
})
