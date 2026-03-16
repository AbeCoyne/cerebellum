# Cerebellum — Workflow Context

> Inject this at the start of any session on this project.
> Keep it updated. Delete sections that don't apply.

## What This Is

Personal agent-readable second brain. Postgres + pgvector + MCP. Thoughts go in via CLI (`memo`) or MCP. Every AI tool can query it via a single MCP server registered globally. Current status: Operator (synthesis layer) built, PR #9 open awaiting merge. Seeding blocked on Operator merge + OpenRouter credits.

## Standards

- **Language/runtime:** TypeScript, Node.js 22, `tsx` for dev execution
- **File structure:** `src/cli/`, `src/gatekeeper/`, `src/operator/`, `src/mcp/tools/`, `src/http/routes/`, `src/utils/`
- **Naming:** snake_case files, conventional commits (`type(scope): description`)
- **Key libraries:** `@supabase/supabase-js`, `@modelcontextprotocol/sdk`, `tsx`, `zod`, `inquirer`
- **Testing:** manual verification against live Supabase DB — no unit tests, test plan in each PR
- **Build:** `npm run build` required before any `node dist/...` invocation
- **Greptile:** always check Greptile PR comments before considering a sprint complete

## Active Spec

None — Operator is built. Next is DB cleanup + seeding.

## What's Next

1. Final Greptile pass on PR #9, then merge
2. Clear 20 legacy GK queue items via `memo review`
3. DB cleanup (delete 18 noise entries)
4. Seed 93 entries through Operator pipeline
5. Live seeding interview (gap-fill)

## Known Landmines

- `/mcp` route **must** stay above `bearerAuth` middleware — standard MCP clients can't inject auth headers
- `deleteBySource` uses `LIKE` match — passing `'seed:'` deletes all `seed:*` variants (intentional)
- Queue and web.json use atomic temp-file-rename — never edit directly or mid-write
- `npm run build` required after any TypeScript changes before testing compiled output
- CLI search default threshold is `0.5` — real-world thoughts rarely score above 0.7 with current data
- `gh pr edit --body` silently truncates multi-line content — always use `gh api repos/OWNER/REPO/pulls/N --method PATCH --field body="..."` instead
- Shell aliases live in `~/.zsh/aliases.zsh`, NOT `.zshrc`
- MCP server is registered globally via `claude mcp add --scope user cerebellum` — changes to `dist/` are picked up automatically on next session start
- OpenRouter credits are low — top up before running `memo review` or any LLM-backed operation
- `memo seed` writes direct to DB, bypassing Operator — deliberate for bulk import
