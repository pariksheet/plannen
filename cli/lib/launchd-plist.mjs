export const PLANNEN_SCHEDULE_HOURS = [0, 4, 8, 12, 16, 20]

export function buildPlist({ label, wrapperPath, profile, homeDir, pathEnv }) {
  const hours = PLANNEN_SCHEDULE_HOURS.map((h) => `    <dict>
      <key>Hour</key>
      <integer>${h}</integer>
      <key>Minute</key>
      <integer>0</integer>
    </dict>`)
  // RunAtLoad fires the job whenever launchd loads the plist — i.e. on cold boot
  // (laptop powered on after being shut down through a scheduled window) and on
  // every `launchctl bootstrap` from `npx plannen mailbox install`. The atomic
  // mkdir lock in scripts/mailbox/sync-wrapper.sh + ThrottleInterval=3600 keep
  // install-time and wake-up firings from doubling up.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>${wrapperPath}</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
${hours.join('\n')}
  </array>
  <key>ThrottleInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${homeDir}/.plannen/logs/mailbox-sync.log</string>
  <key>StandardErrorPath</key>
  <string>${homeDir}/.plannen/logs/mailbox-sync.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PLANNEN_PROFILE</key>
    <string>${profile}</string>
    <key>PATH</key>
    <string>${pathEnv}</string>
  </dict>
</dict>
</plist>
`
}
