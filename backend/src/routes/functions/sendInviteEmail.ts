import { Hono } from 'hono'
import { handle } from '../../_shared/handlers/send-invite-email.js'
import { runHandler } from './_helpers.js'
import type { AppVariables } from '../../types.js'

export const sendInviteEmail = new Hono<{ Variables: AppVariables }>()

sendInviteEmail.all('/', (c) => runHandler(c, handle))
