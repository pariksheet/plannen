// Temporary stub. Replaced by the real subprocess-backed provider in Task 5.
// Throws on every method call — onboarding never wires `claude-code-cli` until
// the real impl lands, so this code path should be unreachable in practice.

import type { HandlerCtx } from '../handlers/types.js'
import type { AISettings } from '../ai.js'
import { AIError } from '../ai.js'
import type {
  AIProvider,
  GenerateOpts,
  GenerateStructuredOpts,
  GenerateFromImageOpts,
} from './types.js'

export function claudeCliProvider(_s: AISettings): AIProvider {
  const die = (): never => {
    throw new AIError('no_provider_configured', 'CLI provider not wired yet')
  }
  return {
    async generate(_ctx: HandlerCtx, _opts: GenerateOpts): Promise<string> { return die() },
    async generateStructured<T>(_ctx: HandlerCtx, _opts: GenerateStructuredOpts<T>): Promise<T> { return die() },
    async generateFromImage(_ctx: HandlerCtx, _opts: GenerateFromImageOpts): Promise<string> { return die() },
  }
}
