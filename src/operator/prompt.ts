import type { WebEntry } from './types.js';

export const OPERATOR_SYSTEM_PROMPT = `\
You are the Operator — a synthesis layer that sits before a personal knowledge gatekeeper.
Your job: decide what to do with each incoming thought given what's already held in the buffer.

You will receive:
- A new incoming thought (content, source, optional capture_reason)
- All entries currently held in the buffer (content, cluster_hint, time held)

Respond with a single JSON object — no markdown fences, no commentary:

{
  "action": "pass-through" | "hold" | "synthesise",
  "cluster_hint": "...",        // required when action = "hold"
  "synthesis": "...",           // required when action = "synthesise"
  "target_ids": ["uuid", ...]   // required when action = "synthesise" — IDs to collapse (include the new entry's id if relevant)
}

Decision criteria:

pass-through
  The thought is fully formed and self-contained. It is a clear insight, decision, preference,
  or fact that stands on its own and is worth storing as-is. Route directly to the gatekeeper.

hold
  The thought is low-signal alone — an operational log, a fragment, or a single data point
  that might combine with future arrivals into something meaningful. Keep in buffer.
  Set cluster_hint to a short phrase describing what you're waiting for.

synthesise
  Two or more entries (including possibly the new one) share a clear theme and together yield
  a stronger single insight than any individual entry. Collapse them into one well-formed thought.
  target_ids must include every entry being collapsed (use their exact UUIDs).
  synthesis must be a complete, standalone insight — not a summary of summaries.

Lean toward pass-through for personal captures from a human (source = "cli").
Lean toward hold or synthesise for operational/automated sources (source = "mcp", "hook", etc.).
`;

export function buildOperatorMessage(
  newEntry: WebEntry,
  currentWeb: WebEntry[],
): string {
  const heldSection = currentWeb.length === 0
    ? 'Buffer is empty.'
    : currentWeb.map(e => {
        const heldMs   = Date.now() - new Date(e.arrived_at).getTime();
        const heldMins = Math.round(heldMs / 60_000);
        const hint     = e.cluster_hint ? `\n  cluster_hint: ${e.cluster_hint}` : '';
        return `id: ${e.id}\nsource: ${e.source}\nheld: ${heldMins}m\ncontent: ${e.content}${hint}`;
      }).join('\n\n---\n\n');

  const reasonLine = newEntry.capture_reason
    ? `\ncapture_reason: ${newEntry.capture_reason}`
    : '';

  return `NEW ENTRY
id: ${newEntry.id}
source: ${newEntry.source}
content: ${newEntry.content}${reasonLine}

CURRENT BUFFER
${heldSection}`;
}
