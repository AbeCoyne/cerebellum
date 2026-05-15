export type ThoughtType =
  | 'observation'
  | 'task'
  | 'idea'
  | 'reference'
  | 'people'
  | 'preference'
  | 'axiom';        // permanent directive; confidence stays at 1.0

export interface ThoughtMetadata {
  type:         ThoughtType;
  topics:       string[];
  mentions:     string[];
  action_items: string[];
  refs?:        string[];
}

export interface Thought {
  id:                  string;
  content:             string;
  metadata:            ThoughtMetadata;
  source:              string;
  cortex_source_type:  string | null;
  embedding_model:     string;
  parent_id:           string | null;
  superseded_by:       string | null;
  confidence:          number;
  privacy_tier:        string;
  created_at:          string;
}

export interface ThoughtWithSimilarity extends Thought {
  similarity: number;
}
