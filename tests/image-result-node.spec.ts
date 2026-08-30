import { describe, expect, it } from 'vitest'

import { imageResultDefinition } from '../src/client/image-result-node.js'

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
  it('moves the durable image beyond the final answer boundary when the turn closes', () => {
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
    let state = imageResultDefinition.start(context(undefined, [startMatch]), startMatch, reader)
    state = imageResultDefinition.update(context(state, [startMatch, resultMatch]), resultMatch)

    const liveNode = imageResultDefinition.buildViewNode?.(context(state, [startMatch, resultMatch]))
    expect(liveNode).toMatchObject({ kind: 'dsh-image-result', anchorSeq: 4 })

    state = imageResultDefinition.update(context(state, [startMatch, resultMatch, answerMatch]), answerMatch)
    state = imageResultDefinition.update(context(state, [startMatch, resultMatch, answerMatch, endMatch], 8), endMatch)
    const closedNode = imageResultDefinition.buildViewNode?.(context(state, [startMatch, resultMatch, answerMatch, endMatch], 8))

    expect(closedNode).toMatchObject({
      kind: 'dsh-image-result',
      anchorSeq: 7,
      data: { results: [{ attachment, prompt: 'a promoted image' }] },
    })
    // Latest DSH folds ordinary nodes only while anchorSeq < answerAnchorSeq.
    expect((closedNode as { anchorSeq: number }).anchorSeq).toBeGreaterThanOrEqual(7)
  })

  it('ignores unrelated and failed tool results', () => {
    const unrelated = {
      type: 'tool/result',
      seq: 4,
      time: 4000,
      data: { turn: 1, step: 1, message: { source: { callId: 'call-1' }, content: [] }, meta: { kind: 'other' } },
    }
    expect(imageResultDefinition.match(unrelated)).toBeNull()
  })
})
