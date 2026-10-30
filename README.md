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


## Read aloud

Under each character message there is a speaker button. It reads the message with a voice built into your browser or phone (nothing is sent anywhere). Pick the voice and speed, and whether to skip the *italic actions*, in **Settings → General → Read aloud**; those choices are saved per device.

## Better portraits

Reasoning models' `<think>` blocks are now removed from everything Folio asks a model to write (portrait prompts, character drafts, suggestions, chat replies). Portrait prompts are built per service: tag-style with a separate negative prompt for AI Horde (with face restoration and face-friendly checkpoints), plain sentences for the others. For clearly better faces, use **Cloudflare Workers AI** (FLUX.1 schnell) in Settings → Portraits: it needs a free Cloudflare account, its account ID and an API token with the Workers AI permission, and has a daily free allowance.

## Syncing servers (whole server, by server ID)

Sync copies **everything** on a server (every account, plus the shared characters) to another Folio server. It is a command-line job; there is no web login involved.

Each server's ID is its public key (`srv_` + 64 hex, shown by `npm run ids` and at startup). `npm start` also runs a small service that joins the HyperDHT network and lets other servers find and connect to it **by ID alone**: no URL, no https, no port forwarding. Connections are hole-punched and end-to-end encrypted, and only the real owner of that key can answer.

```
npm run pair                               # on server A (keep npm start running): prints a one-time code
npm run link -- srv_<A's id> abcd-efgh-jkmn  # on server B: pairs. Do the reverse (pair on B, link on A) to allow A to reach B too
npm run sync  -- srv_<A's id>              # both ways (also: fetch = pull only, push = send only)
npm run sync  -- srv_<A's id> --every 300  # keep replicating every 5 minutes
npm run sync  -- <id> --dry-run            # show what would change
npm run peers / unlink -- <id|name>        # who is paired
npm run remote -- add home srv_<id>        # then: npm run sync -- home
```

Accounts that exist on only one side are created on the other with the same login. Newer wins per record; deletions travel. Providers, API keys and settings are never synced. Old random server IDs are replaced by key IDs on first start (the old one is kept as `previousId` in `data/server.json`).

**SSH (same network, no pairing, no running Folio needed):**
```
npm run remote -- add pi ssh://user@192.168.1.20/home/user/folio
npm run sync -- pi
```
Uses your system `ssh` (key login, no password prompts) and runs `node server/cli.js stdio` on the other machine, so Folio and its dependencies must be installed there. Your ssh login is the authorisation.

**Things to know**
- A paired server receives every account's characters, chats and memories. Only pair servers you control. Guard `data/server.json` (it holds the private seed).
- The DHT reveals your IP address to the peers you connect to and to DHT nodes you talk to.
- Direct connections can fail behind carrier-grade NAT or strict firewalls; use ssh:// or a VPN such as Tailscale then. This was tested on a local DHT, not over the real internet.
- Turn the service off with `FOLIO_SYNC_SERVICE=0`.
- Live sharing of one SQLite file between machines is not possible, so servers replicate instead: run sync on a schedule (`--every`) to make one act like a database for the others.
- `npm run sync:export` / `sync:import` move one account through a file.
