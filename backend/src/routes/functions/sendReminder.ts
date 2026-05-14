import { Hono } from 'hono'
import { handle } from '../../_shared/handlers/send-reminder.js'
import { runHandler } from './_helpers.js'
import type { AppVariables } from '../../types.js'

export const sendReminder = new Hono<{ Variables: AppVariables }>()

sendReminder.all('/', (c) => runHandler(c, handle))
