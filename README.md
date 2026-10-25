# Folio

A local, character-first AI chat app. Create characters, give them a voice, and they remember you across conversations. Bring your own model: Ollama (local or remote), OpenAI, Anthropic, Google Gemini, or any OpenAI-compatible server.

## Run it

Requires Node 22.5 or newer.

```
npm install
npm run build     # builds the web UI into server/public
npm start         # http://localhost:4317
```

For development with hot reload: `npm run dev` (UI on http://localhost:5173, API on 4317).
Tests: `npm test`.

## Where things live

- Data: `data/folio.db` (SQLite). Override the folder with `FOLIO_DATA_DIR`.
- API keys and custom header values are encrypted (AES-256-GCM) with a key in `data/secret.key`, or in `FOLIO_SECRET_KEY` (32 bytes, base64 or hex) if you want it kept elsewhere. They never reach the browser and are left out of exports and backups.
- The server listens on 127.0.0.1 only and rejects other Host headers. Folio has no login. To expose it, set `FOLIO_ALLOW_NETWORK=1` and `FOLIO_ALLOWED_HOSTS`, and put it behind something that authenticates.

## How memory works

- Every message is stored permanently with order, time and speaker. Summaries only supplement them, they never replace them.
- A background pass reads new messages and files memories (model-based, simple pattern matching, or off). Each memory has a category, importance, source conversation, pin, and history. Corrections replace the old version, which stays under "Replaced". Corrections to pinned or hand-edited memories wait for your approval.
- Each reply retrieves relevant memories and past-conversation excerpts with SQLite FTS5 (BM25, stemming) plus importance, recurrence, recency and pins. No embeddings or paid services are needed.
- The prompt is sized to the provider's context length: character card and your custom instructions first, then the newest message, memories, recent turns, summaries of older turns, excerpts, and a digest of other chats.
- Each reply has a "Recalled…" link showing what it used.

## Provider notes

- Requests go from Folio's server to the provider, so browser CORS and `OLLAMA_ORIGINS` do not apply.
- Remote (internet) endpoints require an explicit acknowledgement that messages and recalled memories are sent to a third party.
- Context length is sent to Ollama as `num_ctx`. For other providers it only sizes Folio's prompt.
- Settings a provider ignores are not shown (for example top-k for OpenAI).
