import {describe, expect, it} from 'vitest'
import {escape, formatDuration, formatTs, formatXBZZ, parseBzzToPlur, shortHex} from '../src/lib/admin-html'

describe('admin-html helpers', () => {
  it('escapes HTML metacharacters', () => {
    expect(escape(`<script>alert("x")</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    )
  })

  it('formats xBZZ wei to human-friendly decimal (16 decimals on Gnosis)', () => {
    expect(formatXBZZ(1n * 10n ** 16n)).toBe('1')
    expect(formatXBZZ(15_000_000_000_000_000n)).toBe('1.5')
    expect(formatXBZZ(0n)).toBe('0')
    expect(formatXBZZ(null)).toBe('—')
  })

  it('shortens long hex', () => {
    expect(shortHex('0x1234567890abcdef1234567890abcdef')).toBe('0x1234…cdef')
    expect(shortHex('0xabc')).toBe('0xabc')
  })

  it('formats durations relative to acked → completed', () => {
    expect(formatDuration(100, 145)).toBe('45s')
    expect(formatDuration(100, 220)).toBe('2m0s')
    expect(formatDuration(null, 220)).toBe('—')
  })

  it('formats unix timestamps', () => {
    expect(formatTs(0)).toBe('—')
    expect(formatTs(1_700_000_000)).toMatch(/^2023-11-14/)
  })
})

describe('price form round-trip (regression)', () => {
  it('the display formatter is lossy and must not feed a form value', async () => {
    const {plurToBzzExact} = await import('../src/lib/endpoints')
    // The admin Models page renders each price into an <input value=…> that the
    // save handler parses straight back to PLUR. Using formatXBZZ there rounded
    // any price finer than 1e-6 BZZ down on every save — and zeroed anything
    // below it, making the model free — even when the operator only edited the
    // other field on the row.
    const finegrained = 1234n // 1.234e-13 BZZ
    expect(formatXBZZ(finegrained)).toBe('0.000000')
    expect(parseBzzToPlur(formatXBZZ(finegrained))).toBe(0n)

    expect(plurToBzzExact(finegrained)).toBe('0.0000000000001234')
    expect(parseBzzToPlur(plurToBzzExact(finegrained))).toBe(finegrained)
  })

  it('round-trips prices that survive display truncation too', async () => {
    const {plurToBzzExact} = await import('../src/lib/endpoints')
    for (const plur of [0n, 3n * 10n ** 15n, 15n * 10n ** 15n, 10n ** 16n, 123_456_789n]) {
      expect(parseBzzToPlur(plurToBzzExact(plur))).toBe(plur)
    }
  })
})
