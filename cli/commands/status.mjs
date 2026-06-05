import { defineCommand } from 'citty';
import { probeProc as defaultProbe } from '../lib/ports.mjs';
import { composeEnv, profileExists, resolveActiveProfile } from '../lib/profiles.mjs';

const LOCAL = { pg: 54322, backend: 54323, supabase: 54321, web: 4321 };

const TIER_TO_MODE = { '0': 'local_pg', '1': 'local_sb', '2': 'cloud_sb' };

const NAME_PAD = 12;

function pickEnv(env, names) {
  for (const n of names) if (env[n]) return env[n];
  return null;
}

function parseUrl(raw) {
  try { return new URL(raw); } catch { return null; }
}

function inferPort(u) {
  if (u.port) return Number(u.port);
  if (u.protocol === 'https:') return 443;
  if (u.protocol === 'http:') return 80;
  if (u.protocol === 'postgresql:' || u.protocol === 'postgres:') return 5432;
  return 80;
}

function maskUrl(u) {
  const cleaned = new URL(u.toString());
  cleaned.username = '';
  cleaned.password = '';
  return cleaned.toString().replace(/\/$/, '');
}

function procFromUrl(name, raw, fallbackScheme) {
  const u = parseUrl(raw);
  if (!u) return null;
  return {
    name,
    host: u.hostname,
    port: inferPort(u),
    scheme: fallbackScheme ?? u.protocol.replace(':', ''),
    url: maskUrl(u),
  };
}

function localProc(name, port, scheme = 'http') {
  return { name, host: '127.0.0.1', port, scheme, url: `${scheme}://localhost:${port}` };
}

function unsetProc(name, hint) {
  return { name, host: null, port: null, scheme: null, url: `(set ${hint} in .env)`, configured: false };
}

function processesFor(tier, env) {
  if (tier === '0') {
    return [localProc('pg', LOCAL.pg, 'postgresql'), localProc('backend', LOCAL.backend), localProc('web', LOCAL.web)];
  }
  if (tier === '1') {
    return [localProc('supabase', LOCAL.supabase), localProc('pg', LOCAL.pg, 'postgresql'), localProc('web', LOCAL.web)];
  }
  // tier 2 — read URLs from .env. pg is omitted because it's part of the
  // managed Supabase surface, not a user-controlled process.
  const procs = [];
  const supaRaw = pickEnv(env, ['SUPABASE_URL', 'VITE_SUPABASE_URL']);
  const supaProc = procFromUrl('supabase', supaRaw);
  if (supaProc) {
    // Supabase root HEAD returns 4xx (no welcome page) but the project IS up.
    // okBelow:500 = any HTTP response counts as alive.
    procs.push({ ...supaProc, okBelow: 500 });
  } else {
    procs.push(unsetProc('supabase', 'SUPABASE_URL'));
  }
  // MCP edge function lives at <SUPABASE_URL>/functions/v1/mcp. It only accepts
  // POST, so HEAD returns 405 — okBelow:500 treats that as "up" (function is
  // deployed and routing). 404 still falls through as "down" (not deployed).
  if (supaRaw) {
    const token = pickEnv(env, ['MCP_BEARER_TOKEN']);
    procs.push({
      name: 'mcp',
      host: new URL(supaRaw).hostname,
      port: 443,
      scheme: 'https',
      url: `${supaRaw.replace(/\/+$/, '')}/functions/v1/mcp`,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      okBelow: 500,
    });
  } else {
    procs.push(unsetProc('mcp', 'SUPABASE_URL'));
  }
  procs.push(localProc('web(local)', LOCAL.web));
  const vercelRaw = pickEnv(env, ['PLANNEN_WEB_URL', 'PUBLIC_WEB_URL', 'VITE_APP_URL', 'VERCEL_URL']);
  const vercelFull = vercelRaw && !vercelRaw.startsWith('http') ? `https://${vercelRaw}` : vercelRaw;
  procs.push(procFromUrl('web(vercel)', vercelFull) ?? unsetProc('web(vercel)', 'PLANNEN_WEB_URL'));
  return procs;
}

export async function invokeStatus(rawArgs, ctx = {}) {
  const baseEnv = ctx.env ?? process.env;
  const probe = ctx.probe ?? defaultProbe;
  const out = ctx.out ?? process.stdout;
  const profileName = rawArgs.profile ?? resolveActiveProfile(baseEnv);
  const env = profileName && profileExists(profileName, baseEnv)
    ? composeEnv(profileName, {}, baseEnv)
    : baseEnv;
  const tier = String(env.PLANNEN_TIER ?? '0');
  const mode = TIER_TO_MODE[tier] ?? TIER_TO_MODE['0'];
  const procs = processesFor(tier in TIER_TO_MODE ? tier : '0', env);
  const results = await Promise.all(
    procs.map(async (p) => {
      if (p.configured === false) return { ...p, up: false };
      return { ...p, up: await probe(p, 1500) };
    }),
  );

  if (rawArgs.json) {
    out.write(JSON.stringify({ profile: profileName ?? null, tier, mode, processes: results }, null, 2));
  } else {
    out.write(`profile: ${profileName ?? '(none)'}\n`);
    out.write(`tier: ${tier} (${mode})\n\n`);
    for (const r of results) {
      const state = r.configured === false ? 'n/a ' : r.up ? 'up  ' : 'down';
      out.write(`${r.name.padEnd(NAME_PAD)} ${state} ${r.url}\n`);
    }
  }
  return 0;
}

export const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show what is running for the active profile' },
  args: {
    profile: { type: 'string', description: 'Profile to check (defaults to the active profile)' },
    json: { type: 'boolean', description: 'Emit JSON instead of human-readable lines' },
  },
  async run({ args }) {
    const code = await invokeStatus(args);
    process.exit(code);
  },
});
