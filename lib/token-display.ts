/**
 * Formats token counts compactly using 'k' (thousands) and 'M' (millions).
 *
 * Rules:
 * - 0 or negative: '0'
 * - < 1000: exact integer (e.g. 500 -> '500')
 * - 1k .. <10k: 1 decimal place (e.g. 1450 -> '1.5k', 3000 -> '3k')
 * - 10k .. <1M: rounded integer in k (e.g. 61281 -> '61k', 206841 -> '207k', 841735 -> '842k')
 * - >= 1M: up to 2 decimal places in M (e.g. 1048576 -> '1.05M', 19089325 -> '19.09M', 19964979 -> '19.96M')
 */
export function formatTokensK(tokens: number | null | undefined, locale?: string): string {
  if (tokens === null || tokens === undefined || Number.isNaN(tokens)) return "?";
  if (tokens <= 0) return "0";
  if (tokens < 1000) return String(tokens);

  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    const rounded = Math.round(m * 100) / 100;
    return `${rounded}M`;
  }

  const k = tokens / 1000;
  if (k < 10) {
    const rounded = Math.round(k * 10) / 10;
    return `${rounded}k`;
  }
  return `${Math.round(k).toLocaleString(locale)}k`;
}
