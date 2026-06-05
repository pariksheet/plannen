// JS port of scripts/lib/bootstrap-helpers.sh — pure helpers used by
// cli/lib/init.mjs (the orchestrator). Mirrors bash behaviour line-for-line so
// the migration from `bash scripts/bootstrap.sh` to `node bin/plannen.mjs init`
// preserves dotenv semantics, version-check semantics, and user-visible output.
//
// Anything new should match the bash original — when something here drifts from
// scripts/lib/bootstrap-helpers.sh, the bash one is the spec.

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ── Output ────────────────────────────────────────────────────────────────────

// Bash colorizes only when stdout is a tty. Node's process.stdout.isTTY is the
// same signal. Cached at module load so tests can mock by setting it before
// importing — though most tests inject a custom `log` instead and never hit
// these.
function isTty() {
  return Boolean(process.stdout && process.stdout.isTTY);
}

function colors() {
  if (isTty()) {
    return {
      reset: '\x1b[0m',
      dim: '\x1b[2m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      red: '\x1b[31m',
      cyan: '\x1b[36m',
    };
  }
  return { reset: '', dim: '', green: '', yellow: '', red: '', cyan: '' };
}

export function step(msg, write = (s) => process.stdout.write(s)) {
  const c = colors();
  write(`\n${c.cyan}==> ${msg}${c.reset}\n`);
}

export function ok(msg, write = (s) => process.stdout.write(s)) {
  const c = colors();
  write(`  ${c.green}✓${c.reset} ${msg}\n`);
}

export function warn(msg, write = (s) => process.stderr.write(s)) {
  const c = colors();
  write(`  ${c.yellow}⚠${c.reset} ${msg}\n`);
}

export function err(msg, write = (s) => process.stderr.write(s)) {
  const c = colors();
  write(`  ${c.red}✗${c.reset} ${msg}\n`);
}

export function dim(msg, write = (s) => process.stdout.write(s)) {
  const c = colors();
  write(`  ${c.dim}${msg}${c.reset}\n`);
}

// Expose the colour palette so the orchestrator's final printout can embed
// `${C_GREEN}...${C_RESET}` style snippets the way bootstrap.sh does.
export function colorPalette() {
  return colors();
}

// ── dotenv I/O ────────────────────────────────────────────────────────────────

/**
 * Read a key out of a dotenv file. Strips surrounding quotes. Returns null
 * (not '') when missing — `'' is the legitimate value for an empty assignment.
 * Skips comment lines beginning with `#`.
 */
export function envGet(filePath, key) {
  if (!existsSync(filePath)) return null;
  const text = readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    if (k !== key) continue;
    let v = line.slice(eq + 1).trim();
    // Strip a matched pair of surrounding " or '.
    if (v.length >= 2) {
      const first = v[0];
      const last = v[v.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        v = v.slice(1, -1);
      }
    }
    return v;
  }
  return null;
}

/**
 * Set a key in a dotenv file in place. Replaces an existing line, otherwise
 * appends. Creates the file if missing. No quoting — bash env_set writes the
 * raw value too.
 */
export function envSet(filePath, key, value) {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, '', { encoding: 'utf8' });
  }
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  // Bash uses `grep -qE "^${key}="` — match at start of line, key followed
  // immediately by `=`. Whitespace around `=` is NOT tolerated, mirroring bash.
  const matchPrefix = `${key}=`;
  let replaced = false;
  const next = lines.map((line) => {
    if (line.startsWith(matchPrefix)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (replaced) {
    // Preserve the original trailing-newline shape.
    writeFileSync(filePath, next.join('\n'), { encoding: 'utf8' });
    return;
  }
  // Append. Bash does `printf "%s=%s\n"` — guaranteed trailing newline. Add a
  // leading newline only when the file is non-empty and missing one, so a
  // freshly-touched empty file doesn't get a blank first line.
  const needsNl = text.length > 0 && !text.endsWith('\n');
  appendFileSync(filePath, `${needsNl ? '\n' : ''}${key}=${value}\n`, 'utf8');
}

/**
 * Merge missing keys from <template> into <target>. If target is missing,
 * copy template wholesale (preserving comments + blanks). Otherwise, for every
 * KEY in template that target lacks, append `KEY=<template-default>` to target.
 */
export function mergeEnv(templatePath, targetPath) {
  if (!existsSync(targetPath)) {
    copyFileSync(templatePath, targetPath);
    return;
  }
  const template = readFileSync(templatePath, 'utf8');
  const targetText = readFileSync(targetPath, 'utf8');
  for (const rawLine of template.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    // bash uses `grep -qE "^${key}="`
    const re = new RegExp(`^${escapeRegExp(key)}=`, 'm');
    if (re.test(targetText)) continue;
    const defaultVal = envGet(templatePath, key) ?? '';
    appendFileSync(targetPath, `${key}=${defaultVal}\n`, 'utf8');
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Versions ──────────────────────────────────────────────────────────────────

/**
 * Semver-ish "have >= need". Strips all non-digit/non-dot chars, takes only the
 * first three components, missing components default to 0. Mirrors the bash
 * version_ge exactly (which uses awk -F. with trailing 0 fill).
 */
export function versionGe(have, need) {
  const parse = (s) => {
    const digits = String(s ?? '').replace(/[^0-9.]/g, '');
    const parts = digits.split('.');
    const a = Number(parts[0] || 0);
    const b = Number(parts[1] || 0);
    const c = Number(parts[2] || 0);
    return [
      Number.isFinite(a) ? a : 0,
      Number.isFinite(b) ? b : 0,
      Number.isFinite(c) ? c : 0,
    ];
  };
  const [h1, h2, h3] = parse(have);
  const [n1, n2, n3] = parse(need);
  if (h1 !== n1) return h1 > n1;
  if (h2 !== n2) return h2 > n2;
  return h3 >= n3;
}

/**
 * Confirm a binary is present + new enough.
 *   - bin: command name
 *   - min: minimum semver-ish string
 *   - extract: optional [cmd, ...args] to run; defaults to [bin, '--version']
 *   - hint: install-help text emitted to dim() on failure
 *   - log: { ok, err, warn, dim } overrides (default: this module's helpers)
 *
 * Returns true on success, false on failure (and writes diagnostics). Matches
 * bash `require_version` exit-status semantics.
 */
export function requireVersion({ bin, min, extract, hint, log = {}, run } = {}) {
  const okFn = log.ok ?? ok;
  const errFn = log.err ?? err;
  const warnFn = log.warn ?? warn;
  const dimFn = log.dim ?? dim;
  const runner = run ?? defaultSpawn;
  const cmd = extract ?? [bin, '--version'];

  // `which <cmd>` — real binary, no shell needed (avoids DEP0190).
  const probe = runner('which', [bin]);
  if ((probe.status ?? 1) !== 0) {
    errFn(`${bin} not found`);
    if (hint) dimFn(hint);
    return false;
  }
  const r = runner(cmd[0], cmd.slice(1), { encoding: 'utf8', shell: false });
  const head3 = ((r.stdout ?? '') + (r.stderr ?? ''))
    .split('\n')
    .slice(0, 3)
    .join('\n');
  const m = head3.match(/([0-9]+\.[0-9]+(?:\.[0-9]+)?)/);
  if (!m) {
    warnFn(`${bin}: couldn't parse version from: ${head3.trim()}`);
    return true;
  }
  if (versionGe(m[1], min)) {
    okFn(`${bin} ${m[1]}`);
    return true;
  }
  errFn(`${bin} ${m[1]} is too old; need >= ${min}`);
  if (hint) dimFn(hint);
  return false;
}

/**
 * Verify a usable docker daemon. Mirrors bash require_docker_running.
 * Returns true on success, false otherwise (with diagnostics).
 */
export function requireDockerRunning({ run, log = {} } = {}) {
  const errFn = log.err ?? err;
  const dimFn = log.dim ?? dim;
  const okFn = log.ok ?? ok;
  const runner = run ?? defaultSpawn;
  const cliProbe = runner('which', ['docker']);
  if ((cliProbe.status ?? 1) !== 0) {
    errFn('docker CLI not found');
    dimFn('macOS:    brew install --cask docker      (Docker Desktop)');
    dimFn('          brew install colima docker      (Colima — open-source)');
    dimFn('          brew install --cask orbstack    (OrbStack)');
    dimFn('Linux:    install Docker Engine, or podman with docker-compat');
    dimFn('WSL2:     same as Linux above');
    return false;
  }
  const info = runner('docker', ['info'], { encoding: 'utf8' });
  if ((info.status ?? 1) !== 0) {
    errFn('docker daemon is not reachable');
    dimFn('Start your container runtime:');
    dimFn('  Docker Desktop / OrbStack / Rancher Desktop:  open the app');
    dimFn('  Colima:                                       colima start');
    dimFn('  podman:                                       podman machine start');
    return false;
  }
  okFn('docker daemon reachable');
  return true;
}

function defaultSpawn(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

// ── Misc ──────────────────────────────────────────────────────────────────────

export function lower(s) {
  return String(s ?? '').toLowerCase();
}

/**
 * Returns true if the pid file holds a live PID. Bash:
 *   `[ -f file ] && pid=$(cat file) && [ -n "$pid" ] && kill -0 "$pid"`.
 */
export function pidAlive(pidfilePath) {
  if (!existsSync(pidfilePath)) return false;
  let pid;
  try {
    pid = readFileSync(pidfilePath, 'utf8').trim();
  } catch {
    return false;
  }
  if (!pid) return false;
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

// Why: a prior cloud_sb session may have left plugin/.claude-plugin/plugin.json
// in http/cloud transport. When init's target tier is local (0 or 1), MCP must
// be stdio so it reads DATABASE_URL from .env and follows the active profile.
// The previous call site gated on `oldTier === '2'`, which missed the case
// where http/cloud got written without a corresponding env tier flip.
export function reconcileMcpPluginJsonToStdio({
  pluginJsonPath,
  targetTier,
  repoRoot,
  log,
  run,
}) {
  if (String(targetTier) === '2') return { changed: false, reason: 'target-tier-is-cloud' };
  if (!existsSync(pluginJsonPath)) return { changed: false, reason: 'no-plugin-json' };
  const text = readFileSync(pluginJsonPath, 'utf8');
  if (!/"type"\s*:\s*"http"/.test(text)) return { changed: false, reason: 'already-stdio' };
  log.step('7b. Resetting MCP plugin.json to stdio (was http/cloud)');
  const r = run('bash', [path.join(repoRoot, 'scripts/mcp-mode.sh'), 'stdio'], { cwd: repoRoot });
  const status = r?.status ?? 0;
  if (status === 0) {
    log.ok('plugin.json reset to stdio — reload the plannen plugin in Claude Code');
    return { changed: true };
  }
  log.warn(`mcp-mode.sh stdio exited ${status}`);
  return { changed: false, reason: 'mcp-mode-failed', status };
}
