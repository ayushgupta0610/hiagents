import { PDFParse } from 'pdf-parse';

export interface ExtractedPdf {
  text: string;
  pageCount: number;
}

/**
 * Extract plain text from a PDF buffer.
 *
 * Uses pdf-parse v2 (class-based API) to load the document and pull
 * concatenated text across pages, then normalizes line endings and
 * collapses runs of blank lines.
 *
 * Throws when the PDF yields no extractable text — typically a scanned
 * or image-only document that would require OCR.
 */
export async function extractPdf(buffer: Buffer): Promise<ExtractedPdf> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    const cleaned = result.text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (cleaned.length === 0) {
      throw new Error(
        'PDF contains no extractable text (may be scanned/image-only)',
      );
    }
    return { text: cleaned, pageCount: result.total };
  } finally {
    await parser.destroy();
  }
}
