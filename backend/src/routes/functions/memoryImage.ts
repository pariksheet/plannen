import { Hono } from 'hono'
import { handle } from '../../_shared/handlers/memory-image.js'
import { runHandler } from './_helpers.js'
import type { AppVariables } from '../../types.js'

export const memoryImage = new Hono<{ Variables: AppVariables }>()

memoryImage.all('/', (c) => runHandler(c, handle))
memoryImage.all('/*', (c) => runHandler(c, handle))
