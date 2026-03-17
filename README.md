<div align="center">
  <img src="assets/cerebellum-logo.svg" alt="cerebellum" width="840"/>
  <br/><br/>

[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-7c3aed?style=flat-square)](https://modelcontextprotocol.io/)
[![Supabase](https://img.shields.io/badge/Supabase-pgvector-3ecf8e?style=flat-square&logo=supabase&logoColor=white)](https://supabase.com/)
[![OpenRouter](https://img.shields.io/badge/OpenRouter-embeddings-ff6b35?style=flat-square)](https://openrouter.ai/)

</div>

---

Capture thoughts from anywhere. Retrieve them semantically. Every AI tool you use — Claude, Cursor, VS Code — connects to the same brain via a single MCP server.

## How it works

Thoughts pass through three stages before reaching the database:

```
memo "thought"
    ↓
Operator  (buffer + TTL synthesis)
  holds related thoughts, synthesises clusters before they expire
    ↓
Gatekeeper  (quality + contradiction scoring)
  scores 1–10, detects contradictions, adversarial review for borderline items
    ↓
memo review  (interactive approval)
    ↓
embed (text-embedding-3-small)  +  classify (claude-sonnet-4-6)
    ↓
Postgres + pgvector (Supabase)
    ↓
semantic_search / list_recent / stats / capture  ←  any MCP client
```

Use `memo --axiom "directive"` to bypass the Operator and queue a thought directly as an axiom.

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

## Operator

The Operator is a short-term buffer. Rather than sending every thought straight to the Gatekeeper, it holds them in `~/.cerebellum/web.json` and looks for clusters worth synthesising. When related thoughts accumulate it collapses them into a single, richer entry. Thoughts that never cluster are passed through individually when their TTL expires (7 days for personal captures, 24h for operational ones).

Three decisions: **pass-through**, **hold** (wait for more), **synthesise** (merge cluster → single thought).

## Gatekeeper

The Gatekeeper scores every thought before it enters the database:

- **Quality score** 1–10 (Noise → Insight-grade)
- **Recommendation** — `keep` · `drop` · `axiom` · `improve`
- **Contradiction detection** — soft / hard / veto_violation against existing thoughts
- **Adversarial review** — for borderline scores (4–7), a second LLM pass checks the reformulation

Evaluated entries land in `~/.cerebellum/queue.json`. Run `memo review` to approve or reject them interactively.

## MCP Tools

| Tool | Description |
|---|---|
| `semantic_search` | Find thoughts by meaning, not keywords |
| `list_recent` | Retrieve thoughts by time window |
| `stats` | Totals, type breakdown, top topics & people |
| `capture` | Write to the brain from any MCP client |

Also available over HTTP at `POST /mcp` when the daemon is running.

## CLI

Set up the alias once:
```bash
alias memo="node --import tsx/esm /path/to/cerebellum/src/cli/index.ts"
```

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

## Setup

**1. Clone and install**
```bash
git clone https://github.com/jj-valentine/cerebellum
cd cerebellum
npm install
```

**2. Configure environment**
```bash
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENROUTER_API_KEY
# Generate CEREBELLUM_API_KEY with: openssl rand -hex 32
```

**3. Run schema in Supabase SQL editor**
```
Copy contents of schema/schema.sql → paste into Supabase SQL Editor → Run
```

**4. Build and register MCP server**
```bash
npm run build
claude mcp add --transport stdio --scope user cerebellum -- node /path/to/dist/mcp/server.js
```

**5. Set up CLI alias**

Add to your shell config (`~/.zshrc`, `~/.bashrc`, etc.):
```bash
alias memo="node --import tsx/esm /path/to/cerebellum/src/cli/index.ts"
```

**6. (Optional) HTTP daemon**

Run `npm run build && node dist/http/main.js` to start the daemon on `127.0.0.1:4891`. Requires `CEREBELLUM_API_KEY` in your `.env`. The `/mcp` endpoint is unauthenticated (standard MCP clients); the `/api/*` endpoints require a `Bearer` token.

## Metadata auto-extracted per thought

Each captured thought is automatically classified into:

- **Type** — `observation` · `task` · `idea` · `reference` · `people` · `preference`
- **Topics** — 1–3 tags
- **Mentions** — mentioned names
- **Action items** — implied next steps

## Cost

~$0.10–0.30/month at 20 thoughts/day (embeddings + classification). Gatekeeper and Operator LLM calls add marginal cost — both default to `claude-sonnet-4-6` but work well with `openai/gpt-4o-mini` if you want to keep costs near zero.

## License

MIT
