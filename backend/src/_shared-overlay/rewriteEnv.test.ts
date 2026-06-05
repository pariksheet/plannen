import { describe, it, expect } from 'vitest'
import { rewriteEnvKey } from './rewriteEnv.js'

describe('rewriteEnvKey', () => {
  it('updates an existing key in place', () => {
    const text = 'A=1\nPLANNEN_USER_EMAIL=old@x.com\nB=2\n'
    expect(rewriteEnvKey(text, 'PLANNEN_USER_EMAIL', 'new@x.com')).toBe(
      'A=1\nPLANNEN_USER_EMAIL=new@x.com\nB=2\n',
    )
  })

  it('appends the key if it is missing, preserving the trailing newline', () => {
    const text = 'A=1\nB=2\n'
    expect(rewriteEnvKey(text, 'PLANNEN_USER_EMAIL', 'new@x.com')).toBe(
      'A=1\nB=2\nPLANNEN_USER_EMAIL=new@x.com\n',
    )
  })

  it('appends the key when there is no trailing newline', () => {
    expect(rewriteEnvKey('A=1', 'PLANNEN_USER_EMAIL', 'new@x.com')).toBe(
      'A=1\nPLANNEN_USER_EMAIL=new@x.com',
    )
  })

  it('handles an empty file', () => {
    // Empty string split('\n') = [''], so we treat the lone empty slot as the
    // trailing-newline edge — append before it.
    expect(rewriteEnvKey('', 'PLANNEN_USER_EMAIL', 'new@x.com')).toBe('PLANNEN_USER_EMAIL=new@x.com\n')
  })

  it('does not affect lines that contain the key as a substring', () => {
    const text = 'NOT_PLANNEN_USER_EMAIL=foo\nPLANNEN_USER_EMAIL=old\n'
    expect(rewriteEnvKey(text, 'PLANNEN_USER_EMAIL', 'new')).toBe(
      'NOT_PLANNEN_USER_EMAIL=foo\nPLANNEN_USER_EMAIL=new\n',
    )
  })

  it('preserves comments and blank lines', () => {
    const text = '# comment\n\nPLANNEN_USER_EMAIL=old\n# end\n'
    expect(rewriteEnvKey(text, 'PLANNEN_USER_EMAIL', 'new')).toBe(
      '# comment\n\nPLANNEN_USER_EMAIL=new\n# end\n',
    )
  })
})
