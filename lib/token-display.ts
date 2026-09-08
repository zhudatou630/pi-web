/**
 * Formats token counts consistently with 'k' as the standard unit.
 *
 * Rules:
 * - 0 or negative: '0k'
 * - < 1000: '0.Xk' (e.g. 500 -> '0.5k'), or '<0.1k' for tiny positive values
 * - 1k .. <10k: 1 decimal place (e.g. 1450 -> '1.5k', 3000 -> '3k')
 * - >= 10k: rounded integer in k with locale thousands separator (e.g. 61281 -> '61k', 206841 -> '207k', 1048576 -> '1,049k', 19964979 -> '19,965k')
 */
export function formatTokensK(tokens: number | null | undefined, locale?: string): string {
  if (tokens === null || tokens === undefined || Number.isNaN(tokens)) return "?";
  if (tokens <= 0) return "0k";
  if (tokens < 1000) {
    const dec = (tokens / 1000).toFixed(1);
    return dec === "0.0" ? "<0.1k" : `${dec}k`;
  }
  const k = tokens / 1000;
  if (k < 10) {
    const rounded = Math.round(k * 10) / 10;
    const formatted = rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1);
    return `${formatted}k`;
  }
  return `${Math.round(k).toLocaleString(locale)}k`;
}
