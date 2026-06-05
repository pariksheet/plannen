// Side-effect module: load <repo-root>/.env into process.env BEFORE any other
// import that reads env vars (e.g. db.ts, userResolver.ts).
//
// ESM evaluates all imports in topological order *before* the importing
// module's body runs. So if index.ts puts `loadDotenv()` as a statement at the
// top of its body, db.ts (imported above) has already thrown by then. Moving
// the dotenv call into a module's body makes it run when *this* module is
// evaluated — which we then make the first import in db.ts, ensuring .env is
// loaded before any env reads.
//
// Existing process.env wins (claude mcp add -e ... takes precedence); dotenv
// only fills gaps.

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { config as loadDotenv } from 'dotenv'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dirname, '../../.env')
if (existsSync(envPath)) {
  loadDotenv({ path: envPath })
}
