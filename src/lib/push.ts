import { supabase } from './supabase'
import { isTierZero } from './tier'

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  try {
    const reg = await navigator.serviceWorker.ready
    return reg.pushManager.getSubscription()
  } catch {
    return null
  }
}

// ── Endpoint adapters (Tier 0 vs Tier 1/2) ────────────────────────────────────

interface PushEndpoints {
  vapidPublicKey(): Promise<string | null>
  subscribe(payload: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string }): Promise<boolean>
  unsubscribe(endpoint: string): Promise<void>
  test(): Promise<{ sent: number; attempted: number }>
}

const tier0Endpoints: PushEndpoints = {
  async vapidPublicKey() {
    try {
      const res = await fetch('/api/push/vapid-public-key', { credentials: 'include' })
      if (!res.ok) return null
      const body = (await res.json()) as { key: string | null }
      return body.key ?? null
    } catch { return null }
  },
  async subscribe(payload) {
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return res.ok
  },
  async unsubscribe(endpoint) {
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }).catch(() => null)
  },
  async test() {
    const res = await fetch('/api/push/test', { method: 'POST', credentials: 'include' })
    if (!res.ok) return { sent: 0, attempted: 0 }
    const body = (await res.json()) as { sent: number; attempted: number }
    return body
  },
}

const tier1Endpoints: PushEndpoints = {
  async vapidPublicKey() {
    const { data, error } = await supabase.functions.invoke('push-vapid-public-key', { method: 'GET' })
    if (error) return null
    return (data as { key: string | null })?.key ?? null
  },
  async subscribe(payload) {
    const { error } = await supabase.functions.invoke('push-subscribe', {
      method: 'POST',
      body: payload,
    })
    return !error
  },
  async unsubscribe(endpoint) {
    // Edge handler accepts POST as DELETE alias for clients that can't body-DELETE.
    await supabase.functions.invoke('push-unsubscribe', {
      method: 'POST',
      body: { endpoint },
    })
  },
  async test() {
    const { data, error } = await supabase.functions.invoke('push-test', { method: 'POST' })
    if (error) return { sent: 0, attempted: 0 }
    return (data as { sent: number; attempted: number }) ?? { sent: 0, attempted: 0 }
  },
}

function endpoints(): PushEndpoints {
  return isTierZero() ? tier0Endpoints : tier1Endpoints
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface EnableResult {
  ok: boolean
  reason?: 'unsupported' | 'denied' | 'server-not-configured' | 'subscribe-failed' | 'server-error'
}

export async function enablePush(): Promise<EnableResult> {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' }
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return { ok: false, reason: 'denied' }

  const key = await endpoints().vapidPublicKey()
  if (!key) return { ok: false, reason: 'server-not-configured' }

  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      })
    } catch {
      return { ok: false, reason: 'subscribe-failed' }
    }
  }

  const payload = sub.toJSON()
  if (!payload.endpoint || !payload.keys) return { ok: false, reason: 'subscribe-failed' }
  const ok = await endpoints().subscribe({
    endpoint: payload.endpoint,
    keys: { p256dh: payload.keys.p256dh, auth: payload.keys.auth },
    userAgent: navigator.userAgent,
  })
  if (!ok) return { ok: false, reason: 'server-error' }
  return { ok: true }
}

export async function disablePush(): Promise<void> {
  const sub = await getPushSubscription()
  if (!sub) return
  await endpoints().unsubscribe(sub.endpoint).catch(() => null)
  await sub.unsubscribe().catch(() => null)
}

export async function sendTestPush(): Promise<{ ok: boolean; sent: number; attempted: number }> {
  const { sent, attempted } = await endpoints().test()
  return { ok: sent > 0, sent, attempted }
}
