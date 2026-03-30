import { createClient } from '@supabase/supabase-js';
import { cfg } from './config.js';
import type { Thought, ThoughtMetadata, ThoughtWithSimilarity } from './types.js';

const supabase = createClient(cfg.supabase.url, cfg.supabase.serviceKey);

const TABLE      = cfg.env === 'test' ? 'thoughts_test' : 'thoughts';
const RPC_SEARCH = cfg.env === 'test' ? 'search_thoughts_test' : 'search_thoughts';
const RPC_STATS  = cfg.env === 'test' ? 'get_stats_test' : 'get_stats';

const THOUGHT_COLUMNS = 'id, content, metadata, source, embedding_model, parent_id, superseded_by, confidence, privacy_tier, created_at';

export async function insertThought(
  content: string,
  embedding: number[],
  metadata: ThoughtMetadata,
  source: string,
  embeddingModel: string,
): Promise<Thought> {
  const { data, error } = await supabase
    .from(TABLE)
    .insert({ content, embedding: `[${embedding.join(',')}]`, metadata, source, embedding_model: embeddingModel })
    .select(THOUGHT_COLUMNS)
    .single();

  if (error) throw new Error(`DB insert failed: ${error.message}`);
  return data as Thought;
}

export async function searchByEmbedding(
  embedding: number[],
  limit = 10,
  threshold = 0.5,
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
