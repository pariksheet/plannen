import { Hono } from 'hono'
import { handleNotify } from '../../_shared/handlers/notify.js'
import { runHandler } from './_helpers.js'
import type { AppVariables } from '../../types.js'

export const notify = new Hono<{ Variables: AppVariables }>()

notify.all('/', (c) => runHandler(c, handleNotify))
