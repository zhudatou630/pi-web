export const SARASA_FONT_URL = "/fonts/SarasaTermSC-Regular.woff2?v=1";
const SARASA_ENABLED = "pi-web-sarasa-enabled";

export function enableSarasaWebFont(): void {
  document.documentElement.classList.add("sarasa-term-webfont");
  localStorage.setItem(SARASA_ENABLED, "1");
}

export function hasDownloadedSarasa(): boolean {
  return localStorage.getItem(SARASA_ENABLED) === "1";
}

export async function downloadSarasa(): Promise<void> {
  const response = await fetch(SARASA_FONT_URL, { cache: "force-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  enableSarasaWebFont();
  await document.fonts.load('14px "Sarasa Term SC Web"');
}
