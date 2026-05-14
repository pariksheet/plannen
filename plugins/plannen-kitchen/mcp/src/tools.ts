import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export const TOOLS: Tool[] = [
  // ── Stores ──────────────────────────────────────────────────────────────────
  {
    name: 'add_store',
    description: 'Add a store where you shop (e.g. "Carrefour Vilvoorde" / supermarket, "Bakker Pieters" / bakery).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Store name as you refer to it' },
        type: { type: 'string', enum: ['supermarket', 'bakery', 'local', 'online', 'other'] },
        notes: { type: 'string' },
      },
      required: ['name', 'type'],
    },
  },
  {
    name: 'list_stores',
    description: 'List configured stores, alphabetical. Filter by type if you want only supermarkets, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['supermarket', 'bakery', 'local', 'online', 'other'] },
      },
    },
  },
  {
    name: 'update_store',
    description: 'Update a store name, type, or notes.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['supermarket', 'bakery', 'local', 'online', 'other'] },
        notes: { type: 'string' },
      },
      required: ['store_id'],
    },
  },
  {
    name: 'delete_store',
    description: 'Delete a store. Items previously assigned to it keep their other fields; store_id is set to NULL.',
    inputSchema: {
      type: 'object',
      properties: { store_id: { type: 'string' } },
      required: ['store_id'],
    },
  },

  // ── Lists ───────────────────────────────────────────────────────────────────
  {
    name: 'create_list',
    description: 'Create a new shopping list (typically a weekly one). week_of is ISO date of the week start (Monday).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'e.g. "Week of 2026-05-14"' },
        week_of: { type: 'string', description: 'ISO date (yyyy-mm-dd) for the Monday of the week' },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_lists',
    description: 'Recent shopping lists, newest first. Default limit 10. Response includes item_count and picked_count per list. Sets truncated:true when more results exist.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'completed', 'archived'] },
        limit: { type: 'number', description: 'Default 10' },
      },
    },
  },
  {
    name: 'update_list',
    description: 'Edit a list name, status (e.g. mark completed), or notes.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string' },
        name: { type: 'string' },
        status: { type: 'string', enum: ['active', 'completed', 'archived'] },
        notes: { type: 'string' },
      },
      required: ['list_id'],
    },
  },

  // ── Items ───────────────────────────────────────────────────────────────────
  {
    name: 'add_item',
    description: 'Add one item to a list. Call this repeatedly when parsing a pasted list — once per item.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string' },
        name: { type: 'string', description: 'Item as written (multilingual ok)' },
        qty: { type: 'string', description: 'Free-text quantity ("2 kg", "1 packet", "few")' },
        store_id: { type: 'string', description: 'Optional. Use get_item_history first to find the usual store.' },
        aisle: { type: 'string', description: 'Free-text aisle ("dairy", "aisle 3")' },
        notes: { type: 'string' },
      },
      required: ['list_id', 'name'],
    },
  },
  {
    name: 'list_items',
    description: 'Items on a list, sorted by aisle then name. Response includes store_name when assigned.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'picked', 'skipped'] },
      },
      required: ['list_id'],
    },
  },
  {
    name: 'update_item',
    description: 'Edit name, qty, store, aisle, or notes on an item. Pass null to clear store_id / aisle / notes.',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        name: { type: 'string' },
        qty: { type: 'string' },
        store_id: { type: ['string', 'null'] },
        aisle: { type: ['string', 'null'] },
        notes: { type: ['string', 'null'] },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'check_off_item',
    description: 'Mark an item picked. Sets status=picked and picked_at=now. The pantry view picks it up automatically.',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'string' } },
      required: ['item_id'],
    },
  },
  {
    name: 'delete_item',
    description: 'Remove an item from a list entirely.',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'string' } },
      required: ['item_id'],
    },
  },

  // ── Pantry + history ────────────────────────────────────────────────────────
  {
    name: 'list_pantry',
    description: 'Items bought (picked) in the last N days, newest first. Default days=14.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Lookback window in days. Default 14, max 365.' },
      },
    },
  },
  {
    name: 'get_item_history',
    description: 'Last N times this item (case-insensitive name match) was picked. Returns store, aisle, list, date. Use to pre-fill store/aisle when adding to a new list.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        limit: { type: 'number', description: 'Default 5' },
      },
      required: ['name'],
    },
  },
]
