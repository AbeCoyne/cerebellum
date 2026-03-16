import { randomUUID } from 'crypto';
import { z } from 'zod';
import { cfg } from '../config.js';
import { enqueue } from '../gatekeeper/queue.js';
import { readWeb, addEntry, updateEntry, removeEntries } from './web.js';
import { OPERATOR_SYSTEM_PROMPT, buildOperatorMessage } from './prompt.js';
import type { WebEntry } from './types.js';

// ─── Zod schema for Operator LLM response ────────────────────────────────────

const DecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pass-through') }),
  z.object({ action: z.literal('hold'),        cluster_hint: z.string() }),
  z.object({
    action:     z.literal('synthesise'),
    synthesis:  z.string(),
    target_ids: z.array(z.string()),
  }),
]);

type OperatorDecision = z.infer<typeof DecisionSchema>;

// ─── LLM call ────────────────────────────────────────────────────────────────

async function callOperator(
  newEntry:   WebEntry,
  currentWeb: WebEntry[],
): Promise<OperatorDecision> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${cfg.openrouter.apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:           cfg.operator.model,
      messages: [
        { role: 'system', content: OPERATOR_SYSTEM_PROMPT },
        { role: 'user',   content: buildOperatorMessage(newEntry, currentWeb) },
      ],
      max_tokens:      512,
      temperature:     0.2,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  const raw     = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('OpenRouter returned no content');

  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  return DecisionSchema.parse(JSON.parse(cleaned));
}

// ─── TTL expiry ───────────────────────────────────────────────────────────────

/**
 * Check for expired entries. For 2+ expired, attempt one final synthesis;
 * on pass-through or failure, route each expired entry to GK individually
 * so content is never silently discarded.
 */
async function processExpired(): Promise<void> {
  const now     = Date.now();
  const entries = readWeb();
  const expired = entries.filter(e => new Date(e.expires_at).getTime() <= now);
  if (expired.length === 0) return;

  // Try a synthesis over the entire expired cluster
  if (expired.length >= 2) {
    try {
      const [first] = expired;
      const allEntries = readWeb();
      const contextEntries = allEntries.filter(e => e.id !== first.id);
      const decision = await callOperator(first, contextEntries);
      if (decision.action === 'synthesise') {
        // Only remove entries the LLM actually targeted — route the rest to GK
        const expiredIds = new Set(expired.map(e => e.id));
        const synthesised = decision.target_ids.filter(id => expiredIds.has(id));
        removeEntries(synthesised);
        enqueue(decision.synthesis, 'operator:ttl-synthesis');
        const remaining = expired.filter(e => !synthesised.includes(e.id));
        if (remaining.length > 0) {
          removeEntries(remaining.map(e => e.id));
          for (const e of remaining) enqueue(e.content, e.source, e.capture_reason);
        }
        return;
      }
    } catch {
      // fall through to pass-through each entry individually
    }
  }

  // Pass each expired entry through to GK rather than silently discarding
  removeEntries(expired.map(e => e.id));
  for (const e of expired) {
    enqueue(e.content, e.source, e.capture_reason);
  }
}

// ─── core evaluation ─────────────────────────────────────────────────────────

async function _evaluateOne(entry: WebEntry): Promise<void> {
  const web = readWeb();
  // Entry may have been removed by `memo web` before this background
  // evaluation ran — bail out to avoid duplicate GK entries.
  if (!web.some(e => e.id === entry.id)) return;

  const others = web.filter(e => e.id !== entry.id);

  let decision: OperatorDecision;
  try {
    decision = await callOperator(entry, others);
  } catch (err) {
    // On LLM failure: fall back to pass-through so the thought is never lost.
    // Re-read web to check for concurrent removal before acting.
    console.error('[operator] LLM call failed, passing through:', err instanceof Error ? err.message : err);
    if (!readWeb().some(e => e.id === entry.id)) return;
    removeEntries([entry.id]);
    enqueue(entry.content, entry.source, entry.capture_reason);
    return;
  }

  if (decision.action === 'pass-through') {
    removeEntries([entry.id]);
    enqueue(entry.content, entry.source, entry.capture_reason);

  } else if (decision.action === 'hold') {
    updateEntry(entry.id, { cluster_hint: decision.cluster_hint });

  } else if (decision.action === 'synthesise') {
    // Re-read web after the LLM call — targets may have been removed by
    // concurrent `memo web` during the round-trip.
    // Always include entry.id in removal set — the LLM may omit it from
    // target_ids but the triggering entry should never linger post-synthesis.
    const freshWeb = readWeb();
    const candidateIds = [...new Set([entry.id, ...decision.target_ids])];
    const toRemove = candidateIds.filter(id =>
      freshWeb.some(e => e.id === id),
    );
    if (toRemove.length === 0) return; // all targets already handled
    removeEntries(toRemove);
    enqueue(decision.synthesis, 'operator:synthesis');
  }
}

// ─── serialisation ───────────────────────────────────────────────────────────

/**
 * Serialises all background evaluate() calls to prevent concurrent
 * read-modify-write races on web.json.
 */
let _operatorChain: Promise<void> = Promise.resolve();

function scheduleEvaluate(entry: WebEntry): void {
  _operatorChain = _operatorChain
    .then(() => _evaluateOne(entry))
    .catch(() => {}); // prevent one failure from breaking the chain
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Intake a new thought into the Operator buffer.
 *
 * 1. Process any expired web entries (synchronous — ensures stale entries are
 *    cleaned up before computing TTL for the new arrival).
 * 2. Add the new entry to web.json with its TTL.
 * 3. Fire background evaluation (non-blocking).
 */
export async function intake(
  content:         string,
  source:          string,
  capture_reason?: string,
): Promise<void> {
  // 1. Expiry sweep (best-effort — never throws to the caller)
  try {
    await processExpired();
  } catch {
    // ignore
  }

  // 2. TTL: personal captures get 7d, everything else 1d
  const ttlHours = source === 'cli'
    ? cfg.operator.ttlPersonalHours
    : cfg.operator.ttlOperationalHours;

  const now       = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);

  const entry: WebEntry = {
    id:             randomUUID(),
    content,
    source,
    capture_reason,
    arrived_at:     now.toISOString(),
    expires_at:     expiresAt.toISOString(),
  };

  addEntry(entry);

  // 3. Background evaluation
  scheduleEvaluate(entry);
}
