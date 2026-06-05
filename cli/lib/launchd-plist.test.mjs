import { describe, it, expect } from 'vitest'
import { buildPlist } from './launchd-plist.mjs'

describe('buildPlist', () => {
  const opts = {
    label: 'work.plannen.mailbox-sync',
    wrapperPath: '/Users/u/Music/plannen/scripts/mailbox/sync-wrapper.sh',
    profile: 'prod',
    homeDir: '/Users/u',
    pathEnv: '/usr/local/bin:/usr/bin:/bin',
  }
  it('contains a StartCalendarInterval entry for the every-4h schedule', () => {
    const xml = buildPlist(opts)
    for (const h of [0, 4, 8, 12, 16, 20]) {
      expect(xml).toContain(`<integer>${h}</integer>`)
    }
  })
  it('does not contain stale hourly entries', () => {
    const xml = buildPlist(opts)
    // 1, 5, 9, 13, 17, 21 are NOT in the new schedule. Look for them as Hour values.
    for (const h of [1, 5, 9, 13, 17, 21]) {
      expect(xml).not.toContain(`<key>Hour</key>\n      <integer>${h}</integer>`)
    }
  })
  it('sets ThrottleInterval=3600', () => {
    expect(buildPlist(opts)).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>3600<\/integer>/)
  })
  it('uses the wrapper path as the only ProgramArgument with bash -lc', () => {
    const xml = buildPlist(opts)
    expect(xml).toContain('<string>/bin/bash</string>')
    expect(xml).toContain('<string>-lc</string>')
    expect(xml).toContain(opts.wrapperPath)
  })
  it('embeds PLANNEN_PROFILE and PATH', () => {
    const xml = buildPlist(opts)
    expect(xml).toContain('<key>PLANNEN_PROFILE</key>')
    expect(xml).toContain('<string>prod</string>')
    expect(xml).toContain('<key>PATH</key>')
    expect(xml).toContain(opts.pathEnv)
  })
  it('sets RunAtLoad=true so missed cadences fire on boot', () => {
    expect(buildPlist(opts)).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
  })
})
