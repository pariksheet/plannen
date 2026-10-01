import { describe, it, expect } from 'vitest'
import { gmailMessageUrl, GMAIL_WEB_BASE } from './gmailUrl'

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'

describe('gmailMessageUrl', () => {
  it('desktop: plain Gmail web URL for the message', () => {
    expect(gmailMessageUrl('abc123', DESKTOP_UA)).toBe(`${GMAIL_WEB_BASE}abc123`)
  })

  it('iOS: plain Gmail web URL (Gmail iOS has no message deep link; app hand-off would lose the message)', () => {
    expect(gmailMessageUrl('abc123', IOS_UA)).toBe(`${GMAIL_WEB_BASE}abc123`)
  })

  it('android: intent:// URL targeting the Gmail package, with a web fallback', () => {
    const url = gmailMessageUrl('abc123', ANDROID_UA)
    expect(url.startsWith('intent://mail.google.com/mail/u/0/#inbox/abc123#Intent;')).toBe(true)
    expect(url).toContain('scheme=https')
    expect(url).toContain('package=com.google.android.gm')
    expect(url).toContain(`S.browser_fallback_url=${encodeURIComponent(`${GMAIL_WEB_BASE}abc123`)}`)
    expect(url.endsWith(';end')).toBe(true)
  })

  it('encodes the message id so it cannot inject intent parameters', () => {
    const url = gmailMessageUrl('x;package=evil', ANDROID_UA)
    expect(url).not.toContain('package=evil')
  })
})
