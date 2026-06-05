import { Hono } from 'hono'
import { handle } from '../../_shared/handlers/agent-discover.js'
import { runHandler } from './_helpers.js'
import type { AppVariables } from '../../types.js'

export const agentDiscover = new Hono<{ Variables: AppVariables }>()

agentDiscover.all('/', (c) => runHandler(c, handle))
