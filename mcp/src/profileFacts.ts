export type FactSource = 'agent_inferred' | 'user_stated'

export function initialConfidence(source: FactSource): number {
  return source === 'user_stated' ? 1.0 : 0.7
}

export function computeCorroborationConfidence(current: number): number {
  return Math.min(1.0, current + 0.1)
}

export function computeContradictionConfidence(current: number): number {
  return Math.max(0.0, current - 0.3)
}

export function shouldMarkHistorical(confidence: number): boolean {
  return confidence < 0.4
}
