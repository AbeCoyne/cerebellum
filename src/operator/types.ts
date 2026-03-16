export interface WebEntry {
  id:              string;   // uuid
  content:         string;
  source:          string;   // cli | mcp | hook | …
  capture_reason?: string;
  arrived_at:      string;   // ISO
  expires_at:      string;   // ISO (arrived_at + ttl_hours)
  cluster_hint?:   string;   // Operator's note on why it's held
}
