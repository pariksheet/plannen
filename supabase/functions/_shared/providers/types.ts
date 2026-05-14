// Internal AIProvider interface. Both Tier 0 (Node) and Tier 1 (Deno) dispatch
// from `ai.ts` through implementations of this interface. Only the Anthropic
// provider exists in both trees; the CLI provider is Node-only by design (Deno
// edge functions cannot shell out to host binaries).

import { z } from 'npm:zod@3'
import type { HandlerCtx } from '../handlers/types.ts'

export type Provider = 'anthropic' | 'claude-code-cli'

export type GenerateOpts = {
  prompt: string
  model?: string
  tools?: ReadonlyArray<'web_search'>
  maxTokens?: number
}

export type GenerateStructuredOpts<T> = GenerateOpts & { schema: z.ZodSchema<T> }

export type GenerateFromImageOpts = {
  imageBytes: Uint8Array
  mimeType: string
  prompt: string
  model?: string
  maxTokens?: number
}

export interface AIProvider {
  generate(ctx: HandlerCtx, opts: GenerateOpts): Promise<string>
  generateStructured<T>(ctx: HandlerCtx, opts: GenerateStructuredOpts<T>): Promise<T>
  generateFromImage(ctx: HandlerCtx, opts: GenerateFromImageOpts): Promise<string>
}
