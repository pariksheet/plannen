import { describe, it, expect } from 'vitest'
// @ts-ignore — .mjs module
import { formatProjectMenu, parseSelection, pick } from '../../scripts/lib/cloud-project-picker.mjs'

const SAMPLE = [
  { id: 'a', ref: 'aaaa1111aaaa1111aaaa', name: 'plannen', region: 'eu-central-1' },
  { id: 'b', ref: 'bbbb2222bbbb2222bbbb', name: 'other', region: 'us-east-1' },
]

describe('formatProjectMenu', () => {
  it('renders a numbered list with name, ref, region', () => {
    const out = formatProjectMenu(SAMPLE)
    expect(out).toContain('1) plannen (aaaa1111aaaa1111aaaa, eu-central-1)')
    expect(out).toContain('2) other (bbbb2222bbbb2222bbbb, us-east-1)')
  })

  it('handles an empty list', () => {
    expect(formatProjectMenu([])).toMatch(/no projects/i)
  })
})

describe('parseSelection', () => {
  it('returns the project for a valid 1-based index', () => {
    const p = parseSelection('2', SAMPLE)
    expect(p.ref).toBe('bbbb2222bbbb2222bbbb')
  })

  it('trims whitespace', () => {
    expect(parseSelection('  1\n', SAMPLE).name).toBe('plannen')
  })

  it('throws on out-of-range', () => {
    expect(() => parseSelection('3', SAMPLE)).toThrow(/out of range/i)
    expect(() => parseSelection('0', SAMPLE)).toThrow(/out of range/i)
  })

  it('throws on non-numeric', () => {
    expect(() => parseSelection('hello', SAMPLE)).toThrow(/numeric/i)
  })
})

describe('pick', () => {
  it('writes the menu then resolves the selected project', async () => {
    const written: string[] = []
    const p = await pick(SAMPLE, {
      write: (s: string) => { written.push(s) },
      read: async () => '1\n',
    })
    expect(p.name).toBe('plannen')
    expect(written.join('')).toContain('1) plannen')
  })

  it('re-prompts on invalid input until a valid choice is given', async () => {
    const reads = ['bogus\n', '99\n', '2\n']
    const p = await pick(SAMPLE, {
      write: () => {},
      read: async () => reads.shift()!,
    })
    expect(p.name).toBe('other')
  })

  it('auto-selects when there is only one project (no prompt)', async () => {
    const written: string[] = []
    let reads = 0
    const p = await pick([SAMPLE[0]], {
      write: (s: string) => { written.push(s) },
      read: async () => { reads++; return '' },
    })
    expect(p.ref).toBe('aaaa1111aaaa1111aaaa')
    expect(reads).toBe(0) // never prompted
    expect(written.join('')).toMatch(/auto-selecting/i)
  })

  it('treats empty Enter as a silent re-prompt (no noisy error)', async () => {
    const written: string[] = []
    const reads = ['\n', '   \n', '1\n']
    const p = await pick(SAMPLE, {
      write: (s: string) => { written.push(s) },
      read: async () => reads.shift()!,
    })
    expect(p.name).toBe('plannen')
    // The "must be numeric" error must NOT have fired for the empty lines.
    expect(written.join('')).not.toMatch(/must be numeric/i)
  })
})
