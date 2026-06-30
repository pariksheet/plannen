// AI-SDK glue for agent-chat. Builds an OpenAI-compatible tool-calling loop
// from the EXISTING MCP ToolModule dispatch handlers (no HTTP/JSON-RPC hop,
// identical RLS + timezone parsing to the MCP path), and runs one bounded turn.
//
// Heavy `npm:` imports live ONLY here and in index.ts — the pure logic.ts /
// quota.ts modules stay import-free so the unit tests never load the AI SDK.

import { generateText, tool, jsonSchema } from 'npm:ai@4'
import { createOpenAICompatible } from 'npm:@ai-sdk/openai-compatible@0'
import type { ToolCtx, ToolHandler } from '../mcp/types.ts'
import { eventsModule } from '../mcp/tools/events.ts'
import { checklistsModule } from '../mcp/tools/checklists.ts'
import { activityModule } from '../mcp/tools/activity.ts'
import {
  WRITE_TOOLS,
  LOOKUP_TOOLS,
  isLookupTool,
  isWriteTool,
  type WriteTool,
} from './logic.ts'

declare const Deno: { env: { get(k: string): string | undefined } } | undefined
function envGet(key: string): string {
  if (typeof Deno !== 'undefined') return Deno.env.get(key) ?? ''
  return (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[key] ?? ''
}

// One flat registry across the three modules the agent is allowed to touch.
const MODULES = [eventsModule, checklistsModule, activityModule]

const DISPATCH: Record<string, ToolHandler> = {}
for (const m of MODULES) Object.assign(DISPATCH, m.dispatch)

const DEFINITIONS: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {}
for (const m of MODULES) {
  for (const d of m.definitions) DEFINITIONS[d.name] = { description: d.description, inputSchema: d.inputSchema }
}

// Exposed so index.ts can execute on the confirm / direct paths without the model.
export function dispatchTool(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<unknown> {
  const handler = DISPATCH[name]
  if (!handler) throw new Error(`unknown tool: ${name}`)
  return Promise.resolve(handler(args, ctx))
}

export type ModelTurn = {
  text: string
  writeCall: { tool: WriteTool; args: Record<string, unknown> } | null
  usedLookup: boolean
}

// Run one model turn. Lookup tools execute (read-only, results fed back so the
// model can resolve a target); write tools have NO execute — the loop stops on
// the write call and we hand it back to index.ts to confirm-or-execute.
export async function runModelTurn(params: {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  ctx: ToolCtx
  maxSteps?: number
}): Promise<ModelTurn> {
  const baseURL = envGet('LLM_BASE_URL')
  const apiKey = envGet('LLM_API_KEY')
  const modelId = envGet('LLM_MODEL')
  if (!baseURL || !apiKey || !modelId) {
    throw new Error('agent-chat is not configured (missing LLM_BASE_URL / LLM_API_KEY / LLM_MODEL)')
  }

  const provider = createOpenAICompatible({ name: 'plannen-llm', baseURL, apiKey })
  const model = provider(modelId)

  let usedLookup = false
  const tools: Record<string, unknown> = {}

  for (const name of LOOKUP_TOOLS) {
    const def = DEFINITIONS[name]
    if (!def) continue
    tools[name] = tool({
      description: def.description,
      parameters: jsonSchema(def.inputSchema),
      execute: async (args: Record<string, unknown>) => {
        usedLookup = true
        try {
          return await dispatchTool(name, args, params.ctx)
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      },
    })
  }

  for (const name of WRITE_TOOLS) {
    const def = DEFINITIONS[name]
    if (!def) continue
    // No execute → terminal. generateText returns the call unresolved.
    tools[name] = tool({
      description: def.description,
      parameters: jsonSchema(def.inputSchema),
    })
  }

  const result = await generateText({
    model,
    system: params.system,
    messages: params.messages,
    tools,
    maxSteps: params.maxSteps ?? 5,
    // Reasoning-capable small models (e.g. qwen3.6-27b) spend a large, variable
    // number of completion tokens on internal reasoning BEFORE emitting the tool
    // call. Too small a budget truncates the call mid-arguments — the model
    // returns an incomplete object missing required fields (title/start_date),
    // which then fails handler validation. Give generous headroom per step.
    maxTokens: 4096,
  })

  // The terminal write call (if any) is in the final step's toolCalls.
  let writeCall: ModelTurn['writeCall'] = null
  for (const call of result.toolCalls ?? []) {
    if (isWriteTool(call.toolName)) {
      writeCall = { tool: call.toolName, args: (call.args ?? {}) as Record<string, unknown> }
      break
    }
    if (isLookupTool(call.toolName)) usedLookup = true
  }

  return { text: result.text ?? '', writeCall, usedLookup }
}
