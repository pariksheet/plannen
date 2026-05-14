import { Hono } from 'hono'
import { handle } from '../../_shared/handlers/google-oauth-callback.js'
import { runHandler } from './_helpers.js'
import type { AppVariables } from '../../types.js'

export const googleOauthCallback = new Hono<{ Variables: AppVariables }>()

googleOauthCallback.all('/', (c) => runHandler(c, handle))
