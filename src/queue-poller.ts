import { enqueue } from './gatekeeper/queue.js';
import { evaluate } from './gatekeeper/index.js';
import { fetchPendingCaptureQueue, markCaptureQueueRow } from './db.js';

const POLL_INTERVAL_MS = 30_000;

async function poll(): Promise<void> {
  let rows;
  try {
    rows = await fetchPendingCaptureQueue(20);
  } catch (err) {
    console.error('[queue-poller] Failed to fetch capture_queue:', err instanceof Error ? err.message : err);
    return;
  }

  for (const row of rows) {
    try {
      await markCaptureQueueRow(row.id, 'processing');
      const entry = enqueue(
        row.content,
        row.source,
        row.capture_reason ?? undefined,
      );
      await evaluate(entry);
      await markCaptureQueueRow(row.id, 'done');
    } catch (err) {
      console.error(`[queue-poller] Failed to process row ${row.id}:`, err instanceof Error ? err.message : err);
      try { await markCaptureQueueRow(row.id, 'failed'); } catch { /* best effort */ }
    }
  }
}

export function startQueuePoller(): void {
  // Run once immediately on startup, then on interval
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
  console.log(`[queue-poller] Polling capture_queue every ${POLL_INTERVAL_MS / 1000}s`);
}
