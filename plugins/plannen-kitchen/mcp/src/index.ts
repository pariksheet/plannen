import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { TOOLS } from './tools.js'
import { addStore, listStores, updateStore, deleteStore } from './stores.js'
import { createList, listLists, updateList } from './lists.js'
import { addItem, listItems, updateItem, checkOffItem, deleteItem } from './items.js'
import { listPantry, getItemHistory } from './pantry.js'

const server = new Server(
  { name: 'plannen-kitchen', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  try {
    let result: unknown
    switch (name) {
      case 'add_store':        result = await addStore(args as Parameters<typeof addStore>[0]); break
      case 'list_stores':      result = await listStores(args as Parameters<typeof listStores>[0]); break
      case 'update_store':     result = await updateStore(args as Parameters<typeof updateStore>[0]); break
      case 'delete_store':     result = await deleteStore(args as Parameters<typeof deleteStore>[0]); break
      case 'create_list':      result = await createList(args as Parameters<typeof createList>[0]); break
      case 'list_lists':       result = await listLists(args as Parameters<typeof listLists>[0]); break
      case 'update_list':      result = await updateList(args as Parameters<typeof updateList>[0]); break
      case 'add_item':         result = await addItem(args as Parameters<typeof addItem>[0]); break
      case 'list_items':       result = await listItems(args as Parameters<typeof listItems>[0]); break
      case 'update_item':      result = await updateItem(args as Parameters<typeof updateItem>[0]); break
      case 'check_off_item':   result = await checkOffItem(args as Parameters<typeof checkOffItem>[0]); break
      case 'delete_item':      result = await deleteItem(args as Parameters<typeof deleteItem>[0]); break
      case 'list_pantry':      result = await listPantry(args as Parameters<typeof listPantry>[0]); break
      case 'get_item_history': result = await getItemHistory(args as Parameters<typeof getItemHistory>[0]); break
      default: throw new Error(`Unknown tool: ${name}`)
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write('[plannen-kitchen-mcp] ready\n')
