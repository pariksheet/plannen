# Operating Plannen

## Auto-start at login (macOS)

Drop this LaunchAgent at `~/Library/LaunchAgents/com.plannen.start.plist`, then `launchctl load ~/Library/LaunchAgents/com.plannen.start.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.plannen.start</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd /absolute/path/to/plannen && npx plannen up --no-dev</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/.plannen/start.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/.plannen/start.log</string>
</dict>
</plist>
```

Drop `--no-dev` to also start the web dev server on login.

## Troubleshooting

**`local_pg` — Postgres won't come up on 54322.** Check `~/.plannen/pg.log`. If something else is bound to 54322 (e.g., a stale `local_sb` Docker container), stop it: `supabase stop --project-id plannen` then `npx plannen up`.

**`local_pg` — backend says `ECONNREFUSED 127.0.0.1:54322`.** Postgres died (e.g., laptop sleep). `npx plannen down && npx plannen up`.

**`local_sb` — `supabase start` fails on Colima.** Expose the docker socket: `colima start --network-address` plus `colima ssh -- sudo systemctl restart docker`. Some setups also need `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`.

**MCP doesn't start when Claude Code is launched as a GUI app.** The plugin manifest uses bare `node`, which isn't found if you installed Node via NVM and Claude Code doesn't inherit your shell PATH. Workaround: `sudo ln -s "$(which node)" /usr/local/bin/node`.

**`/plannen-doctor` says functions-serve is dead (`local_sb`).** `bash scripts/functions-start.sh` (idempotent). Check `.plannen/functions.log` for the error.

**`cloud_sb` — rotate the MCP bearer.** `bash scripts/mcp-rotate-bearer.sh` updates the cloud secret and local files.

**`cloud_sb` — ad-hoc health check.** `node scripts/cloud-doctor.mjs`.
