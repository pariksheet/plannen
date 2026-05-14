import { Hono } from 'hono'
import { handle } from '../../_shared/handlers/picker-session-create.js'
import { runHandler } from './_helpers.js'
import type { AppVariables } from '../../types.js'

export const pickerSessionCreate = new Hono<{ Variables: AppVariables }>()

pickerSessionCreate.all('/', (c) => runHandler(c, handle))
