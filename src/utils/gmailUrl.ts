export const GMAIL_WEB_BASE = 'https://mail.google.com/mail/u/0/#inbox/'

/**
 * Link to a Gmail message/thread by id.
 *
 * On Android, an https link opened from the installed PWA lands in a Chrome
 * Custom Tab even when the Gmail app is installed, because Chrome does not
 * hand google.com links off to apps. An `intent://` URL does: it opens the
 * Gmail package directly and falls back to the web URL when Gmail is absent.
 *
 * iOS keeps the plain web URL on purpose: the Gmail iOS app does not claim
 * mail.google.com as a universal link, and its `googlegmail://` scheme only
 * supports compose — the old conversation deep link (`/cv=`) no longer works.
 * Handing off to the app would land on the inbox and lose the message, so the
 * in-app web view of the message is the better outcome there. Desktop keeps
 * the web URL as well.
 */
export function gmailMessageUrl(messageId: string, userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const id = encodeURIComponent(messageId)
  const web = `${GMAIL_WEB_BASE}${id}`
  if (!/android/i.test(userAgent)) return web
  return `intent://mail.google.com/mail/u/0/#inbox/${id}#Intent;scheme=https;package=com.google.android.gm;S.browser_fallback_url=${encodeURIComponent(web)};end`
}
