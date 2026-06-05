import { describe, it, expect } from 'vitest'
import {
  computeCorroborationConfidence,
  computeContradictionConfidence,
  shouldMarkHistorical,
  initialConfidence,
} from './profileFacts.js'

describe('initialConfidence', () => {
  it('returns 0.7 for agent_inferred', () => {
    expect(initialConfidence('agent_inferred')).toBe(0.7)
  })
  it('returns 1.0 for user_stated', () => {
    expect(initialConfidence('user_stated')).toBe(1.0)
  })
})

describe('computeCorroborationConfidence', () => {
  it('increases confidence by 0.1', () => {
    expect(computeCorroborationConfidence(0.7)).toBeCloseTo(0.8)
  })
  it('caps at 1.0', () => {
    expect(computeCorroborationConfidence(0.95)).toBe(1.0)
  })
  it('caps at 1.0 when already at 1.0', () => {
    expect(computeCorroborationConfidence(1.0)).toBe(1.0)
  })
})

describe('computeContradictionConfidence', () => {
  it('decreases confidence by 0.3', () => {
    expect(computeContradictionConfidence(0.7)).toBeCloseTo(0.4)
  })
  it('floors at 0.0', () => {
    expect(computeContradictionConfidence(0.2)).toBe(0.0)
  })
})

describe('shouldMarkHistorical', () => {
  it('returns true when confidence < 0.4', () => {
    expect(shouldMarkHistorical(0.39)).toBe(true)
  })
  it('returns false when confidence >= 0.4', () => {
    expect(shouldMarkHistorical(0.4)).toBe(false)
  })
})
