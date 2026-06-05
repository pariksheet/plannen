import { Hono } from 'hono'
import { handle } from '../../_shared/handlers/get-google-access-token.js'
import { runHandler } from './_helpers.js'
import type { AppVariables } from '../../types.js'

export const getGoogleAccessToken = new Hono<{ Variables: AppVariables }>()

getGoogleAccessToken.all('/', (c) => runHandler(c, handle))
