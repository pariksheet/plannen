import { Hono } from 'hono'
import { handle } from '../../_shared/handlers/get-google-auth-url.js'
import { runHandler } from './_helpers.js'
import type { AppVariables } from '../../types.js'

export const getGoogleAuthUrl = new Hono<{ Variables: AppVariables }>()

getGoogleAuthUrl.all('/', (c) => runHandler(c, handle))
