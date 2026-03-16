import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { cfg } from '../config.js';
import type { WebEntry } from './types.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── read / write ─────────────────────────────────────────────────────────────

export function readWeb(): WebEntry[] {
  const path = cfg.operator.webPath;
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as WebEntry[];
  } catch {
    console.warn('[operator] Could not parse web.json — treating as empty');
    return [];
  }
}

/**
 * Atomic write: write to temp file then rename() so web.json is never
 * partially written even on kill -9.
 */
function writeWeb(entries: WebEntry[]): void {
  const path = cfg.operator.webPath;
  ensureDir(path);
  const tmp = join(dirname(path), `.cerebellum-web-${Date.now()}-${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf-8');
  renameSync(tmp, path);
}

// ─── public API ───────────────────────────────────────────────────────────────

export function addEntry(entry: WebEntry): void {
  const entries = readWeb();
  writeWeb([...entries, entry]);
}

export function updateEntry(id: string, patch: Partial<WebEntry>): void {
  const entries = readWeb();
  writeWeb(entries.map(e => (e.id === id ? { ...e, ...patch } : e)));
}

export function removeEntries(ids: string[]): void {
  const idSet = new Set(ids);
  writeWeb(readWeb().filter(e => !idSet.has(e.id)));
}
