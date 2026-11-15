/** Bound UTF-16 length without leaving an unmatched high surrogate at the cut. */
export function truncateText(text: string, maxLength: number): string {
  const truncated = text.slice(0, maxLength);
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF
    ? truncated.slice(0, -1)
    : truncated;
}
