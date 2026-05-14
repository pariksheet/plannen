// Anthropic provider implementation. Uses the Vercel AI SDK's Anthropic
// adapter (createAnthropic) and the SDK's tool factories. Extracted verbatim
// from the previous monolithic ai.ts so the existing surface is preserved
// byte-for-byte.

import { generateText, generateObject, type LanguageModelV1 } from 'npm:ai@4'
import { createAnthropic, anthropic } from 'npm:@ai-sdk/anthropic@1'
import type { HandlerCtx } from '../handlers/types.ts'
import type { AISettings } from '../ai.ts'
import { parseJsonAgainstSchema } from '../ai.ts'
import type { AIProvider, GenerateOpts, GenerateStructuredOpts, GenerateFromImageOpts } from './types.ts'

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6'

function buildModel(s: AISettings, modelOverride?: string): LanguageModelV1 {
  const model = modelOverride ?? s.default_model ?? DEFAULT_ANTHROPIC_MODEL
  if (!s.api_key) {
    throw new Error('anthropic provider requires an api_key')
  }
  const provider = createAnthropic({ apiKey: s.api_key })
  return provider(model)
}

function buildTools(requested: ReadonlyArray<string> | undefined) {
  if (!requested?.length) return undefined
  const tools: Record<string, unknown> = {}
  for (const name of requested) {
    if (name === 'web_search') {
      // The web_search tool ships in newer Anthropic SDK builds; Deno's
      // `npm:` resolver may surface a version that includes it while
      // Node's 1.x stable does not. Reach for the factory dynamically;
      // when missing, silently drop the tool.
      const factory = (anthropic.tools as unknown as Record<string, ((opts: { maxUses: number }) => unknown) | undefined>)
        .webSearch_20250305
      if (typeof factory === 'function') tools.web_search = factory({ maxUses: 5 })
    }
  }
  return Object.keys(tools).length > 0 ? tools : undefined
}

export function anthropicProvider(s: AISettings): AIProvider {
  return {
    async generate(_ctx: HandlerCtx, opts: GenerateOpts): Promise<string> {
      const result = await generateText({
        model: buildModel(s, opts.model),
        prompt: opts.prompt,
        // deno-lint-ignore no-explicit-any
        tools: buildTools(opts.tools) as any,
        maxTokens: opts.maxTokens ?? 4096,
      })
      return result.text
    },

    async generateStructured<T>(_ctx: HandlerCtx, opts: GenerateStructuredOpts<T>): Promise<T> {
      // web_search is incompatible with generateObject's tool-call-based
      // structured output. Fall back to generateText + JSON instruction.
      if (opts.tools?.length) {
        const jsonInstruction = '\n\nReturn ONLY a JSON value matching the requested schema. No markdown, no prose.'
        const result = await generateText({
          model: buildModel(s, opts.model),
          prompt: opts.prompt + jsonInstruction,
          // deno-lint-ignore no-explicit-any
          tools: buildTools(opts.tools) as any,
          maxTokens: opts.maxTokens ?? 4096,
        })
        return parseJsonAgainstSchema(result.text, opts.schema)
      }
      const result = await generateObject({
        model: buildModel(s, opts.model),
        prompt: opts.prompt,
        schema: opts.schema,
        maxTokens: opts.maxTokens ?? 4096,
      })
      return result.object
    },

    async generateFromImage(_ctx: HandlerCtx, opts: GenerateFromImageOpts): Promise<string> {
      const result = await generateText({
        model: buildModel(s, opts.model),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', image: opts.imageBytes, mimeType: opts.mimeType },
              { type: 'text', text: opts.prompt },
            ],
          },
        ],
        maxTokens: opts.maxTokens ?? 2048,
      })
      return result.text
    },
  }
}
