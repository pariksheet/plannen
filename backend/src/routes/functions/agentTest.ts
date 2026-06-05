import { Hono } from 'hono'
import { handle } from '../../_shared/handlers/agent-test.js'
import { runHandler } from './_helpers.js'
import type { AppVariables } from '../../types.js'

export const agentTest = new Hono<{ Variables: AppVariables }>()

agentTest.all('/', (c) => runHandler(c, handle))
