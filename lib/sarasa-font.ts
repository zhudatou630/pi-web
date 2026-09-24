const SARASA_FONT_URLS = [
  "/fonts/SarasaTermSC-Regular.woff2?v=1",
  "/fonts/SarasaTermSC-SemiBold.woff2?v=1",
];
const SARASA_ENABLED = "pi-web-sarasa-enabled";

export function enableSarasaWebFont(): void {
  document.documentElement.classList.add("sarasa-term-webfont");
  localStorage.setItem(SARASA_ENABLED, "1");
}

export function hasDownloadedSarasa(): boolean {
  return localStorage.getItem(SARASA_ENABLED) === "1";
}

export async function downloadSarasa(): Promise<void> {
  await Promise.all(SARASA_FONT_URLS.map(async (url) => {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  }));
  enableSarasaWebFont();
  await Promise.all([
    document.fonts.load('400 14px "Sarasa Term SC Web"'),
    document.fonts.load('600 14px "Sarasa Term SC Web"'),
  ]);
}
