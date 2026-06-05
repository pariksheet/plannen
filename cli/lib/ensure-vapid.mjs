// Idempotent VAPID-key generation for Web Push.
//
// Reads VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY from the profile env. If either
// is missing, generates a fresh keypair via web-push and writes all three
// (public, private, subject) to the env file. Already-set values are left
// alone — this is safe to call from `init` on every run.

import { envGet, envSet } from './init-helpers.mjs';

/**
 * @param {object} opts
 * @param {string} opts.envFile  Absolute path to the profile env file
 * @param {string} opts.email    User email (used to default VAPID_SUBJECT)
 * @param {{ step?: (s: string) => void, ok?: (s: string) => void, dim?: (s: string) => void, warn?: (s: string) => void }} [opts.log]
 * @returns {Promise<{ generated: boolean, public: string }>}
 */
export async function ensureVapidKeys({ envFile, email, log }) {
  const existingPub = envGet(envFile, 'VAPID_PUBLIC_KEY');
  const existingPriv = envGet(envFile, 'VAPID_PRIVATE_KEY');
  if (existingPub && existingPriv) {
    log?.ok?.(`VAPID keys already present in ${envFile.split('/').slice(-3).join('/')}`);
    return { generated: false, public: existingPub };
  }
  let webpush;
  try {
    const mod = await import('web-push');
    webpush = mod.default ?? mod;
  } catch (err) {
    log?.warn?.(`web-push not installed at repo root — skipping VAPID generation (${err.message})`);
    return { generated: false, public: existingPub ?? '' };
  }
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  envSet(envFile, 'VAPID_PUBLIC_KEY', publicKey);
  envSet(envFile, 'VAPID_PRIVATE_KEY', privateKey);
  if (!envGet(envFile, 'VAPID_SUBJECT')) {
    envSet(envFile, 'VAPID_SUBJECT', `mailto:${email}`);
  }
  log?.ok?.('Generated VAPID keys for Web Push (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT)');
  return { generated: true, public: publicKey };
}
