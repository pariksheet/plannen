// CORS middleware. The Vite dev server runs on 4321 (both localhost +
// 127.0.0.1 origins). Adjust here when adding production origins.

import { cors } from 'hono/cors'

export const corsMiddleware = cors({
  origin: ['http://localhost:4321', 'http://127.0.0.1:4321'],
  credentials: true,
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
})
