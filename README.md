<div align="center">
  <img src="assets/cerebellum-logo.svg" alt="cerebellum" width="840"/>
  <br/><br/>

[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-7c3aed?style=flat-square)](https://modelcontextprotocol.io/)
[![Supabase](https://img.shields.io/badge/Supabase-pgvector-3ecf8e?style=flat-square&logo=supabase&logoColor=white)](https://supabase.com/)
[![OpenRouter](https://img.shields.io/badge/OpenRouter-embeddings-ff6b35?style=flat-square)](https://openrouter.ai/)

</div>

---

A personal, database-backed memory system that speaks MCP. Any AI tool — Claude, Cursor, ChatGPT, whatever ships next year — queries the same memory store without integration work. _One protocol, every engine._

Raw thoughts don't go straight to the database. Three layers stand between capture and storage.

## Quickstart

```bash
git clone https://github.com/jj-valentine/cerebellum
cd cerebellum && npm install
cp .env.example .env        # fill in SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENROUTER_API_KEY
```

Paste `schema/schema.sql` into the Supabase SQL Editor and run it. Then:

```bash
npm run build
claude mcp add --transport stdio --scope user cerebellum -- node /path/to/dist/mcp/server.js

# Add to your shell config:
alias memo="node --import tsx/esm /path/to/cerebellum/src/cli/index.ts"
```

```bash
memo "first thought"    # you're in
```

The [`prompts/`](./prompts/) directory has five ready-to-use prompts for seeding the brain: memory migration, second brain migration, a personalized capture discovery interview, quick capture templates, and a weekly review ritual.

## Architecture

```
memo "thought"
    ↓
Operator  (buffer · synthesis · TTL)
    ↓
Gatekeeper  (quality · contradiction · adversarial review)
    ↓
memo review  (you have final say)
    ↓
embed + classify → Postgres + pgvector (Supabase)
    ↓
semantic_search / list_recent / stats / capture  ←  any MCP client
```

---

## Operator _(Weaver, Mentat, Curator... still deciding — suggestions welcome)_

Every capture lands in a short-term buffer before it touches the database. The Operator is an LLM crawling that buffer — picking apart fragments, finding the threads that belong together, synthesizing what can be synthesized. Think less pipeline step, more something alive in the web.

Three calls:

- **`pass-through`** — complete, self-contained thought. Route it.
- **`hold`** — low-signal fragment. Sit. Wait for the rest.
- **`synthesise`** — two or more buffered entries share a theme. Collapse them into one stronger thought. Discard the fragments.

Three half-baked notes about a decision you're wrestling with become one coherent insight by the time they reach the next layer. The fragments never reach the database. The buffer runs on a serialized async chain — concurrent captures don't corrupt each other, and TTL expiry never silently discards. If synthesis fails, entries route individually. Nothing gets lost.

Use `memo --axiom "..."` to skip the Operator entirely and send something straight to the queue as an axiom.

---

## Gatekeeper

What survives the Operator hits a second LLM evaluation.

The Gatekeeper scores each thought **1–10** (Noise → Insight-grade), runs an adversarial note on borderline items (scores 4–7), checks for contradictions against everything already in the database, and flags **veto violations** — captures that would contradict a directive you've already marked inviolable.

Output: a recommendation (`keep` · `drop` · `improve` · `axiom`) and a reformulation if it thinks the thought can be sharper.

### Axioms

An _axiom_ is a permanent directive — carved in stone, not written on a whiteboard. Once approved, it doesn't just sit in the database differently; the Gatekeeper actively flags any future capture that would contradict it.

`memo --axiom "never ship without a review queue"` — skips the Operator, hits your queue marked as axiom, and once you approve it, it's enforced from that point forward. A first-class thought.

---

## You _(the Architect)_

Nothing reaches the database without your sign-off. `memo review` walks you through the queue one entry at a time: score, analysis, the skeptic's note if it's borderline, suggested reformulation. Keep it, drop it, edit it, or promote it to axiom. You have final say on everything.

---

## Stack

| Layer | Tech |
|---|---|
| Storage | Supabase (Postgres + pgvector, HNSW index) |
| Embeddings | `openai/text-embedding-3-small` via OpenRouter |
| Classifier | `openai/gpt-4o-mini` via OpenRouter (configurable) |
| Gatekeeper | `anthropic/claude-sonnet-4-6` via OpenRouter (configurable) |
| Operator | `anthropic/claude-sonnet-4-6` via OpenRouter (configurable) |
| Protocol | MCP (`@modelcontextprotocol/sdk`) |
| HTTP daemon | Express on `127.0.0.1:4891` |
| CLI | Node.js + TypeScript (`memo` alias) |

## MCP Tools

| Tool | Description |
|---|---|
| `semantic_search` | Find thoughts by meaning, not keywords |
| `list_recent` | Retrieve thoughts by time window |
| `stats` | Totals, type breakdown, top topics & people |
| `capture` | Write to the brain from any MCP client |

Also available over HTTP at `POST /mcp` when the daemon is running.

## CLI

```bash
memo "thought"                        # capture → Operator → GK queue
memo --axiom "directive"              # bypass Operator, queue as axiom
memo review                           # interactive GK queue review
memo web                              # inspect/force-synthesise/discard held entries
memo search "what was I thinking"     # semantic search
memo recent [--days 7] [--limit 20]   # recent thoughts
memo stats                            # overview
memo seed <file.json>                 # batch import from JSON
memo seed --dry-run <file.json>       # preview without writing
memo seed --undo                      # delete all seeded thoughts
```

## Full Setup

**Environment**
```bash
cp .env.example .env
# Required: SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENROUTER_API_KEY
# HTTP daemon: generate CEREBELLUM_API_KEY with: openssl rand -hex 32
```

**Schema** — paste `schema/schema.sql` into the Supabase SQL Editor and run it.

**MCP server**
```bash
npm run build
claude mcp add --transport stdio --scope user cerebellum -- node /path/to/dist/mcp/server.js
```

**CLI alias** — add to your shell config:
```bash
alias memo="node --import tsx/esm /path/to/cerebellum/src/cli/index.ts"
```

**HTTP daemon** _(optional)_ — `node dist/http/main.js` starts on `127.0.0.1:4891`. The `/mcp` endpoint is unauthenticated; `/api/*` requires a `Bearer` token. This is what makes external capture surfaces (browser extensions, editor plugins, voice input) possible.

## Metadata auto-extracted per thought

- **Type** — `observation` · `task` · `idea` · `reference` · `people` · `preference`
- **Topics** — 1–3 tags
- **Mentions** — mentioned names
- **Action items** — implied next steps

## Cost

~$0.10–0.30/month at 20 thoughts/day. Operator and Gatekeeper both default to `claude-sonnet-4-6` but work well with `openai/gpt-4o-mini` if you want to keep it near zero.

## License

MIT
