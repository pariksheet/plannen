import type { PoolClient } from 'npm:pg@8'

export interface ToolCtx {
  /** Postgres client checked out from the pool, inside withDb's transaction. */
  client: PoolClient
  /** Bootstrap user resolved at module load via PLANNEN_USER_EMAIL. */
  userId: string
}

export type ToolHandler = (args: unknown, ctx: ToolCtx) => Promise<unknown>

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ToolModule {
  definitions: ToolDefinition[]
  dispatch: Record<string, ToolHandler>
}
