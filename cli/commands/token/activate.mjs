import { defineCommand } from 'citty';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveActiveProfile,
  composeEnv,
  getProfileEnvPath,
  readEnvFile,
  writeEnvFile,
} from '../../lib/profiles.mjs';
import { looksLikePat } from '../../../scripts/lib/userTokens.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

function defaultRewritePluginJson(env) {
  const r = spawnSync('bash', ['scripts/mcp-mode.sh', 'http'], {
    cwd: REPO_ROOT, env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.status !== 0) throw new Error(`mcp-mode.sh exited ${r.status}`);
}

export async function runTokenActivate(args, ctx = {}) {
  const pat = String(args.pat ?? '').trim();
  if (!pat.startsWith('plnnn_')) {
    throw new Error('PAT must start with plnnn_ (got: ' + (pat.slice(0, 8) || 'empty') + '…)');
  }
  if (!looksLikePat(pat)) {
    throw new Error('PAT length is wrong (expected ~49 chars)');
  }

  const env = ctx.env ?? process.env;
  const profile = ctx.profile ?? resolveActiveProfile(env) ?? 'default';
  const envPath = getProfileEnvPath(profile, env);
  const current = readEnvFile(envPath);
  current.MCP_BEARER_TOKEN = pat;
  writeEnvFile(envPath, current);

  const composed = composeEnv(profile, {}, env);
  const rewrite = ctx.rewritePluginJson ?? defaultRewritePluginJson;
  rewrite({ ...process.env, ...composed, MCP_BEARER_TOKEN: pat });

  const log = ctx.log ?? console;
  log.info?.(`PAT activated for profile "${profile}".`);
  log.info?.('Reload the plannen plugin in Claude Code to pick it up.');
}

export const tokenActivateCommand = defineCommand({
  meta: { name: 'activate', description: 'Wire a PAT (from /settings) into the active profile + plugin.json' },
  args: { pat: { type: 'positional', required: true } },
  async run({ args }) { await runTokenActivate(args, {}); },
});
