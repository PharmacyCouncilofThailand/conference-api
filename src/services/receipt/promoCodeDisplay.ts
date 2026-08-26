const ZERO_WIDTH_SPACE = "\u200B";

export function formatPromoCodeForReceipt(code: string, chunkSize = 12): string {
  if (code.length <= chunkSize) return code;

  const chunks: string[] = [];
  for (let index = 0; index < code.length; index += chunkSize) {
    chunks.push(code.slice(index, index + chunkSize));
  }

  return chunks.join(ZERO_WIDTH_SPACE);
}
