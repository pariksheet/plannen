import { Hono } from 'hono'
import { handle } from '../../_shared/handlers/agent-extract-image.js'
import { runHandler } from './_helpers.js'
import type { AppVariables } from '../../types.js'

export const agentExtractImage = new Hono<{ Variables: AppVariables }>()

agentExtractImage.all('/', (c) => runHandler(c, handle))
