import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { health } from './health.js'
import { pool } from './db.js'
import { resolveUserAtBoot } from './auth.js'
import { setIdentity, getIdentity } from './_shared/identity.js'
import { errorHandler } from './middleware/error.js'
import { corsMiddleware } from './middleware/cors.js'
import { me } from './routes/api/me.js'
import { events } from './routes/api/events.js'
import { memories } from './routes/api/memories.js'
import { eventNotes } from './routes/api/event-notes.js'
import { stories } from './routes/api/stories.js'
import { profile } from './routes/api/profile.js'
import { relationships } from './routes/api/relationships.js'
import { locations } from './routes/api/locations.js'
import { sources } from './routes/api/sources.js'
import { watch } from './routes/api/watch.js'
import { rsvp } from './routes/api/rsvp.js'
import { visitPreference } from './routes/api/visit-preference.js'
import { groups } from './routes/api/groups.js'
import { wishlist } from './routes/api/wishlist.js'
import { settings } from './routes/api/settings.js'
import { agentTasks } from './routes/api/agentTasks.js'
import { practices } from './routes/api/practices.js'
import { checklists } from './routes/api/checklists.js'
import { scheduling } from './routes/api/scheduling.js'
import { briefings } from './routes/api/briefings.js'
import { mailboxIgnoreRules } from './routes/api/mailbox-ignore-rules.js'
import { eventProvenance } from './routes/api/event-provenance.js'
import { push } from './routes/api/push.js'
import { eventPhotos } from './routes/storage/eventPhotos.js'
import { agentTest } from './routes/functions/agentTest.js'
import { agentDiscover } from './routes/functions/agentDiscover.js'
import { agentExtractImage } from './routes/functions/agentExtractImage.js'
import { agentScrape } from './routes/functions/agentScrape.js'
import { memoryImage } from './routes/functions/memoryImage.js'
import { pickerSessionCreate } from './routes/functions/pickerSessionCreate.js'
import { pickerSessionPoll } from './routes/functions/pickerSessionPoll.js'
import { getGoogleAccessToken } from './routes/functions/getGoogleAccessToken.js'
import { getGoogleAuthUrl } from './routes/functions/getGoogleAuthUrl.js'
import { googleOauthCallback } from './routes/functions/googleOauthCallback.js'
import { sendInviteEmail } from './routes/functions/sendInviteEmail.js'
import { notify } from './routes/functions/notify.js'
import { detectClaudeCli } from './_shared/cliDetection.js'
import { defaultRunCli } from './_shared/providers/run-cli.js'
import { maybeAutoConfigureCliProvider } from './_shared/maybeAutoConfigureCliProvider.js'
import type { AppVariables } from './types.js'

const PORT = Number(process.env.PLANNEN_BACKEND_PORT ?? 54323)
const HOST = '127.0.0.1'
const USER_EMAIL = process.env.PLANNEN_USER_EMAIL
if (!USER_EMAIL) {
  console.error('PLANNEN_USER_EMAIL is required (set by bootstrap.sh)')
  process.exit(1)
}

const bootUser = await resolveUserAtBoot(USER_EMAIL)
setIdentity(bootUser)
console.log(`resolved user: ${bootUser.email} (${bootUser.userId})`)

if (process.env.PLANNEN_TIER === '0') {
  const detection = await detectClaudeCli(defaultRunCli)
  if (detection.available) {
    await maybeAutoConfigureCliProvider(pool, bootUser.userId, detection.version)
  }
}

const app = new Hono<{ Variables: AppVariables }>()

app.onError(errorHandler)
app.use('*', corsMiddleware)
app.use('*', async (c, next) => {
  // Read fresh on each request so POST /api/me can swap the identity at
  // runtime (web-UI signup) without restarting the backend.
  const id = getIdentity()
  c.set('pool', pool)
  c.set('userId', id.userId)
  c.set('userEmail', id.email)
  await next()
})

app.route('/', health)
app.route('/api/me', me)
app.route('/api/events', events)
app.route('/api/memories', memories)
app.route('/api/event-notes', eventNotes)
app.route('/api/stories', stories)
app.route('/api/profile', profile)
app.route('/api/relationships', relationships)
app.route('/api/locations', locations)
app.route('/api/sources', sources)
app.route('/api/watch', watch)
app.route('/api/rsvp', rsvp)
app.route('/api/visit-preference', visitPreference)
app.route('/api/groups', groups)
app.route('/api/wishlist', wishlist)
app.route('/api/settings', settings)
app.route('/api/agent-tasks', agentTasks)
app.route('/api/practices', practices)
app.route('/api/checklists', checklists)
app.route('/api/scheduling', scheduling)
app.route('/api/briefings', briefings)
app.route('/api/mailbox-ignore-rules', mailboxIgnoreRules)
app.route('/api/event-provenance', eventProvenance)
app.route('/api/push', push)
app.route('/storage/v1/object', eventPhotos)

// /functions/v1/* — pure handlers extracted from `supabase/functions/<name>`.
app.route('/functions/v1/agent-test', agentTest)
app.route('/functions/v1/agent-discover', agentDiscover)
app.route('/functions/v1/agent-extract-image', agentExtractImage)
app.route('/functions/v1/agent-scrape', agentScrape)
app.route('/functions/v1/memory-image', memoryImage)
app.route('/functions/v1/picker-session-create', pickerSessionCreate)
app.route('/functions/v1/picker-session-poll', pickerSessionPoll)
app.route('/functions/v1/get-google-access-token', getGoogleAccessToken)
app.route('/functions/v1/get-google-auth-url', getGoogleAuthUrl)
app.route('/functions/v1/google-oauth-callback', googleOauthCallback)
app.route('/functions/v1/send-invite-email', sendInviteEmail)
app.route('/functions/v1/notify', notify)

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`backend listening on http://${info.address}:${info.port}`)
})

const shutdown = async () => {
  console.log('shutting down')
  await pool.end()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
