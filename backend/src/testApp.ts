// Factory for integration tests. Builds an isolated Hono app with the same
// middleware + routes as the production entry point, but with the resolved
// user injected directly instead of read from PLANNEN_USER_EMAIL.

import { Hono } from 'hono'
import { pool } from './db.js'
import { errorHandler } from './middleware/error.js'
import { health } from './health.js'
import { me } from './routes/api/me.js'
import { events } from './routes/api/events.js'
import { memories } from './routes/api/memories.js'
import { stories } from './routes/api/stories.js'
import { profile } from './routes/api/profile.js'
import { relationships } from './routes/api/relationships.js'
import { locations } from './routes/api/locations.js'
import { sources } from './routes/api/sources.js'
import { watch } from './routes/api/watch.js'
import { rsvp } from './routes/api/rsvp.js'
import { groups } from './routes/api/groups.js'
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

export function buildApp(user: { userId: string; userEmail: string }) {
  const app = new Hono<{ Variables: AppVariables }>()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    c.set('pool', pool)
    c.set('userId', user.userId)
    c.set('userEmail', user.userEmail)
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
  app.route('/api/sources', sources)
  app.route('/api/watch', watch)
  app.route('/api/rsvp', rsvp)
  app.route('/api/groups', groups)
  app.route('/storage/v1/object', eventPhotos)
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
  return app
}
