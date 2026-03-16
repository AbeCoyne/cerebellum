import { select } from '@inquirer/prompts';
import { readWeb, removeEntries } from '../operator/web.js';
import { enqueue } from '../gatekeeper/queue.js';
import { evaluate } from '../gatekeeper/index.js';
import { intake } from '../operator/index.js';
import type { WebEntry } from '../operator/types.js';

// ─── display helpers ──────────────────────────────────────────────────────────

function separator() { console.log(`\n${'─'.repeat(62)}`); }

function fmtDuration(ms: number): string {
  const mins  = Math.floor(ms / 60_000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  if (days > 0)  return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}

function displayEntry(entry: WebEntry, index: number, total: number): void {
  separator();
  const arrivedMs    = Date.now() - new Date(entry.arrived_at).getTime();
  const expiresMs    = new Date(entry.expires_at).getTime() - Date.now();
  const expiresLabel = expiresMs > 0 ? `expires in ${fmtDuration(expiresMs)}` : 'EXPIRED';

  console.log(`[${index + 1}/${total}]  ${entry.source}  arrived ${fmtDuration(arrivedMs)} ago  (${expiresLabel})`);
  console.log(`\n       "${entry.content}"\n`);

  if (entry.capture_reason) {
    console.log(`  Capture reason: ${entry.capture_reason}`);
  }
  if (entry.cluster_hint) {
    console.log(`  Cluster hint: ${entry.cluster_hint}`);
  }
  console.log('');
}

// ─── force-synthesise ─────────────────────────────────────────────────────────

/**
 * Run Operator on the current cluster right now, routed from this entry.
 * Uses intake() so the same LLM evaluation path is used, but we remove
 * the entry first to avoid it appearing as a duplicate in the web buffer.
 */
async function forceSynthesise(entry: WebEntry): Promise<void> {
  removeEntries([entry.id]);
  await intake(entry.content, entry.source, entry.capture_reason);
  console.log('  ↺ Re-evaluation triggered — check results in a moment.');
}

// ─── resolve one entry ────────────────────────────────────────────────────────

async function resolveEntry(entry: WebEntry, index: number, total: number): Promise<boolean> {
  displayEntry(entry, index, total);

  const choice = await select({
    message: 'Decision:',
    choices: [
      { name: '↺ Re-evaluate now',  value: 'synthesise' },
      { name: '→ Pass through',     value: 'pass'       },
      { name: '✗ Discard',          value: 'discard'    },
      { name: '⟳ Skip',             value: 'skip'       },
    ],
  });

  switch (choice) {
    case 'synthesise': {
      await forceSynthesise(entry);
      return true;
    }

    case 'pass': {
      // Re-read post-prompt — a "Re-evaluate now" background run may have
      // already synthesised and removed this entry during the select delay.
      if (!readWeb().some(e => e.id === entry.id)) {
        console.log('  ↳ Already handled by background evaluation — skipping.');
        return true;
      }
      removeEntries([entry.id]);
      const gkEntry = enqueue(entry.content, entry.source, entry.capture_reason);
      evaluate(gkEntry).catch(err =>
        console.error('[gate] background evaluation error:', err),
      );
      console.log('  ✓ Sent straight to GK queue.');
      return true;
    }

    case 'discard': {
      removeEntries([entry.id]);
      console.log('  ✓ Discarded.');
      return true;
    }

    case 'skip':
    default:
      console.log('  → Skipped (stays in web).');
      return false;
  }
}

// ─── public API ───────────────────────────────────────────────────────────────

export async function runWebReview(): Promise<void> {
  const entries = readWeb();

  if (!entries.length) {
    console.log('\nWeb buffer is empty.');
    return;
  }

  console.log(`\n📌 Web: ${entries.length} entr${entries.length > 1 ? 'ies' : 'y'} held`);

  let actioned = 0;

  for (let i = 0; i < entries.length; i++) {
    const current = readWeb();
    const entry   = current.find(e => e.id === entries[i].id);
    if (!entry) continue; // already removed (e.g. synthesised with another)

    const resolved = await resolveEntry(entry, i, entries.length);
    if (resolved) actioned++;
  }

  const remaining = readWeb().length;

  separator();
  if (remaining > 0) {
    console.log(`✓ Done. ${actioned} actioned  •  ${remaining} still held.`);
  } else {
    console.log(`✓ Web buffer cleared. ${actioned} entr${actioned !== 1 ? 'ies' : 'y'} actioned.`);
  }
}
