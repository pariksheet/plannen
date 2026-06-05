#!/usr/bin/env node
// Thin entry point invoked by scripts/bootstrap.sh after step 7 to keep
// the active profile's manifest.mode in sync with its env file's
// PLANNEN_TIER. The same logic powers `plannen profile sync-mode`.
//
// Silent + tolerant by design: no active profile → exit 0 (legacy direct
// `bash scripts/bootstrap.sh` invocations don't have profile state yet).

import { resolveActiveProfile, syncManifestMode } from '../../cli/lib/profiles.mjs';

const name = process.argv[2] || resolveActiveProfile(process.env);
if (!name) process.exit(0);

const result = syncManifestMode({ name });
if (result.changed) {
  process.stdout.write(`profile '${name}' mode: ${result.before} → ${result.after}\n`);
}
