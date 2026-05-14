import { Hono } from 'hono'
import { handle } from '../../_shared/handlers/agent-scrape.js'
import { runHandler } from './_helpers.js'
import type { AppVariables } from '../../types.js'

export const agentScrape = new Hono<{ Variables: AppVariables }>()

agentScrape.all('/', (c) => runHandler(c, handle))
