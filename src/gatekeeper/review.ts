import { select } from '@inquirer/prompts';
import { readQueue, removeEntry } from './queue.js';
import { evaluate } from './index.js';
import { captureThought } from '../capture.js';
import { deleteThought } from '../db.js';
import { keypress } from '../cli/keypress.js';
import type { KeyChoice } from '../cli/keypress.js';
import type { QueueEntry } from './types.js';

function sourceTypeExtra(source: string): Record<string, string> | undefined {
  if (source.startsWith('n8n')) return { cortex_source_type: 'email' };
  return undefined;
}

type ReviewAction = 'keep' | 'drop' | 'axiom' | 'replace' | 'skip' | 'quit' | 'retry';

// ─── display helpers ──────────────────────────────────────────────────────────

function separator() { console.log(`\n${'─'.repeat(62)}`); }

function displayEntry(entry: QueueEntry, index: number, total: number): void {
  const { verdict, status, source, capture_reason, content, is_axiom } = entry;

  separator();
  console.log(`[${index + 1}/${total}]  ${source} captured:`);
  console.log(`\n       "${content}"\n`);

  if (capture_reason) {
    console.log(`  Capture reason: ${capture_reason}`);
  }

  if (is_axiom) {
    console.log(`  ⚡ Pre-flagged as axiom by you.`);
  }

  if (status === 'gate-failed') {
    console.log(`  ⚠  Gate evaluation failed — make a manual call.`);
    return;
  }

  if (!verdict) {
    console.log(`  ⏳ Still evaluating — try again in a moment.`);
    return;
  }

  // Contradiction (highest priority — show first)
  if (verdict.contradiction) {
    const { severity, summary, conflicting_thought_id } = verdict.contradiction;
    const idHint = conflicting_thought_id ? ` [${conflicting_thought_id.slice(0, 8)}…]` : '';
    if (severity === 'axiom_violation') {
      console.log(`  🚨 AXIOM VIOLATION${idHint}: ${summary}`);
    } else if (severity === 'hard') {
      console.log(`  ⚠  CONTRADICTION (hard)${idHint}: ${summary}`);
    } else {
      console.log(`  ↕  Soft contradiction${idHint}: ${summary}`);
    }
  }

  // Score + analysis
  const score = verdict.quality_score;
  const bar   = '█'.repeat(score) + '░'.repeat(10 - score);
  console.log(`  Gatekeeper [${score}/10 — ${verdict.label}]`);
  console.log(`  ${bar}`);
  console.log(`\n  ${verdict.analysis}`);

  if (verdict.reformulation) {
    console.log(`\n  → Suggested: "${verdict.reformulation}"`);
  }

  if (verdict.adversarial_note) {
    console.log(`\n  Adversarial: ${verdict.adversarial_note}`);
  }

  console.log('');
}

// ─── resolve one entry ────────────────────────────────────────────────────────

function buildChoices(entry: QueueEntry): KeyChoice<ReviewAction>[] {
  const quit: KeyChoice<ReviewAction> = { key: 'q', alias: 'escape', label: 'Quit', value: 'quit' };

  const hasConflict = !!entry.verdict?.contradiction?.conflicting_thought_id;

  if (entry.status === 'gate-failed') {
    return [
      { key: 'r', label: 'Retry',   value: 'retry' },
      { key: 'k', label: 'Keep',    value: 'keep'  },
      { key: 'a', label: 'Axiom',   value: 'axiom' },
      { key: 'd', label: 'Drop',    value: 'drop'  },
      { key: 's', label: 'Skip',    value: 'skip'  },
      quit,
    ];
  }

  const choices: KeyChoice<ReviewAction>[] = [
    { key: 'k', label: 'Keep',  value: 'keep'  },
    { key: 'd', label: 'Drop',  value: 'drop'  },
    { key: 'a', label: 'Axiom', value: 'axiom' },
    { key: 's', label: 'Skip',  value: 'skip'  },
    quit,
  ];

  if (hasConflict) {
    choices.splice(1, 0, { key: 'r', label: 'Replace (delete old)', value: 'replace' });
  }

  return choices;
}

/**
 * Returns true if the entry was resolved (removed from queue),
 * false if skipped, or 'quit' to break out of the review loop.
 */
async function resolveEntry(
  entry: QueueEntry,
  index: number,
  total: number,
): Promise<boolean | 'quit'> {
  let current = entry;

  while (true) {
    displayEntry(current, index, total);

    // Only true-pending entries (still evaluating) get silently skipped
    if (current.status === 'pending') return false;

    const choice = await keypress('Decision:', buildChoices(current));

    switch (choice) {

      case 'retry': {
        console.log('  ↺ Re-evaluating…');
        await evaluate(current);
        const updated = readQueue().find(e => e.id === current.id);
        if (!updated) return false;
        if (updated.status !== 'evaluated') {
          console.log('  ⚠  Re-evaluation failed again. Make a manual call.');
        }
        current = updated;
        continue;
      }

      case 'keep': {
        const extra = sourceTypeExtra(current.source);
        if (current.verdict?.reformulation) {
          const result = await _offerReformulation(current.verdict.reformulation, current.content);
          if (result.tag === 'back') continue;
          await captureThought(result.value, current.source, undefined, extra);
        } else {
          await captureThought(current.content, current.source, undefined, extra);
        }
        process.stdout.write(' → ✓ Stored.\n');
        removeEntry(current.id);
        return true;
      }

      case 'axiom': {
        const extra = sourceTypeExtra(current.source);
        if (current.verdict?.reformulation) {
          const result = await _offerReformulation(current.verdict.reformulation, current.content);
          if (result.tag === 'back') continue;
          await captureThought(result.value, current.source, 'axiom', extra);
        } else {
          await captureThought(current.content, current.source, 'axiom', extra);
        }
        process.stdout.write(' → ✓ Stored as axiom.\n');
        removeEntry(current.id);
        return true;
      }

      case 'replace': {
        const conflictId = current.verdict?.contradiction?.conflicting_thought_id;
        if (!conflictId) { console.log('  No conflicting thought ID — use Keep instead.'); continue; }
        const content = current.verdict?.reformulation
          ? (await _offerReformulation(current.verdict.reformulation, current.content)).tag === 'back'
            ? null
            : current.verdict.reformulation
          : current.content;
        if (content === null) continue;
        try {
          await deleteThought(conflictId);
          process.stdout.write(` → ✓ Deleted old thought [${conflictId.slice(0, 8)}…]\n`);
        } catch (err) {
          console.log(`  ⚠  Could not delete old thought: ${err instanceof Error ? err.message : err}`);
        }
        await captureThought(content, current.source, undefined, sourceTypeExtra(current.source));
        process.stdout.write(' → ✓ Stored replacement.\n');
        removeEntry(current.id);
        return true;
      }

      case 'drop': {
        process.stdout.write(' → ✓ Discarded.\n');
        removeEntry(current.id);
        return true;
      }

      case 'quit':
        return 'quit';

      case 'skip':
      default:
        process.stdout.write(' → Skipped.\n');
        return false;
    }
  }
}

type ReformulationResult = { tag: 'back' } | { tag: 'content'; value: string };

async function _offerReformulation(
  reformulation: string,
  original: string,
): Promise<ReformulationResult> {
  const ac = new AbortController();
  const onEsc = (_s: unknown, key: { name?: string }) => {
    if (key?.name === 'escape') ac.abort();
  };
  process.stdin.on('keypress', onEsc);
  let choice: string;
  try {
    choice = await select({
      message: 'Which version to store?',
      choices: [
        { name: `Suggested: "${reformulation}"`, value: 'reformulated' },
        { name: `Original:  "${original}"`,      value: 'original'     },
        { name: '← Back',                        value: 'back'         },
      ],
    }, { signal: ac.signal });
  } catch {
    return { tag: 'back' };
  } finally {
    process.stdin.removeListener('keypress', onEsc);
  }
  if (choice === 'back') return { tag: 'back' };
  return { tag: 'content', value: choice === 'reformulated' ? reformulation : original };
}

// ─── public API ───────────────────────────────────────────────────────────────

export async function runReview(): Promise<void> {
  const allEntries = readQueue();
  const ready = allEntries.filter(
    e => e.status === 'evaluated' || e.status === 'gate-failed',
  );

  if (!ready.length) {
    const pending = allEntries.filter(e => e.status === 'pending').length;
    if (pending > 0) {
      console.log(`\n${pending} item${pending > 1 ? 's' : ''} still being evaluated. Try again shortly.`);
    } else {
      console.log('\nNo items in queue.');
    }
    return;
  }

  console.log(`\n📋 Queue: ${ready.length} item${ready.length > 1 ? 's' : ''} to review`);

  let reviewed = 0;
  let quit = false;

  for (let i = 0; i < ready.length; i++) {
    const current = readQueue();
    const entry   = current.find(e => e.id === ready[i].id);
    if (!entry) continue; // already removed

    const resolved = await resolveEntry(entry, i, ready.length);
    if (resolved === 'quit') { quit = true; break; }
    if (resolved) reviewed++;
  }

  const remaining = readQueue().filter(
    e => e.status === 'evaluated' || e.status === 'gate-failed',
  ).length;

  separator();
  if (quit) {
    console.log(`✓ Reviewed ${reviewed}. Quit with ${remaining} remaining in queue.`);
  } else if (remaining > 0) {
    console.log(`✓ Done. ${reviewed} stored  •  ${remaining} skipped (still in queue).`);
  } else {
    console.log(`✓ Queue cleared. ${reviewed} thought${reviewed !== 1 ? 's' : ''} stored.`);
  }
}
