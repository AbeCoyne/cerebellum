import type { SeedEntry } from '../cli/seed.js';

/**
 * Structural parse: split markdown by headings and top-level bullets.
 * Each chunk becomes a SeedEntry (type auto-classified downstream).
 * Use as a zero-LLM-cost alternative to distillFile for well-structured files.
 */
export function parseMarkdown(content: string): SeedEntry[] {
  const entries: SeedEntry[] = [];
  let buffer: string[] = [];
  let pendingHeading: string | null = null;

  function flush(): void {
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length > 10) entries.push({ content: text });
    buffer = [];
    // pendingHeading is intentionally NOT reset here — it persists until consumed
    // by following content, or discarded when the next heading replaces it.
  }

  for (const raw of content.split('\n')) {
    const line = raw.trim();

    // Skip blanks, frontmatter delimiters, HTML comments
    if (!line || line === '---' || line.startsWith('<!--')) continue;

    if (line.startsWith('#')) {
      flush();
      const text = line.replace(/^#+\s*/, '').trim();
      pendingHeading = text || null;
    } else if (/^[-*]\s/.test(line)) {
      flush();
      const text = line.replace(/^[-*]\s+/, '').replace(/\*\*/g, '').trim();
      if (text) {
        if (pendingHeading) buffer.push(pendingHeading);
        pendingHeading = null;
        buffer.push(text);
      }
    } else {
      if (pendingHeading && buffer.length === 0) {
        buffer.push(pendingHeading);
        pendingHeading = null;
      }
      buffer.push(line);
    }
  }
  flush();

  return entries;
}
