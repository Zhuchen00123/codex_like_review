import { buildInstructions, buildReviewInput, parseVerdict } from './prompt.js'
import { createInvestigator, INVESTIGATION_INSTRUCTIONS } from './investigation.js'

async function readResponse(llm, options) {
  let text = '', finished = false, tokens, textBlocks = 0, finish
  const calls = [], started = new Set(), ended = new Set()
  for await (const chunk of llm.stream(options)) {
    if (finished) throw new Error('data-after-finish')
    if (chunk.type === 'text-delta') { if (typeof chunk.text !== 'string') throw new Error('invalid-stream'); text += chunk.text }
    if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') started.add(chunk.index)
    if (chunk.type === 'tool-call-delta') started.add(chunk.index)
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
      if (++textBlocks > 1 || typeof chunk.block.text !== 'string' || (text && text !== chunk.block.text)) throw new Error('conflicting-output')
      text = chunk.block.text
    }
    if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
      const block = chunk.block
      if (typeof block.id !== 'string' || typeof block.name !== 'string' || typeof block.arguments !== 'string' || calls.some((v) => v.id === block.id)) throw new Error('invalid-review-tool-call')
      calls.push({ type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }); ended.add(chunk.index)
    }
    if (text.length > 64000) throw new Error('oversized-response')
    if (chunk.type === 'usage') tokens = chunk.usage?.totalTokens
    if (chunk.type === 'finish') { finished = true; finish = chunk.reason?.kind }
  }
  if (!finished) throw new Error('incomplete-stream')
  if ([...started].some((index) => !ended.has(index))) throw new Error('incomplete-review-tool-call')
  if (calls.length ? finish !== 'tool-calls' : finish !== 'stop') throw new Error('host-model-failed')
  return { text, calls, tokens }
}

export function createHostReviewer(config, llm) {
  return {
    async review(action) {
      if (action.signal?.aborted) return { status: 'unavailable', reason: 'aborted' }
      const startedAt = Date.now()
      try {
        const input = buildReviewInput({ ...action, maxArgsChars: config.maxArgsChars }), investigator = createInvestigator(action, config)
        const messages = [{ role: 'user', content: [{ type: 'text', text: input[0].content[0].text }] }]
        const options = { provider: config.reviewProvider, model: config.reviewModel,
          system: buildInstructions(config.policyBundle, config.promptMode, action)+(investigator ? INVESTIGATION_INSTRUCTIONS : ''), messages, signal: action.signal,
          ...(investigator ? { tools: investigator.tools } : {}),
          ...(config.reasoningEffort && config.reasoningEffort !== 'default' ? { reasoningEffort: config.reasoningEffort } : {}) }
        let tokens = 0, tokenKnown = false
        for (let round = 0; round <= 3; round++) {
          const response = await readResponse(llm, options)
          if (Number.isFinite(response.tokens)) { tokens += response.tokens; tokenKnown = true }
          const verdict = parseVerdict(response.text)
          if (!response.calls.length) return verdict ? { status: 'verdict', verdict, meta: { provider: config.reviewProvider, model: config.reviewModel, elapsedMs: Date.now()-startedAt, totalTokens: tokenKnown ? tokens : undefined, investigationCalls: investigator?.calls ?? 0 } } : { status: 'unavailable', reason: 'unparseable-verdict' }
          if (!investigator || verdict) return { status: 'unavailable', reason: 'unexpected-review-tool-call' }
          if (round === 3) return { status: 'unavailable', reason: 'investigation-limit' }
          const outputs = []
          for (const call of response.calls) outputs.push({ role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: JSON.stringify({ role: 'untrusted-evidence', result: await investigator.execute(call.name, call.arguments, action.signal) }) }] })
          messages.push({ role: 'assistant', content: response.calls }, ...outputs)
        }
      } catch (error) {
        const known = new Set(['data-after-finish', 'invalid-stream', 'conflicting-output', 'invalid-review-tool-call', 'incomplete-stream', 'incomplete-review-tool-call', 'host-model-failed', 'unexpected-review-tool-call', 'investigation-limit'])
        return { status: 'unavailable', reason: action.signal?.aborted ? 'aborted' : known.has(error.message) ? error.message : 'host-model-error' }
      }
    },
  }
}
