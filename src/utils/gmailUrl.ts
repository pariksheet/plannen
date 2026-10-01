export const GMAIL_WEB_BASE = 'https://mail.google.com/mail/u/0/#inbox/'

/**
 * Link to a Gmail message/thread by id.
 *
 * On Android, an https link opened from the installed PWA lands in a Chrome
 * Custom Tab even when the Gmail app is installed, because Chrome does not
 * hand google.com links off to apps. An `intent://` URL does: it opens the
 * Gmail package directly and falls back to the web URL when Gmail is absent.
 * iOS and desktop keep the plain web URL (iOS universal links already route
 * to the Gmail app where installed).
 */
export function gmailMessageUrl(messageId: string, userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const id = encodeURIComponent(messageId)
  const web = `${GMAIL_WEB_BASE}${id}`
  if (!/android/i.test(userAgent)) return web
  return `intent://mail.google.com/mail/u/0/#inbox/${id}#Intent;scheme=https;package=com.google.android.gm;S.browser_fallback_url=${encodeURIComponent(web)};end`
}
