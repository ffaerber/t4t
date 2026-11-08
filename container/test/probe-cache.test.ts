import {describe, expect, it} from 'vitest'
import {ProbeCache} from '../src/lib/probe-cache'

function setup(failing: Set<string> = new Set()) {
  let t = 0
  const probed: string[] = []
  const cache = new ProbeCache(3_600_000, () => t)
  const probe = async (id: string) => {
    probed.push(id)
    if (failing.has(id)) throw new Error(`${id} 400`)
  }
  return {cache, probe, probed, advance: (ms: number) => (t += ms)}
}

describe('ProbeCache', () => {
  it('probes a model only the first time it is listed', async () => {
    const {cache, probe, probed} = setup()
    expect(await cache.live(['a', 'b'], probe)).toEqual(['a', 'b'])
    expect(await cache.live(['a', 'b'], probe)).toEqual(['a', 'b'])
    expect(await cache.live(['a', 'b', 'c'], probe)).toEqual(['a', 'b', 'c'])
    expect(probed).toEqual(['a', 'b', 'c'])
  })

  it('keeps a failed model out and retries it only after the retry time', async () => {
    const failing = new Set(['whisper'])
    const {cache, probe, probed, advance} = setup(failing)
    const failed: string[] = []
    const onFail = (id: string) => failed.push(id)
    expect(await cache.live(['llama', 'whisper'], probe, onFail)).toEqual(['llama'])
    advance(60_000)
    expect(await cache.live(['llama', 'whisper'], probe, onFail)).toEqual(['llama'])
    expect(probed).toEqual(['llama', 'whisper'])
    expect(failed).toEqual(['whisper'])

    failing.delete('whisper')
    advance(3_600_000)
    expect(await cache.live(['llama', 'whisper'], probe, onFail)).toEqual(['llama', 'whisper'])
    expect(probed).toEqual(['llama', 'whisper', 'whisper'])
  })

  it('probes a model again when it comes back after it was gone', async () => {
    const {cache, probe, probed} = setup()
    await cache.live(['a', 'b'], probe)
    // e.g. the backend's machine went to sleep: its models are not listed.
    expect(await cache.live(['b'], probe)).toEqual(['b'])
    expect(await cache.live(['a', 'b'], probe)).toEqual(['a', 'b'])
    expect(probed).toEqual(['a', 'b', 'a'])
  })
})
