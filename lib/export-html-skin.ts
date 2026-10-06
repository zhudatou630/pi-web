// Keep this list in sync with handleViewFullHistory (covered by the skin test).
export const EXPORT_SKIN_VARS = [
  "bg", "bg-panel", "bg-hover", "bg-selected", "border", "text", "text-muted",
  "text-dim", "accent", "danger", "warning", "success", "user-bg", "tool-bg",
  "bg-subtle", "font-ui", "font-chat", "font-mono", "chat-content-font-size",
  "ui-radius-sm", "ui-radius-md", "ui-radius-lg",
];

// Bundled faces are deliberately copied: exports must also work in production,
// where the source globals.css is absent. The test prevents font rule drift.
export const EXPORT_SKIN_CSS = `
@font-face {
  font-family: "Sarasa Term SC Web";
  src: url("/fonts/SarasaTermSC-Regular.woff2?v=1") format("woff2");
  font-style: normal;
  font-weight: 400;
  font-display: swap;
}

@font-face {
  font-family: "Sarasa Term SC Web";
  src: url("/fonts/SarasaTermSC-SemiBold.woff2?v=1") format("woff2");
  font-style: normal;
  font-weight: 600;
  font-display: swap;
}

@font-face {
  font-family: "Source Serif 4 Web";
  src: url("/fonts/SourceSerif4-Latin.woff2?v=2") format("woff2");
  font-style: normal;
  font-weight: 400 600;
  font-display: swap;
  size-adjust: 108%;
  unicode-range: U+0000-00B6, U+00B8-00FF, U+0100-017F, U+0192, U+02C6, U+02DC, U+2013, U+2018-2019, U+201A, U+201E, U+2020-2022, U+2030, U+2039-203A, U+20AC, U+2122, U+2212;
}

@font-face {
  font-family: "Noto Serif SC Web";
  src: url("/fonts/NotoSerifSC.woff2?v=2") format("woff2");
  font-style: normal;
  font-weight: 500;
  font-display: swap;
}

@font-face {
  font-family: "Noto Serif SC Web";
  src: url("/fonts/NotoSerifSC.woff2?v=2") format("woff2");
  font-style: normal;
  font-weight: 700;
  font-display: swap;
}

@font-face {
  font-family: "LXGW WenKai Web";
  src: url("/fonts/LXGWWenKaiScreen.woff2?v=1") format("woff2");
  font-style: normal;
  font-weight: 400;
  font-display: swap;
}

@font-face {
  font-family: "LXGW WenKai Web";
  src: url("/fonts/LXGWWenKai-Regular.woff2?v=1") format("woff2");
  font-style: normal;
  font-weight: 500;
  font-display: swap;
}

@font-face {
  font-family: "Sarasa UI SC Web";
  src: url("/fonts/SarasaUiSC-Regular.woff2?v=1") format("woff2");
  font-style: normal;
  font-weight: 400;
  font-display: swap;
}

@font-face {
  font-family: "Sarasa UI SC Web";
  src: url("/fonts/SarasaUiSC-SemiBold.woff2?v=1") format("woff2");
  font-style: normal;
  font-weight: 600;
  font-display: swap;
}

:root {
  color-scheme: light dark;
  font-synthesis: none;
  --bg: light-dark(#ffffff, #1a1a1a);
  --bg-panel: light-dark(#f5f5f5, #242424);
  --bg-hover: light-dark(#eeeeee, #2e2e2e);
  --bg-selected: light-dark(#e8e8e8, #383838);
  --border: light-dark(#e0e0e0, #3a3a3a);
  --text: light-dark(#1a1a1a, #e8e8e8);
  --text-muted: light-dark(#3b4452, #c2c5cc);
  --text-dim: light-dark(#565e6b, #9da1ab);
  --accent: light-dark(#2563eb, #60a5fa);
  --danger: light-dark(#dc2626, #f87171);
  --warning: light-dark(#b45309, #facc15);
  --success: light-dark(#059669, #34d399);
  --user-bg: light-dark(#f3f4f6, #22252b);
  --tool-bg: light-dark(#f9fafb, #1f2937);
  --bg-subtle: light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.04));
  --font-ui: "Sarasa UI SC Web", ui-sans-serif, sans-serif;
  --font-chat: var(--font-ui);
  --font-mono: "Sarasa Term SC Web", ui-monospace, monospace;
  --chat-content-font-size: 14px;
  --chat-font-size-offset: calc(var(--chat-content-font-size) - 14px);
  --ui-radius-sm: 4px;
  --ui-radius-md: 6px;
  --ui-radius-lg: 10px;
  --line-height: 20px;
  --sidebar-width: 320px;
  --body-bg: var(--bg);
  --container-bg: var(--bg-panel);
  --info-bg: var(--bg-subtle);
  --exportPageBg: var(--bg);
  --exportCardBg: var(--bg-panel);
  --exportInfoBg: var(--bg-subtle);
  --muted: var(--text-muted);
  --dim: var(--text-dim);
  --hover: var(--bg-hover);
  --selectedBg: var(--bg-selected);
  --borderAccent: var(--text-muted);
  --error: var(--danger);
  --userMessageBg: var(--user-bg);
  --userMessageText: var(--text);
  --thinkingText: var(--text-dim);
  --toolPendingBg: var(--tool-bg);
  --toolSuccessBg: var(--tool-bg);
  --toolErrorBg: color-mix(in srgb, var(--danger) 7%, var(--tool-bg));
  --toolOutput: var(--text);
  --toolDiffAdded: var(--success);
  --toolDiffRemoved: var(--danger);
  --toolDiffContext: var(--text-muted);
  --customMessageBg: var(--bg-panel);
  --customMessageLabel: var(--text-muted);
  --customMessageText: var(--text);
  --mdHeading: var(--text);
  --mdLink: var(--accent);
  --mdCode: var(--text);
  --mdQuoteBorder: var(--border);
  --mdQuote: var(--text-muted);
  --mdListBullet: var(--text-muted);
  --mdHr: var(--border);
  --mdCodeBlockBorder: var(--border);
  --syntaxComment: var(--text-dim);
  --syntaxKeyword: var(--accent);
  --syntaxNumber: var(--warning);
  --syntaxString: var(--success);
  --syntaxFunction: var(--accent);
  --syntaxType: var(--warning);
  --syntaxVariable: var(--text);
  --syntaxOperator: var(--text-muted);
  --syntaxPunctuation: var(--text-muted);
}
html[data-font="wenkai"] { font-synthesis: weight; }
body { font-family: var(--font-ui); font-weight: 400; line-height: 1.5; }
button, input { font-family: var(--font-ui); font-weight: 400; line-height: 1.5; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
#sidebar { border-color: var(--border); height: 100dvh; }
.sidebar-header { border-bottom: 1px solid var(--border); padding: 8px; }
.sidebar-controls { padding: 0 0 8px; }
.sidebar-search { font-size: 12px; min-height: 28px; border-color: transparent; border-radius: var(--ui-radius-md); background: var(--bg-subtle); }
.sidebar-search::placeholder { color: var(--text-dim); }
.sidebar-filters { padding: 0; }
.filter-btn, .sidebar-close, .header-toggle-btn, .download-json-btn { border-color: var(--border); border-radius: var(--ui-radius-sm); min-height: 28px; color: var(--text-muted); }
.filter-btn:hover, .sidebar-close:hover, .header-toggle-btn:hover, .download-json-btn:hover { background: var(--bg-hover); border-color: var(--border); color: var(--text); }
.filter-btn.active, .header-toggle-btn[aria-pressed="true"] { background: var(--bg-selected); border-color: var(--border); color: var(--text); font-weight: 400; }
.tree-container { padding: 6px; }
.tree-node { min-height: 22px; line-height: 1.5; border-radius: var(--ui-radius-sm); padding: 2px 6px; }
.tree-node:not(.in-path) { opacity: 1; }
.tree-node.in-path { background: transparent; }
.tree-node:hover { background: var(--bg-hover); }
.tree-node.active { background: var(--bg-selected); box-shadow: none; }
.tree-node.active .tree-content { color: var(--text); font-weight: 400; }
.tree-content { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted); }
.tree-node:not(.in-path) .tree-content { color: var(--text-dim); }
/* ASCII connectors need fixed columns; the labels themselves use the UI face. */
.tree-prefix { font-family: var(--font-mono); color: var(--text-dim); }
.tree-marker { width: 10px; color: var(--text-dim); }
.tree-node.in-path .tree-marker { color: var(--text-muted); }
.tree-node.active .tree-marker { color: var(--accent); }
.tree-role-assistant, .tree-compaction, .tree-custom, .tree-role-skill { color: var(--text-muted); }
.tree-status { border-top: 1px solid var(--border); padding: 8px 12px; color: var(--text-dim); }
#content { padding: 24px 32px; }
#content > * { max-width: 820px; }
.header, .user-message, .tool-execution, .compaction, .system-prompt, .tools-list, .hook-message, .skill-invocation, .branch-summary { border-radius: var(--ui-radius-md); padding: 16px; }
.header { border: 1px solid var(--border); }
.header h1 { font-size: 14px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; margin-bottom: 12px; }
.help-bar { color: var(--text-dim); gap: 8px; margin-bottom: 12px; }
.help-actions { gap: 6px; }
.info-item { line-height: 1.6; }
.info-label { font-weight: 400; min-width: 80px; }
.info-value { color: var(--text-muted); min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.message-timestamp { font-family: var(--font-ui); font-size: 11px; color: var(--text-dim); opacity: 1; margin-bottom: 6px; font-variant-numeric: tabular-nums; }
.user-message, .markdown-content, .compaction-content { font-family: var(--font-chat); font-size: var(--chat-content-font-size); line-height: 1.58; overflow-wrap: anywhere; }
.assistant-text { padding: 12px 16px 0; }
.thinking-text, .thinking-collapsed { font-family: var(--font-ui); font-size: 11px; font-style: normal; line-height: 1.6; padding: 12px 16px; }
.tool-header, .tool-name, .tool-item-name, .tool-param-name, .model-name { font-weight: 400; }
.tool-header { font-size: 11px; color: var(--text-muted); }
.tool-path, .line-numbers { color: var(--text-muted); }
.tool-command, .tool-output, .tool-diff, .system-prompt-preview, .system-prompt-full { font-family: var(--font-mono); font-size: calc(13px + var(--chat-font-size-offset)); line-height: 1.5; font-weight: 400; }
.tool-output code { font-family: inherit; }
.tool-output > div, .output-preview > div, .output-full > div { line-height: 1.5; }
.tool-output.expandable:hover { opacity: 1; }
.tool-execution { border: 1px solid var(--border); }
.tool-execution.error { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.expand-hint, .system-prompt-expand-hint, .system-prompt-note, .tool-params-hint, .tool-param-type, .error-text, .tool-error { font-family: var(--font-ui); font-size: 11px; font-style: normal; }
.expand-hint { color: var(--text-dim); margin-top: 6px; }
.compaction-label, .system-prompt-header, .tools-header, .hook-type, .skill-invocation-label, .branch-summary-header { font-family: var(--font-ui); font-size: 12px; font-weight: 600; }
.compaction-collapsed, .skill-invocation-collapsed { font-family: var(--font-ui); font-size: 11px; }
.model-name { color: var(--text-muted); }
.markdown-content :is(h1,h2,h3,h4,h5,h6) { font-weight: 600; line-height: 1.3; color: var(--text); }
.markdown-content h1 { font-size: 1.25em; margin: 1.4em 0 0.45em; }
.markdown-content h2 { font-size: 1.14em; margin: 1.3em 0 0.4em; }
.markdown-content :is(h3,h4,h5,h6) { margin: 1em 0 0.3em; }
.markdown-content > :is(h1,h2,h3,h4,h5,h6):first-child { margin-top: 0; }
.markdown-content strong, .compaction-content strong { font-weight: 600; }
.markdown-content p + p { margin-top: 6px; }
.markdown-content :is(ul,ol) { margin: 6px 0; padding-left: 24px; }
.markdown-content li { margin: 2px 0; }
.markdown-content a { text-underline-offset: 2.5px; }
.markdown-content code { font-family: var(--font-mono); font-size: calc(13px + var(--chat-font-size-offset)); background: var(--bg-subtle); border-radius: var(--ui-radius-sm); }
.markdown-content pre { background: var(--tool-bg); border: 1px solid var(--border); border-radius: var(--ui-radius-md); padding: 12px; line-height: 1.5; }
.markdown-content pre code { padding: 0; font-size: calc(13px + var(--chat-font-size-offset)); }
.markdown-content blockquote { font-style: normal; }
.markdown-content table { display: block; max-width: 100%; overflow-x: auto; font-size: calc(13px + var(--chat-font-size-offset)); }
.markdown-content th { font-weight: 600; background: var(--bg-subtle); }
.diff-added { background: color-mix(in srgb, var(--success) 7%, transparent); }
.diff-removed { background: color-mix(in srgb, var(--danger) 7%, transparent); }
.hljs-addition { color: var(--success); }
.hljs-deletion { color: var(--danger); }
.hljs-emphasis, .hljs-strong { font-style: normal; font-weight: 400; }
/* ponytail: ANSI colors are baked for a terminal palette; remap individual
   spans if custom tools need semantic colors beyond the card's error state. */
.ansi-rendered [style] { color: inherit !important; background: transparent !important; font-weight: 400 !important; font-style: normal !important; }
.tool-image, .message-image, .markdown-content img { max-height: min(60vh, 420px); border-radius: var(--ui-radius-md); }
.copy-link-btn { border-color: var(--border); border-radius: var(--ui-radius-sm); }
.copy-link-btn:hover, .copy-link-btn.copied { background: var(--bg-selected); color: var(--text); border-color: var(--border); }
.image-modal { display: none; position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,0.7); align-items: center; justify-content: center; }
.image-modal.open { display: flex; }
#modal-image { max-width: 95vw; max-height: 95dvh; border-radius: var(--ui-radius-md); }
* { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--text-dim) 35%, transparent) transparent; }
#hamburger { background: var(--bg-panel); color: var(--text-muted); border-color: var(--border); border-radius: var(--ui-radius-md); width: 32px; height: 32px; padding: 8px; }
#sidebar-overlay { background: rgba(0,0,0,0.4); }
@media (max-width: 900px) {
  #content { padding: 54px 12px 24px; }
  #sidebar { width: min(var(--sidebar-width), 100vw - 24px); min-width: min(var(--sidebar-width), 100vw - 24px); max-width: min(var(--sidebar-width), 100vw - 24px); }
  .sidebar-search { font-size: 16px; min-height: 32px; }
  .header, .user-message, .tool-execution, .compaction, .system-prompt, .tools-list, .hook-message, .skill-invocation, .branch-summary { padding: 12px; }
  .assistant-text, .thinking-text, .thinking-collapsed { padding-left: 12px; padding-right: 12px; }
}
`;

export const EXPORT_SKIN_SCRIPT = `(function(){
  try {
    var skin = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    if (!skin || typeof skin !== 'object' || !skin.vars || typeof skin.vars !== 'object') return;
    var root = document.documentElement;
    var allowed = ${JSON.stringify(EXPORT_SKIN_VARS)};
    allowed.forEach(function(key) {
      var value = skin.vars[key];
      if (typeof value === 'string' && value.trim()) root.style.setProperty('--' + key, value);
    });
    if (typeof skin.dark === 'boolean') root.style.colorScheme = skin.dark ? 'dark' : 'light';
    if (skin.font === 'claude' || skin.font === 'wenkai') root.dataset.font = skin.font;
  } catch (_) { /* Missing or malformed hashes use the system color scheme. */ }
})();`;

export function skinExportHtml(html: string): string {
  return html
    .replace(/<title>[^<]*<\/title>/i, '<title>Pi Web · Full history</title>')
    .replace(/<\/head>/i, `<style id="pi-web-export-skin">${EXPORT_SKIN_CSS}</style><script>${EXPORT_SKIN_SCRIPT}</script></head>`);
}
