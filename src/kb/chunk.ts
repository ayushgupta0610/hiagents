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
  const stride = chunkSize - overlap;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);
    // Prefer splitting at the nearest paragraph break before `end`
    if (end < text.length) {
      const slice = text.slice(start, end);
      const paraBreak = slice.lastIndexOf('\n\n');
      if (paraBreak > 0) {
        end = start + paraBreak;
      }
    }
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - overlap;
  }

  return chunks;
}
