import { readFileSync, readdirSync, existsSync, Dirent } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { cfg } from '../config.js';
import { countBySource, deleteBySource } from '../db.js';
import { readQueue, removeEntry } from '../gatekeeper/queue.js';
import { runBatch } from './seed.js';
import { distillFile } from '../importers/distill.js';
import { parseMarkdown } from '../importers/markdown.js';
import type { SeedEntry } from './seed.js';

// ─── types ────────────────────────────────────────────────────────────────────

type Platform   = 'claude' | 'cursor' | 'gemini' | 'memory';
type Mode       = 'distill' | 'parse';

const PLATFORM_LABELS: Record<Platform, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  gemini: 'Gemini',
  memory: 'Claude Memory Notes',
};

// ─── file discovery ───────────────────────────────────────────────────────────

function discoverFiles(platform: Platform): string[] {
  const home = homedir();
  switch (platform) {
    case 'claude':
      return [
        join(home, '.claude', 'CLAUDE.md'),
        join(process.cwd(), 'CLAUDE.md'),
      ].filter(p => existsSync(p));

    case 'cursor':
      return [
        join(process.cwd(), '.cursorrules'),
        join(process.cwd(), 'CURSOR.md'),
      ].filter(p => existsSync(p));

    case 'gemini':
      return [join(process.cwd(), 'GEMINI.md')].filter(p => existsSync(p));

    case 'memory': {
      const projectsDir = join(home, '.claude', 'projects');
      if (!existsSync(projectsDir)) return [];
      const files: string[] = [];
      for (const slug of readdirSync(projectsDir)) {
        const memDir = join(projectsDir, slug, 'memory');
        if (!existsSync(memDir)) continue;
        for (const dirent of readdirSync(memDir, { withFileTypes: true }) as Dirent[]) {
          if (dirent.isFile() && dirent.name.endsWith('.md'))
            files.push(join(memDir, dirent.name));
        }
      }
      return files;
    }
  }
}

// ─── extraction ───────────────────────────────────────────────────────────────

async function extractFromFile(
  filePath: string,
  platform: Platform,
  mode: Mode,
): Promise<SeedEntry[]> {
  const content = readFileSync(filePath, 'utf-8');
  const entries = mode === 'distill'
    ? await distillFile(content, PLATFORM_LABELS[platform])
    : parseMarkdown(content);

  // Tag each entry so runBatch builds source = 'import:<platform>'
  return entries.map(e => ({ ...e, source_tag: platform }));
}

// ─── public command ───────────────────────────────────────────────────────────

export interface ImportOptions {
  platform:     Platform;
  explicitPath: string | undefined;
  mode:         Mode;
  dryRun:       boolean;
  undo:         boolean;
  force:        boolean;
}

export async function cmd_import(opts: ImportOptions): Promise<void> {
  const { platform, explicitPath, mode, dryRun, undo, force } = opts;
  const sourcePrefix = 'import';

  // ── undo ────────────────────────────────────────────────────────────────────
  if (undo) {
    const prefix     = `import:${platform}`;
    const queueItems = readQueue().filter(e => e.source.startsWith(prefix));
    if (dryRun) {
      const existingDb = await countBySource(prefix);
      const total      = existingDb + queueItems.length;
      console.log(`Would delete ${total} thought${total !== 1 ? 's' : ''} (${existingDb} in DB, ${queueItems.length} in queue). Remove --dry-run to execute.`);
      return;
    }
    console.log(`Deleting all thoughts with source starting with "${prefix}"...`);
    const dbCount = await deleteBySource(prefix);
    for (const e of queueItems) removeEntry(e.id);
    const total = dbCount + queueItems.length;
    console.log(`✓ Deleted ${total} thought${total !== 1 ? 's' : ''} (${dbCount} from DB, ${queueItems.length} from queue).`);
    return;
  }

  // ── dedup guard ─────────────────────────────────────────────────────────────
  if (!force && !dryRun) {
    const prefix        = `import:${platform}`;
    const existingDb    = await countBySource(prefix);
    const existingQueue = readQueue().filter(e => e.source.startsWith(prefix)).length;
    const existing      = existingDb + existingQueue;
    if (existing > 0) {
      console.error(
        `⚠  Found ${existing} existing import:${platform} thought${existing !== 1 ? 's' : ''} (${existingDb} in DB, ${existingQueue} in queue).\n` +
        `   Re-importing will create duplicates.\n` +
        `   Use --undo to clear first, or --force to proceed anyway.`,
      );
      process.exit(1);
    }
  }

  // ── file resolution ─────────────────────────────────────────────────────────
  const files = explicitPath ? [explicitPath] : discoverFiles(platform);

  if (files.length === 0) {
    console.error(`No files found for --${platform}. Pass an explicit path to override.`);
    process.exit(1);
  }

  console.log(`\nFiles to process (${files.length}):`);
  for (const f of files) console.log(`  ${f}`);
  console.log();

  // ── extraction ──────────────────────────────────────────────────────────────
  const allEntries: SeedEntry[] = [];

  for (const filePath of files) {
    process.stdout.write(`  Extracting ${filePath.split('/').pop()}...`);
    try {
      const entries = await extractFromFile(filePath, platform, mode);
      process.stdout.write(` ${entries.length} entries\n`);
      allEntries.push(...entries);
    } catch (err) {
      process.stdout.write(` ✗ failed\n`);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    Error: ${msg}`);
    }
  }

  if (allEntries.length === 0) {
    console.log('\nNo entries extracted. Nothing to import.');
    return;
  }

  // ── dry run ─────────────────────────────────────────────────────────────────
  if (dryRun) {
    console.log(`\n${allEntries.length} entries (dry run — nothing written):\n`);
    for (const [i, e] of allEntries.entries()) {
      const type    = e.type ?? '(auto)';
      const preview = e.content.length > 72 ? e.content.slice(0, 69) + '...' : e.content;
      console.log(`  [${i + 1}] ${type.padEnd(12)} "${preview}"`);
    }
    console.log(`\nRemove --dry-run to capture.`);
    return;
  }

  // ── capture ─────────────────────────────────────────────────────────────────
  const pipelineLabels: Record<string, string> = {
    direct: 'direct to DB',
    gk:     'GK queue (memo review)',
    full:   'Operator → GK queue',
  };
  console.log(`Pipeline: ${pipelineLabels[cfg.import.pipeline] ?? cfg.import.pipeline}`);
  console.log(`Mode: ${mode}`);
  console.log(`Capturing ${allEntries.length} entries (concurrency 3)...\n`);

  const { stored, failed, errors } = await runBatch(allEntries, 3, {
    pipeline:     cfg.import.pipeline,
    sourcePrefix,
  });

  console.log(`\n✓ Done. ${stored} sent to pipeline, ${failed} failed.`);
  if (cfg.import.pipeline !== 'direct') {
    console.log(`  Run 'memo review' to evaluate and store.`);
  }
  if (errors.length) {
    console.log('\nErrors:');
    for (const e of errors) console.log(`  ${e}`);
  }
}
