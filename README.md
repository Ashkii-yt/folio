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

- Data: one folder per account, `data/<username>/`, holding `folio.db` (SQLite, plus `-wal`/`-shm` while running) and `secrets.key`. Override the base folder with `FOLIO_DATA_DIR`.
- `secrets.key` holds the account's username, a scrypt **hash** of the password (never the password itself) and the key that encrypts provider API keys and header values (AES-256-GCM). Keys never reach the browser and are left out of exports and backups. Anyone who can read the whole account folder can read both the database and its key, so protect the folder.
- Sessions are signed HttpOnly cookies valid for 30 days; changing your password signs out other devices. Repeated wrong passwords lock sign-in for 15 minutes.
- Data from an earlier single-user install (`data/folio.db`) is adopted by the first account created.

## Accounts and the per-IP limit

- By default each network address can create **one** account (`FOLIO_MAX_ACCOUNTS_PER_IP`, `0` turns the limit off). IPs are stored only as a keyed hash. The limit is a speed bump, not a wall: people behind one NAT/VPN share it, and anyone can change address.
- To serve other people, set `FOLIO_ALLOW_NETWORK=1`, `FOLIO_ALLOWED_HOSTS=<hostname>` and put Folio behind HTTPS, with `FOLIO_TRUST_PROXY=1` (so the real client IP is read from the proxy) and `FOLIO_SECURE_COOKIES=1`. Passwords over plain http can be read on the network. Each user's model providers are their own, but remember a shared server makes requests on their behalf.
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


## Creating characters with AI

On *Make a character*, open **Create with AI**, type a few words (or a paragraph) and press **Write the whole character**. The model writes every part of the card, including the system prompt addition, and nothing is saved until you press Create. Options:

- **Fill in only the empty parts** keeps everything you already wrote.
- Each field has its own **Draft with AI / Rewrite** button.
- Under *Model* you can pick a different provider or model just for writing; the default is your normal default model.
- Every AI edit shows an **Undo** toast. Your idea and any text already in the form are sent to the model you pick, so use a local model if that matters.

## Sharing characters

On *My characters*, the share button publishes a snapshot of the card to this server (`data/shared.db`). Other accounts find it under **Browse characters → Shared by others**, can read all of it (including the system prompt addition) and add their own copy. Chats, memories, model settings and API keys are never shared, and an added copy has its own private chats and memories. The author's username is shown. You can update the shared copy after editing, or stop sharing at any time; copies people already added are theirs to keep. Limit: 50 shared characters per account. Sharing is per server, so for other servers use Export / Import.

## Suggest a reply

In a chat, **Suggest a reply** (above the message box) offers three different things you could say next, written by the chat's model. Pick one to put it in the box, edit it, and send it yourself; nothing is sent or saved until you do. **More ideas** asks again. It also works on an empty chat, to suggest ways to open.

## Portraits

In the character editor, **Generate portrait** opens a dialog: describe the character (or press *Write from the card*), pick a style and 1 to 4 variations, then choose the one you like. Pick the service in **Settings → Portraits**:

- **AI Horde** (default): free and needs no account, run by volunteers. It can queue for a minute or more. Prompts are seen by the volunteer workers, and images made without a personal key may be shared with the LAION research project; a free personal key from aihorde.net avoids that and queues faster.
- **Pollinations**: quick and good quality, but its API now asks for a (free) key.
- **OpenAI-compatible images API**: OpenAI or any server with `POST /images/generations`.

Only the image description goes to the image service, never your chats or memories, and it is sent by the Folio server, not your browser. The services' terms and limits can change; the app was tested against stand-in servers, so use *Save and make a test image* to confirm a service works from your machine.
