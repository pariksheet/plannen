import { Hono } from 'hono'
import { handle } from '../../_shared/handlers/picker-session-poll.js'
import { runHandler } from './_helpers.js'
import type { AppVariables } from '../../types.js'

export const pickerSessionPoll = new Hono<{ Variables: AppVariables }>()

pickerSessionPoll.all('/', (c) => runHandler(c, handle))
