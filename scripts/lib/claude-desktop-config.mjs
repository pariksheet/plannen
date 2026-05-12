#!/usr/bin/env node
// Merge a `plannen` MCP entry into Claude Desktop's claude_desktop_config.json.
// Idempotent — re-running rewrites the same values. Existing mcpServers entries
// from other tools are preserved. The original file is backed up with a
// timestamp suffix before any write.
//
// Required env vars:
//   CONFIG_PATH                  absolute path to claude_desktop_config.json
//   MCP_SERVER_PATH              absolute path to mcp/dist/index.js
//   SUPABASE_URL                 e.g. http://127.0.0.1:54321
//   SUPABASE_SERVICE_ROLE_KEY    service role key
//   PLANNEN_USER_EMAIL           user's email
//
// Exits 0 on success, prints a one-line status to stdout. Prints a diagnostic
// to stderr and exits non-zero on failure.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

const required = [
  "CONFIG_PATH",
  "MCP_SERVER_PATH",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PLANNEN_USER_EMAIL",
];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`missing required env var: ${k}`);
    process.exit(1);
  }
}

const CONFIG_PATH = process.env.CONFIG_PATH;
const desired = {
  command: "node",
  args: [process.env.MCP_SERVER_PATH],
  env: {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    PLANNEN_USER_EMAIL: process.env.PLANNEN_USER_EMAIL,
  },
};

let existing = {};
let fileExisted = false;
if (existsSync(CONFIG_PATH)) {
  fileExisted = true;
  const raw = readFileSync(CONFIG_PATH, "utf8").trim();
  if (raw.length > 0) {
    try {
      existing = JSON.parse(raw);
    } catch (err) {
      console.error(`existing ${CONFIG_PATH} is not valid JSON: ${err.message}`);
      console.error("aborting to avoid clobbering — fix the file or remove it and re-run");
      process.exit(1);
    }
  }
}

if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
  console.error(`existing ${CONFIG_PATH} is not a JSON object — refusing to overwrite`);
  process.exit(1);
}

const before = existing.mcpServers?.plannen;
const alreadyEqual =
  before &&
  before.command === desired.command &&
  Array.isArray(before.args) &&
  before.args.length === desired.args.length &&
  before.args.every((a, i) => a === desired.args[i]) &&
  before.env &&
  Object.keys(desired.env).every((k) => before.env[k] === desired.env[k]);

if (alreadyEqual) {
  console.log(`unchanged: ${CONFIG_PATH} already has plannen entry with matching values`);
  process.exit(0);
}

// Back up before any write — only if the file existed.
if (fileExisted) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${CONFIG_PATH}.bak.${stamp}`;
  copyFileSync(CONFIG_PATH, backup);
  console.log(`backed up existing config to ${backup}`);
}

if (!existing.mcpServers || typeof existing.mcpServers !== "object") {
  existing.mcpServers = {};
}
existing.mcpServers.plannen = desired;

mkdirSync(dirname(CONFIG_PATH), { recursive: true });
writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n", "utf8");

const action = before ? "updated" : "added";
console.log(`${action} plannen entry in ${CONFIG_PATH}`);
