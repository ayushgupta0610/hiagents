export interface ChunkOptions {
  chunkSize: number;
  overlap: number;
}

export function chunkText(text: string, opts: ChunkOptions): string[] {
  if (!text || text.trim().length === 0) {
    throw new Error('chunkText: input is empty');
  }
  const { chunkSize, overlap } = opts;
  if (chunkSize <= 0) throw new Error('chunkSize must be positive');
  if (overlap < 0 || overlap >= chunkSize) {
    throw new Error('overlap must be >= 0 and < chunkSize');
  }

  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);
    // Prefer splitting at a paragraph break, but only if the break is past
    // the overlap zone — otherwise the next `start = end - overlap` would
    // not advance and we'd loop forever on the same paragraph break.
    if (end < text.length) {
      const slice = text.slice(start, end);
      const paraBreak = slice.lastIndexOf('\n\n');
      if (paraBreak > overlap) {
        end = start + paraBreak;
      }
    }
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    // Forward-progress guard: even if the paragraph-break logic above
    // somehow chose a regressive end, ensure start moves forward by at
    // least one character.
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}
