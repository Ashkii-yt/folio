/**
 * What is synchronised, and how each row is versioned.
 * Not synchronised on purpose: AI providers and their keys, image settings, app settings (these belong to one
 * machine), and per-machine fields such as which provider a character is set to use.
 */
const T = 60_000; // default text limit
export const SYNC_TABLES = {
  characters: {
    version: 'updated_at',
    cols: {
      id: ['text', 100], name: ['text', 200], description: ['text', T], personality: ['text', T], background: ['text', T],
      speaking_style: ['text', T], goals: ['text', T], example_dialogue: ['text', T], greeting: ['text', T],
      system_prompt_addition: ['text', T], avatar: ['text?', 700_000], tags: ['text', 2000], pinned: ['int', 1], memory_enabled: ['int', 1],
      auto_extract: ['int?', 1], last_chat_at: ['text?', 40], created_at: ['text', 40], updated_at: ['text', 40],
      origin_shared_id: ['text?', 100], origin_owner: ['text?', 100],
    },
    // Kept as they are on this machine when a row is updated, and left empty when a row is new.
    local: { provider_id: null, model: '' },
    merge: { last_chat_at: "NULLIF(MAX(COALESCE(last_chat_at, ''), COALESCE(?, '')), '')" },
  },
  conversations: {
    version: 'updated_at',
    cols: { id: ['text', 100], character_id: ['text', 100], title: ['text', 500], extracted_upto: ['int', 1e9], created_at: ['text', 40], updated_at: ['text', 40] },
    local: { provider_id: null, model: '' },
    merge: { extracted_upto: 'MAX(extracted_upto, ?)' },
  },
  messages: {
    version: 'COALESCE(edited_at, created_at)',
    cols: {
      id: ['text', 100], conversation_id: ['text', 100], seq: ['int', 1e9], role: ['text', 20], content: ['text', 500_000],
      created_at: ['text', 40], edited_at: ['text?', 40], model: ['text', 200], meta: ['text', 400_000],
    },
    keepOnUpdate: ['seq'],
    enums: { role: ['user', 'character'] },
  },
  memories: {
    version: 'updated_at',
    cols: {
      id: ['text', 100], character_id: ['text', 100], content: ['text', 20_000], category: ['text', 40], importance: ['int', 5],
      pinned: ['int', 1], source: ['text', 10], status: ['text', 12], source_conversation_id: ['text?', 100], source_message_id: ['text?', 100],
      superseded_by: ['text?', 100], conflicts_with: ['text?', 100], recurrence: ['int', 1e6], use_count: ['int', 1e9],
      last_used_at: ['text?', 40], created_at: ['text', 40], updated_at: ['text', 40],
    },
    enums: { source: ['auto', 'user'], status: ['active', 'pending', 'superseded'] },
    merge: { use_count: 'MAX(use_count, ?)' },
  },
  summaries: {
    version: 'created_at',
    cols: { id: ['text', 100], conversation_id: ['text', 100], from_seq: ['int', 1e9], to_seq: ['int', 1e9], content: ['text', 100_000], method: ['text', 20], created_at: ['text', 40] },
  },
};

// Parents before children, so foreign keys are satisfied when rows are applied.
export const TABLE_ORDER = ['characters', 'conversations', 'messages', 'memories', 'summaries'];
export const PROTOCOL = 1;
