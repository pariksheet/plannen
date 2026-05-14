import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { health } from './health.js'
import { pool } from './db.js'
import { resolveUserAtBoot } from './auth.js'
import { errorHandler } from './middleware/error.js'
import { corsMiddleware } from './middleware/cors.js'
import { me } from './routes/api/me.js'
import { events } from './routes/api/events.js'
import { memories } from './routes/api/memories.js'
import { stories } from './routes/api/stories.js'
import { profile } from './routes/api/profile.js'
import { relationships } from './routes/api/relationships.js'
import { locations } from './routes/api/locations.js'
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
import { sendReminder } from './routes/functions/sendReminder.js'
import type { AppVariables } from './types.js'

const PORT = Number(process.env.PLANNEN_BACKEND_PORT ?? 54323)
const HOST = '127.0.0.1'
const USER_EMAIL = process.env.PLANNEN_USER_EMAIL
if (!USER_EMAIL) {
  console.error('PLANNEN_USER_EMAIL is required (set by bootstrap.sh)')
  process.exit(1)
}

const user = await resolveUserAtBoot(USER_EMAIL)
console.log(`resolved user: ${user.email} (${user.userId})`)

const app = new Hono<{ Variables: AppVariables }>()

app.onError(errorHandler)
app.use('*', corsMiddleware)
app.use('*', async (c, next) => {
  c.set('pool', pool)
  c.set('userId', user.userId)
  c.set('userEmail', user.email)
  await next()
})

app.route('/', health)
app.route('/api/me', me)
app.route('/api/events', events)
app.route('/api/memories', memories)
app.route('/api/stories', stories)
app.route('/api/profile', profile)
app.route('/api/relationships', relationships)
app.route('/api/locations', locations)
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
app.route('/functions/v1/send-reminder', sendReminder)

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
