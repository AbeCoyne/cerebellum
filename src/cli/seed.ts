import { readFileSync } from 'fs';
import { captureThought } from '../capture.js';
import { enqueue } from '../gatekeeper/queue.js';
import { intake } from '../operator/index.js';
import { deleteBySource } from '../db.js';
import { cfg } from '../config.js';
import type { ThoughtType } from '../types.js';

export interface SeedEntry {
  content: string;
  type?: ThoughtType;
  source_tag?: string;  // appended to 'seed:' — e.g. 'memory', 'plan', 'git', 'prefs'
}

function parseFile(path: string): SeedEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const detail = err instanceof Error ? ` (${err.message})` : '';
    throw new Error(`Cannot read seed file: ${path}${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? ` (${err.message})` : '';
    throw new Error(`Invalid JSON in seed file: ${path}${detail}`);
  }
  if (!Array.isArray(parsed)) throw new Error('Seed file must be a JSON array');

  for (const [i, entry] of parsed.entries()) {
    if (!entry.content || typeof entry.content !== 'string' || !entry.content.trim()) {
      throw new Error(`Entry ${i} has empty or missing content`);
    }
  }
  return parsed as SeedEntry[];
}

async function routeEntry(
  entry: SeedEntry,
  source: string,
  pipeline: 'direct' | 'gk' | 'full',
): Promise<string> {
  if (pipeline === 'gk') {
    enqueue(entry.content, source, undefined, entry.type === 'axiom');
    return 'queued';
  }
  if (pipeline === 'full') {
    await intake(entry.content, source);
    return 'held';
  }
  // 'direct'
  const result = await captureThought(entry.content, source, entry.type);
  return result.thought.metadata.type ?? 'stored';
}

export async function runBatch(
  entries: SeedEntry[],
  concurrency: number,
  opts: { pipeline?: 'direct' | 'gk' | 'full'; sourcePrefix?: string } = {},
): Promise<{ stored: number; failed: number; errors: string[] }> {
  const pipeline     = opts.pipeline     ?? cfg.seed.pipeline;
  const sourcePrefix = opts.sourcePrefix ?? 'seed';
  let stored = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((entry, j) => {
        const idx = i + j;
        const source = `${sourcePrefix}:${entry.source_tag ?? 'unknown'}`;
        return routeEntry(entry, source, pipeline).then(label => {
          stored++;
          const preview = entry.content.length > 60
            ? entry.content.slice(0, 57) + '...'
            : entry.content;
          console.log(`  [${idx + 1}/${entries.length}] ✓ ${label} — "${preview}"`);
        });
      }),
    );

    for (const [j, result] of results.entries()) {
      if (result.status === 'rejected') {
        const idx = i + j;
        failed++;
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push(`[${idx + 1}] ${msg}`);
        console.error(`  [${idx + 1}/${entries.length}] ✗ ${msg}`);
      }
    }
  }

  return { stored, failed, errors };
}

export async function cmd_seed(filePath: string, dryRun: boolean, inject = false): Promise<void> {
  const entries = parseFile(filePath);

  console.log(`\n${entries.length} entries in ${filePath}\n`);

  if (dryRun) {
    for (const [i, entry] of entries.entries()) {
      const tag = entry.source_tag ?? 'unknown';
      const type = entry.type ?? '(auto)';
      const preview = entry.content.length > 70
        ? entry.content.slice(0, 67) + '...'
        : entry.content;
      console.log(`  [${i + 1}] ${tag} / ${type} — "${preview}"`);
    }
    console.log(`\nDry run — nothing written. Remove --dry-run to capture.`);
    return;
  }

  const pipeline = inject ? 'direct' : cfg.seed.pipeline;
  const pipelineLabel = { direct: 'direct to DB', gk: 'GK queue (memo review)', full: 'Operator → GK queue' }[pipeline as string] ?? pipeline;
  console.log(`Pipeline: ${pipelineLabel}`);
  console.log(`Capturing ${entries.length} thoughts (concurrency 3)...\n`);
  const { stored, failed, errors } = await runBatch(entries, 3, { pipeline: pipeline as 'direct' | 'gk' | 'full' });

  console.log(`\n✓ Done. ${stored} stored, ${failed} failed.`);
  if (errors.length) {
    console.log('\nErrors:');
    for (const err of errors) console.log(`  ${err}`);
  }
}

export async function cmd_seed_undo(): Promise<void> {
  console.log('Deleting all thoughts with source starting with "seed:"...');
  const count = await deleteBySource('seed:');
  console.log(`✓ Deleted ${count} seeded thought${count !== 1 ? 's' : ''}.`);
}
