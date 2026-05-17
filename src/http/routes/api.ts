import { Router, Request, Response } from 'express';
import { captureThought } from '../../capture.js';
import { searchByEmbedding, listRecent, getStats, deleteThought, deleteThoughtsBySourceId } from '../../db.js';
import { generateEmbedding } from '../../embeddings.js';
import { readQueue, removeEntry } from '../../gatekeeper/queue.js';

function sourceTypeExtra(source: string): Record<string, string> | undefined {
  if (source.startsWith('n8n')) return { cortex_source_type: 'morning_briefing' };
  return undefined;
}

export const router = Router();

/**
 * POST /capture
 * Capture a new thought from API
 */
router.post('/capture', async (req: Request, res: Response) => {
  try {
    const { content, cortex_source_type, cortex_source_id, cortex_title, cortex_multi_chunk, source } = req.body as {
      content?: string;
      cortex_source_type?: string;
      cortex_source_id?: string;
      cortex_title?: string;
      cortex_multi_chunk?: boolean;
      source?: string;
    };

    // Validate required field
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'Missing or invalid required field: content' });
      return;
    }

    // Temporary debug log — remove after confirming cortex_multi_chunk delivery
    if (cortex_source_id) {
      console.log(`[capture-debug] source=${source} multi_chunk=${cortex_multi_chunk} (type=${typeof cortex_multi_chunk}) source_id=${cortex_source_id.slice(0,8)}`);
    }

    // cortex_source_type goes to its own column; cortex_source_id / cortex_title / cortex_multi_chunk passed as extra
    const extra: Record<string, unknown> = {};
    if (cortex_source_type)               extra.cortex_source_type  = cortex_source_type;
    if (cortex_source_id)                 extra.cortex_source_id    = cortex_source_id;
    if (cortex_title)                     extra.cortex_title         = cortex_title;
    if (cortex_multi_chunk !== undefined) extra.cortex_multi_chunk   = cortex_multi_chunk;

    // Capture — caller can pass a source; default to 'api'
    const result = await captureThought(content, source ?? 'api', undefined, Object.keys(extra).length ? extra : undefined);

    res.json({
      success: true,
      id: result.thought.id,
      elapsed_ms: result.elapsed_ms,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /search?q=&limit=&threshold=
 * Search thoughts by semantic similarity
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const { q, limit, threshold } = req.query;

    // Validate required field
    if (!q || typeof q !== 'string') {
      res.status(400).json({ error: 'Missing or invalid required parameter: q' });
      return;
    }

    // Parse optional params with defaults
    const searchLimit = limit ? parseInt(limit as string, 10) : 10;
    const searchThreshold = threshold ? parseFloat(threshold as string) : 0.5;

    // Validate parsed values
    if (isNaN(searchLimit) || searchLimit < 1) {
      res.status(400).json({ error: 'limit must be a positive integer' });
      return;
    }
    if (isNaN(searchThreshold) || searchThreshold < 0 || searchThreshold > 1) {
      res.status(400).json({ error: 'threshold must be a number between 0 and 1' });
      return;
    }

    // Generate embedding for query
    const embedding = await generateEmbedding(q);

    // Search by embedding
    const results = await searchByEmbedding(embedding, searchLimit, searchThreshold);

    res.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /recent?days=&limit=
 * Get recent thoughts
 */
router.get('/recent', async (req: Request, res: Response) => {
  try {
    const { days, limit } = req.query;

    // Parse optional params with defaults
    const recentDays = days ? parseInt(days as string, 10) : 7;
    const recentLimit = limit ? parseInt(limit as string, 10) : 20;

    // Validate parsed values
    if (isNaN(recentDays) || recentDays < 1) {
      res.status(400).json({ error: 'days must be a positive integer' });
      return;
    }
    if (isNaN(recentLimit) || recentLimit < 1) {
      res.status(400).json({ error: 'limit must be a positive integer' });
      return;
    }

    // Get recent thoughts
    const thoughts = await listRecent(recentDays, recentLimit);

    res.json({ thoughts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /stats
 * Get system statistics
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ─── Gatekeeper queue endpoints (for CORTEX Settings review UI) ───────────────

/**
 * GET /queue
 * Returns all reviewable queue entries (status: evaluated or gate-failed).
 * Pending entries (still being evaluated by the Operator) are excluded.
 */
router.get('/queue', (_req: Request, res: Response) => {
  try {
    const all = readQueue();
    const reviewable = all.filter(
      e => e.status === 'evaluated' || e.status === 'gate-failed',
    );
    res.json({ entries: reviewable, total: reviewable.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /queue/:id/keep
 * Store the thought as-is (or use the Gatekeeper's reformulation if requested).
 * Body: { useReformulation?: boolean }
 */
router.post('/queue/:id/keep', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { useReformulation = false } = req.body as { useReformulation?: boolean };

    const entry = readQueue().find(e => e.id === id);
    if (!entry) { res.status(404).json({ error: 'Entry not found' }); return; }

    const content = useReformulation && entry.verdict?.reformulation
      ? entry.verdict.reformulation
      : entry.content;

    await captureThought(content, entry.source, undefined, sourceTypeExtra(entry.source));
    removeEntry(id);
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /queue/:id/drop
 * Discard the entry without storing it.
 */
router.post('/queue/:id/drop', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const entry = readQueue().find(e => e.id === id);
    if (!entry) { res.status(404).json({ error: 'Entry not found' }); return; }
    removeEntry(id);
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /queue/:id/axiom
 * Store the thought as a permanent axiom.
 * Body: { useReformulation?: boolean }
 */
router.post('/queue/:id/axiom', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { useReformulation = false } = req.body as { useReformulation?: boolean };

    const entry = readQueue().find(e => e.id === id);
    if (!entry) { res.status(404).json({ error: 'Entry not found' }); return; }

    const content = useReformulation && entry.verdict?.reformulation
      ? entry.verdict.reformulation
      : entry.content;

    await captureThought(content, entry.source, 'axiom', sourceTypeExtra(entry.source));
    removeEntry(id);
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /queue/:id/replace
 * Delete the conflicting thought from the DB, then store the new one.
 * Body: { useReformulation?: boolean }
 */
router.post('/queue/:id/replace', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { useReformulation = false } = req.body as { useReformulation?: boolean };

    const entry = readQueue().find(e => e.id === id);
    if (!entry) { res.status(404).json({ error: 'Entry not found' }); return; }

    const conflictId = entry.verdict?.contradiction?.conflicting_thought_id;
    if (!conflictId) { res.status(400).json({ error: 'No conflicting thought ID on this entry' }); return; }

    const content = useReformulation && entry.verdict?.reformulation
      ? entry.verdict.reformulation
      : entry.content;

    await deleteThought(conflictId);
    await captureThought(content, entry.source, undefined, sourceTypeExtra(entry.source));
    removeEntry(id);
    res.json({ success: true, replaced: conflictId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /queue/:id/edit
 * Store the thought with custom edited content.
 * Body: { content: string }
 */
router.post('/queue/:id/edit', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { content } = req.body as { content?: string };

    if (!content || typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const entry = readQueue().find(e => e.id === id);
    if (!entry) { res.status(404).json({ error: 'Entry not found' }); return; }

    await captureThought(content.trim(), entry.source, undefined, sourceTypeExtra(entry.source));
    removeEntry(id);
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * DELETE /thoughts/by-source/:sourceId
 * Delete all thoughts linked to a cortex_source_id.
 * Used by notes/documents when content is replaced wholesale.
 */
router.delete('/thoughts/by-source/:sourceId', async (req: Request, res: Response) => {
  try {
    const sourceId = String(req.params.sourceId);
    const deleted = await deleteThoughtsBySourceId(sourceId);
    res.json({ success: true, deleted });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});
