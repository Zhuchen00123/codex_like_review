import { buildInstructions, buildReviewInput, parseVerdict } from './prompt.js'

export function createHostReviewer(config, llm) {
  return {
    async review(action) {
      if (action.signal?.aborted) return { status: 'unavailable', reason: 'aborted' }
      const startedAt = Date.now()
      try {
        const input = buildReviewInput({ ...action, maxArgsChars: config.maxArgsChars })
        const options = { provider: config.reviewProvider, model: config.reviewModel, system: buildInstructions(config.policyBundle, config.promptMode), messages: [{ role: 'user', content: [{ type: 'text', text: input[0].content[0].text }] }], signal: action.signal,
          ...(config.reasoningEffort && config.reasoningEffort !== 'default' ? { reasoningEffort: config.reasoningEffort } : {}) }
        let text = '', finished = false, tokens, textBlocks = 0
        for await (const chunk of llm.stream(options)) {
          if (finished) return { status: 'unavailable', reason: 'data-after-finish' }
          if (chunk.type === 'text-delta') { if (typeof chunk.text !== 'string') return { status: 'unavailable', reason: 'invalid-stream' }; text += chunk.text }
          if (chunk.type === 'tool-call-start' || chunk.type === 'tool-call-delta' || chunk.blockType === 'tool-call' || chunk.block?.type === 'tool-call') return { status: 'unavailable', reason: 'unexpected-review-tool-call' }
          if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
            if (++textBlocks > 1 || typeof chunk.block.text !== 'string' || (text && text !== chunk.block.text)) return { status: 'unavailable', reason: 'conflicting-output' }
            text = chunk.block.text
          }
          if (text.length > 64000) return { status: 'unavailable', reason: 'oversized-response' }
          if (chunk.type === 'usage') tokens = chunk.usage?.totalTokens
          if (chunk.type === 'finish') { finished = true; if (chunk.reason?.kind !== 'stop') return { status: 'unavailable', reason: 'host-model-failed' } }
        }
        if (!finished) return { status: 'unavailable', reason: 'incomplete-stream' }
        const verdict = parseVerdict(text)
        return verdict ? { status: 'verdict', verdict, meta: { provider: config.reviewProvider, model: config.reviewModel, elapsedMs: Date.now()-startedAt, totalTokens: tokens } } : { status: 'unavailable', reason: 'unparseable-verdict' }
      } catch { return { status: 'unavailable', reason: action.signal?.aborted ? 'aborted' : 'host-model-error' } }
    },
  }
}
