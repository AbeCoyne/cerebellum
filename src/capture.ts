import { generateEmbedding } from './embeddings.js';
import { classifyThought } from './classify.js';
import { insertThought, upsertThoughtBySourceId } from './db.js';
import { withRetry } from './utils/retry.js';
import { cfg } from './config.js';
import type { Thought, ThoughtType } from './types.js';

const MAX_CHARS = 30_000;

export interface CaptureResult {
  thought: Thought;
  elapsed_ms: number;
}

/**
 * Embed, classify, and store a thought.
 *
 * @param content        The thought text.
 * @param source         Origin tag (cli | mcp | api | …).
 * @param type_override  When set, overrides the LLM classifier's type assignment.
 *                       Use 'axiom' for permanent directive captures.
 * @param extra_metadata Additional key/value pairs merged into the stored metadata.
 *                       Use cortex_source_type / cortex_source_id / cortex_title
 *                       to record where this thought came from (note, document, etc.).
 */
export async function captureThought(
  content:          string,
  source            = 'cli',
  type_override?:   ThoughtType,
  extra_metadata?:  Record<string, unknown>,
): Promise<CaptureResult> {
  let trimmed = content.trim();
  if (!trimmed) throw new Error('Content cannot be empty');

  if (trimmed.length > MAX_CHARS) {
    console.warn(`[capture] Content truncated from ${trimmed.length} to ${MAX_CHARS} chars`);
    trimmed = trimmed.slice(0, MAX_CHARS);
  }

  const start = Date.now();

  // Run embedding and classification in parallel, with retry on transient failures
  const [embedding, metadata] = await withRetry(() => Promise.all([
    generateEmbedding(trimmed),
    classifyThought(trimmed),
  ]));

  // Override type if specified (e.g. axiom)
  if (type_override) {
    metadata.type = type_override;
  }

  // Extract dedicated columns; keep remaining extras in metadata JSONB
  const { cortex_source_type, cortex_source_id, ...remainingExtra } = extra_metadata ?? {};
  const fullMetadata = Object.keys(remainingExtra).length
    ? { ...metadata, ...remainingExtra }
    : metadata;

  const sourceId   = cortex_source_id   as string | undefined;
  const sourceType = cortex_source_type as string | undefined;

  const thought = sourceId
    ? await upsertThoughtBySourceId(
        sourceId,
        trimmed,
        embedding,
        fullMetadata as typeof metadata,
        source,
        cfg.openrouter.embeddingModel,
        sourceType,
      )
    : await insertThought(
        trimmed,
        embedding,
        fullMetadata as typeof metadata,
        source,
        cfg.openrouter.embeddingModel,
        sourceType,
      );
  const elapsed_ms = Date.now() - start;

  return { thought, elapsed_ms };
}

export function formatConfirmation(result: CaptureResult): string {
  const { thought, elapsed_ms } = result;
  const m = thought.metadata;

  const lines = [
    `✓ Captured in ${elapsed_ms}ms`,
    `  type:    ${m.type}`,
    `  topics:  ${m.topics.length ? m.topics.join(', ') : '(none)'}`,
    `  people:  ${m.mentions.length ? m.mentions.join(', ') : '(none)'}`,
  ];

  if (m.action_items.length) {
    lines.push(`  actions: ${m.action_items.join(' · ')}`);
  }

  return lines.join('\n');
}
