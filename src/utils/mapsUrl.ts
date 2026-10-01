/**
 * Google Maps "search" deep link in the documented Maps URLs form
 * (https://developers.google.com/maps/documentation/urls/get-started#search-action).
 *
 * `api=1&query=` is what the Maps app on Android/iOS accepts; the older
 * `?q=` shortcut opens Maps but the app then reports an invalid link.
 */
export function mapsSearchUrl(location: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`
}
