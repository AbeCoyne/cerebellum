import { createClient } from '@supabase/supabase-js';
import { cfg } from './config.js';
import type { Thought, ThoughtMetadata, ThoughtWithSimilarity } from './types.js';

const supabase = createClient(cfg.supabase.url, cfg.supabase.serviceKey);

const TABLE      = cfg.env === 'test' ? 'thoughts_test' : 'thoughts';
const RPC_SEARCH = cfg.env === 'test' ? 'search_thoughts_test' : 'search_thoughts';
const RPC_STATS  = cfg.env === 'test' ? 'get_stats_test' : 'get_stats';

const THOUGHT_COLUMNS = 'id, content, metadata, source, cortex_source_type, cortex_source_id, embedding_model, parent_id, superseded_by, confidence, privacy_tier, created_at, updated_at';

export async function insertThought(
  content: string,
  embedding: number[],
  metadata: ThoughtMetadata,
  source: string,
  embeddingModel: string,
  cortexSourceType?: string,
  cortexSourceId?: string,
): Promise<Thought> {
  const row: Record<string, unknown> = {
    content,
    embedding: `[${embedding.join(',')}]`,
    metadata,
    source,
    embedding_model: embeddingModel,
  };
  if (cortexSourceType) row.cortex_source_type = cortexSourceType;
  if (cortexSourceId)   row.cortex_source_id   = cortexSourceId;

  const { data, error } = await supabase
    .from(TABLE)
    .insert(row)
    .select(THOUGHT_COLUMNS)
    .single();

  if (error) throw new Error(`DB insert failed: ${error.message}`);
  return data as Thought;
}

export async function upsertThoughtBySourceId(
  cortexSourceId: string,
  content: string,
  embedding: number[],
  metadata: ThoughtMetadata,
  source: string,
  embeddingModel: string,
  cortexSourceType?: string,
): Promise<Thought> {
  // Check if a thought with this source_id already exists
  const { data: existing } = await supabase
    .from(TABLE)
    .select(THOUGHT_COLUMNS)
    .eq('cortex_source_id', cortexSourceId)
    .maybeSingle();

  if (existing) {
    // UPDATE in place — created_at preserved, updated_at set by trigger
    const { data, error } = await supabase
      .from(TABLE)
      .update({
        content,
        embedding: `[${embedding.join(',')}]`,
        metadata,
        source,
        embedding_model: embeddingModel,
        ...(cortexSourceType ? { cortex_source_type: cortexSourceType } : {}),
      })
      .eq('cortex_source_id', cortexSourceId)
      .select(THOUGHT_COLUMNS)
      .single();
    if (error) throw new Error(`DB update thought failed: ${error.message}`);
    return data as Thought;
  }

  return insertThought(content, embedding, metadata, source, embeddingModel, cortexSourceType, cortexSourceId);
}

export async function deleteThoughtsBySourceId(cortexSourceId: string): Promise<number> {
  const { data, error } = await supabase
    .from(TABLE)
    .delete()
    .eq('cortex_source_id', cortexSourceId)
    .select('id');
  if (error) throw new Error(`DB delete by source_id failed: ${error.message}`);
  return data?.length ?? 0;
}

export async function searchByEmbedding(
  embedding: number[],
  limit = 10,
  threshold = 0,
): Promise<ThoughtWithSimilarity[]> {
  const { data, error } = await supabase.rpc(RPC_SEARCH, {
    query_embedding: `[${embedding.join(',')}]`,
    match_count: limit,
    threshold,
  });

  if (error) throw new Error(`DB search failed: ${error.message}`);
  return (data ?? []) as ThoughtWithSimilarity[];
}

export async function listRecent(
  days = 7,
  limit = 20,
): Promise<Thought[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from(TABLE)
    .select(THOUGHT_COLUMNS)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`DB list failed: ${error.message}`);
  return (data ?? []) as Thought[];
}

export async function countBySource(sourcePrefix: string): Promise<number> {
  const { count, error } = await supabase
    .from(TABLE)
    .select('*', { count: 'exact', head: true })
    .like('source', `${sourcePrefix}%`);

  if (error) throw new Error(`DB count failed: ${error.message}`);
  return count ?? 0;
}

export async function deleteBySource(sourcePrefix: string): Promise<number> {
  const { data, error } = await supabase
    .from(TABLE)
    .delete()
    .like('source', `${sourcePrefix}%`)
    .select('id');

  if (error) throw new Error(`DB delete failed: ${error.message}`);
  return data?.length ?? 0;
}

export async function getStats(): Promise<{
  total: number;
  by_type: Record<string, number>;
  top_topics: Array<{ topic: string; count: number }>;
  top_people: Array<{ person: string; count: number }>;
}> {
  const { data, error } = await supabase.rpc(RPC_STATS);

  if (error) throw new Error(`DB stats failed: ${error.message}`);

  const stats = data as {
    total: number;
    by_type: Record<string, number> | null;
    top_topics: Array<{ topic: string; count: number }> | null;
    top_people: Array<{ person: string; count: number }> | null;
  };

  return {
    total:      stats.total      ?? 0,
    by_type:    stats.by_type    ?? {},
    top_topics: stats.top_topics ?? [],
    top_people: stats.top_people ?? [],
  };
}

export async function deleteThought(id: string): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw new Error(`DB delete thought failed: ${error.message}`);
}

// ─── capture_queue ────────────────────────────────────────────────────────────

export interface CaptureQueueRow {
  id:             string;
  content:        string;
  source:         string;
  capture_reason: string | null;
  status:         'pending' | 'processing' | 'done' | 'failed';
  created_at:     string;
}

export async function fetchPendingCaptureQueue(limit = 20): Promise<CaptureQueueRow[]> {
  // Also recover rows stuck in 'processing' for more than 10 minutes
  const stuckCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('capture_queue')
    .select('id, content, source, capture_reason, status, created_at')
    .or(`status.eq.pending,and(status.eq.processing,created_at.lt.${stuckCutoff})`)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`DB capture_queue fetch failed: ${error.message}`);
  return (data ?? []) as CaptureQueueRow[];
}

export async function markCaptureQueueRow(
  id:     string,
  status: 'processing' | 'done' | 'failed',
): Promise<void> {
  const update: Record<string, unknown> = { status };
  if (status === 'done' || status === 'failed') {
    update.processed_at = new Date().toISOString();
  }
  const { error } = await supabase.from('capture_queue').update(update).eq('id', id);
  if (error) throw new Error(`DB capture_queue update failed: ${error.message}`);
}

export async function truncateTestTable(): Promise<number> {
  if (cfg.env !== 'test') throw new Error('truncateTestTable only allowed in test mode');
  const { data, error } = await supabase
    .from('thoughts_test')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000')
    .select('id');

  if (error) throw new Error(`DB truncate failed: ${error.message}`);
  return data?.length ?? 0;
}
