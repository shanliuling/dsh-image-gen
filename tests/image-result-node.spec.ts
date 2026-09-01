import { describe, expect, it } from 'vitest'

import { createImageResultDefinition } from '../src/client/image-result-node.js'

const attachment = {
  attachmentId: 'sha256:promoted-image',
  mediaType: 'image/png',
  bytes: 4096,
  width: 512,
  height: 512,
}

function location(turn: number, endSeq?: number) {
  return {
    kind: 'turn' as const,
    turn: {
      turn,
      start: { seq: 1 },
      end: endSeq === undefined ? undefined : { seq: endSeq },
      status: endSeq === undefined ? 'open' as const : 'closed' as const,
      steps: [],
      data: { get: () => undefined },
    },
  }
}

function match(event: Record<string, unknown>, role: 'start' | 'update', endSeq?: number) {
  return { event, role, location: location(1, endSeq), view: undefined }
}

function context(state: unknown, matches: readonly ReturnType<typeof match>[], endSeq?: number) {
  return {
    key: 'dsh-image-result:1',
    kind: 'dsh-image-result',
    id: '1',
    matches,
    start: matches[0],
    state,
    current: new Map(),
    location: location(1, endSeq),
  }
}

describe('promoted image result conversation node', () => {
  const startEvent = { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } }
  const resultEvent = {
    type: 'tool/result',
    seq: 4,
    time: 4000,
    data: {
      turn: 1,
      step: 1,
      message: { source: { callId: 'call-1' }, content: [] },
      meta: {
        kind: 'dsh-image-gen',
        attachment,
        prompt: 'a promoted image',
        provider: 'google',
        model: 'gemini',
        output: '1024x1024',
      },
    },
  }
  const answerEvent = {
    type: 'assistant/message',
    seq: 7,
    time: 7000,
    data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'done' }] } },
  }
  const endEvent = { type: 'turn/end', seq: 8, time: 8000, data: { turn: 1 } }

  const startMatch = match(startEvent, 'start')
  const resultMatch = match(resultEvent, 'update')
  const answerMatch = match(answerEvent, 'update')
  const endMatch = match(endEvent, 'update', 8)
  const reader = { previous: () => undefined }

  function replay(definition: ReturnType<typeof createImageResultDefinition>, closeTurn: boolean) {
    let state = definition.start(context(undefined, [startMatch]), startMatch, reader)
    state = definition.update(context(state, [startMatch, resultMatch]), resultMatch)
    if (closeTurn) {
      state = definition.update(context(state, [startMatch, resultMatch, answerMatch]), answerMatch)
      state = definition.update(context(state, [startMatch, resultMatch, answerMatch, endMatch], 8), endMatch)
    }
    return state
  }

  it('re-anchors beside the final answer when the turn closes with an unknown transcript mode', () => {
    const definition = createImageResultDefinition()
    const state = replay(definition, true)

    const closedNode = definition.buildViewNode?.(
      context(state, [startMatch, resultMatch, answerMatch, endMatch], 8),
    )

    expect(closedNode).toMatchObject({
      kind: 'dsh-image-result',
      anchorSeq: 7,
      data: { results: [{ attachment, prompt: 'a promoted image' }] },
    })
    // Latest DSH folds ordinary nodes only while anchorSeq < answerAnchorSeq.
    expect((closedNode as { anchorSeq: number }).anchorSeq).toBeGreaterThanOrEqual(7)
  })

  it('keeps the image at its own tool/result position while the turn is open', () => {
    const definition = createImageResultDefinition()
    let state = definition.start(context(undefined, [startMatch]), startMatch, reader)
    state = definition.update(context(state, [startMatch, resultMatch]), resultMatch)

    const liveNode = definition.buildViewNode?.(context(state, [startMatch, resultMatch]))
    expect(liveNode).toMatchObject({ kind: 'dsh-image-result', anchorSeq: 4 })

    // A later assistant message within the same open Turn must not push the
    // image below it (the reported bottom-pinning bug).
    state = definition.update(context(state, [startMatch, resultMatch, answerMatch]), answerMatch)
    const stillLiveNode = definition.buildViewNode?.(
      context(state, [startMatch, resultMatch, answerMatch]),
    )
    expect(stillLiveNode).toMatchObject({ kind: 'dsh-image-result', anchorSeq: 4 })
  })

  it('keeps the natural position in normal transcript mode even when the turn closes', () => {
    const definition = createImageResultDefinition({ isCompactTranscript: () => false })
    const state = replay(definition, true)

    const closedNode = definition.buildViewNode?.(
      context(state, [startMatch, resultMatch, answerMatch, endMatch], 8),
    )

    expect(closedNode).toMatchObject({ kind: 'dsh-image-result', anchorSeq: 4 })
  })

  it('re-anchors beside the final answer in compact transcript mode when the turn closes', () => {
    const definition = createImageResultDefinition({ isCompactTranscript: () => true })
    const state = replay(definition, true)

    const closedNode = definition.buildViewNode?.(
      context(state, [startMatch, resultMatch, answerMatch, endMatch], 8),
    )

    expect(closedNode).toMatchObject({ kind: 'dsh-image-result', anchorSeq: 7 })
  })

  it('falls back to compact-safe anchoring when the transcript read throws', () => {
    const definition = createImageResultDefinition({
      isCompactTranscript: () => { throw new Error('settings unavailable') },
    })
    const state = replay(definition, true)

    const closedNode = definition.buildViewNode?.(
      context(state, [startMatch, resultMatch, answerMatch, endMatch], 8),
    )

    expect(closedNode).toMatchObject({ kind: 'dsh-image-result', anchorSeq: 7 })
  })

  it('ignores unrelated and failed tool results', () => {
    const unrelated = {
      type: 'tool/result',
      seq: 4,
      time: 4000,
      data: { turn: 1, step: 1, message: { source: { callId: 'call-1' }, content: [] }, meta: { kind: 'other' } },
    }
    expect(createImageResultDefinition().match(unrelated)).toBeNull()
  })
})
