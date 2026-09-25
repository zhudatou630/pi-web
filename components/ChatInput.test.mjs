import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput, ModelErrorBanner, ModelScopeWarningBanner, canClearBuiltinCommandInput, canRestoreUserMessage, canRunBuiltinSlashCommandWhileStreaming, compressImageFile, getUpwardMenuMaxHeight, getUserMessageText, getUserMessageDraftImages, isExactSlashCommand, modelSupportsImageInput, prependImageMentions, replaceLinksWithMarkdown, shouldCompressImageFile } = await jiti.import("./ChatInput.tsx");
const { ModelSelector } = await jiti.import("./ModelSelector.tsx");
const { clearDraft, getDraft, mergeRestoredSubmissionDraft, mergeRestoredSubmissionText, rekeyDraft, setDraft } = await jiti.import("@/lib/draft-store.ts");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

test("preserves pasted HTML links as Markdown without changing plain text layout", () => {
  const link = (label, href, occurrence = 0) => ({ label, href, occurrence });

  assert.equal(
    replaceLinksWithMarkdown(
      "Jobs:\nEngineer\nEngineer\nDone",
      [link("Engineer", "https://example.com/1"), link("Engineer", "https://example.com/2", 1)],
    ),
    "Jobs:\n[Engineer](https://example.com/1)\n[Engineer](https://example.com/2)\nDone",
  );
  assert.equal(
    replaceLinksWithMarkdown("Read [this]", [link("[this]", "https://example.com/a_(b)")]),
    "Read [\\[this\\]](https://example.com/a_\\(b\\))",
  );
  assert.equal(
    replaceLinksWithMarkdown("Engineer and Engineer", [link("Engineer", "https://example.com/job", 1)]),
    "Engineer and [Engineer](https://example.com/job)",
  );
  assert.equal(replaceLinksWithMarkdown("plain text", [link("missing", "https://example.com")]), null);
});

test("prepends quoted image paths to outgoing messages", () => {
  assert.equal(
    prependImageMentions("make the light warmer", [".pi/generated-images/old image.jpg"]),
    '@".pi/generated-images/old image.jpg" make the light warmer',
  );
  assert.equal(prependImageMentions("", [".pi/generated-images/old.jpg"]), "@.pi/generated-images/old.jpg");
});

test("connects the composer to its active suggestion list", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(source, /const menuId = useId\(\)/);
  assert.match(source, /role="combobox"/);
  assert.match(source, /aria-controls=\{activeListboxId\}/);
  assert.match(source, /aria-activedescendant=\{activeOptionId\}/);
  assert.equal((source.match(/role="listbox"/g) ?? []).length, 3);
  assert.equal((source.match(/role="option"/g) ?? []).length, 3);
  assert.equal((source.match(/aria-selected=\{active\}/g) ?? []).length, 3);
});

test("warns when the current draft cannot be persisted", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(source, /const persisted = setDraft\(draftKey/);
  assert.match(source, /setDraftPersistenceFailed\(!persisted\)/);
  assert.match(source, /draftPersistenceFailed \|\| draftPersistenceWarning/);
  assert.match(source, /t\("chat\.draftPageOnly"\)/);
});

test("follow-up shortcuts preserve newline, IME, mobile and completion behavior", () => {
  const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findHandler(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleKeyDown") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findHandler);
  }
  // Execute the component's actual callback without mounting the rest of the UI.
  const script = new Script(ts.transpileModule(findHandler(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  const cases = [
    ["Enter steers", {}, {}, "steer"],
    ["Alt+Enter follows up", { altKey: true }, {}, "followup"],
    ["idle Alt+Enter sends", { altKey: true }, { isStreaming: false }, "send"],
    ["Shift+Enter inserts a newline", { shiftKey: true }, {}, "native"],
    ["Shift+Enter sends when swapped", { shiftKey: true }, { isShiftEnterToSend: () => true }, "steer"],
    ["Enter inserts a newline when swapped", {}, { isShiftEnterToSend: () => true }, "native"],
    ["mobile Ctrl+Enter still sends when swapped", { ctrlKey: true }, { isMobile: true, isShiftEnterToSend: () => true }, "steer"],
    ["mobile Shift+Enter stays native when swapped", { shiftKey: true }, { isMobile: true, isShiftEnterToSend: () => true }, "native"],
    ["Alt+Shift+Enter keeps native behavior", { altKey: true, shiftKey: true }, {}, "native"],
    ["composition ref blocks sending", { altKey: true }, { isComposingRef: { current: true } }, "native"],
    ["native composition blocks sending", { altKey: true, nativeEvent: { isComposing: true } }, {}, "native"],
    ["IME keyCode blocks sending", { altKey: true, nativeEvent: { keyCode: 229 } }, {}, "native"],
    ["composition grace blocks sending", { altKey: true }, { lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["mobile Alt+Enter keeps native behavior", { altKey: true }, { isMobile: true }, "native"],
    ["mobile composition grace cannot send", { altKey: true }, { isMobile: true, lastCompositionEndAtRef: { current: 950 } }, "native"],
    ["mobile Ctrl+Alt+Enter follows up", { altKey: true, ctrlKey: true }, { isMobile: true }, "followup"],
    ["mobile Cmd+Alt+Enter follows up", { altKey: true, metaKey: true }, { isMobile: true }, "followup"],
    ["mobile modified Enter respects composition grace", { altKey: true, ctrlKey: true }, { isMobile: true, lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["Enter falls back to follow-up", {}, { onSteer: undefined }, "followup"],
    ["Alt+Enter falls back to steer", { altKey: true }, { onFollowUp: undefined }, "steer"],
    ["slash completion takes priority", { altKey: true }, { slashMenuOpen: true, slashQuery: "help" }, "slash"],
    ["available built-in commands take priority", { altKey: true }, { slashMenuOpen: true, slashQuery: "copy", value: "/copy", displayedSlashCommands: [{ name: "copy", source: "builtin", availableWhileStreaming: true }] }, "send"],
    ["file completion takes priority", { altKey: true }, { atMenuOpen: true, atQuery: {} }, "file"],
    ["history selection takes priority", { altKey: true }, { historyMenuOpen: true }, "history"],
    ["empty input opens history", { key: "ArrowUp" }, { isStreaming: false }, "history menu"],
    ["typed input keeps native cursor movement", { key: "ArrowUp" }, { isStreaming: false, value: "draft" }, "native"],
    ["multiline input keeps native cursor movement", { key: "ArrowUp" }, { isStreaming: false, value: "first\nsecond" }, "native"],
  ];
  for (const [name, keys, state, expected] of cases) {
    let action = "native";
    const handler = script.runInNewContext({
      Date: { now: () => 1000 },
      COMPOSITION_END_ENTER_GRACE_MS: 100,
      isMobile: false, isStreaming: true,
      isShiftEnterToSend() { return false; },
      isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 },
      historyMenuOpen: false, inputHistory: ["previous"], historyActiveIndex: 0,
      historyStashRef: { current: null }, setHistoryActiveIndex() {}, setHistoryMenuOpen() { action = "history menu"; },
      slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [{}], slashActiveIndex: 0,
      atMenuOpen: false, atQuery: null, atMatches: [{}], atActiveIndex: 0, setAtMenuOpen() {},
      onSteer() {}, onFollowUp() {},
      sendQueued(mode) { action = mode; }, handleSend() { action = "send"; },
      applySlashCommand() { action = "slash"; },
      isExactSlashCommand, value: "", setSlashMenuOpen() {},
      applyAtCompletion() { action = "file"; },
      applyHistoryInput() { action = "history"; },
      ...state,
    });
    handler({
      key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault() { action = "prevented"; },
      ...keys,
    });
    assert.equal(action, expected, name);
  }
});

test("keeps the main composer compact in idle and streaming states", () => {
  for (const isStreaming of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {}, onAbort() {}, onSteer() {}, onFollowUp() {}, isStreaming,
      }),
    ));
    assert.match(html, /<textarea[^>]*rows="1"[^>]*min-height:24px;max-height:200px/);
    assert.match(html, /class="chat-input-composer"[\s\S]*class="chat-input-dock"/);
    assert.equal((html.match(/class="composer-send"/g) ?? []).length, 1);
    assert.match(html, new RegExp(`class="composer-send" aria-label="${isStreaming ? "Stop" : "Send"}"`));
  }

  const draftKey = "test:composer-streaming-intervene";
  try {
    setDraft(draftKey, { value: "wait", images: [] });
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {}, onAbort() {}, onSteer() {}, onFollowUp() {}, isStreaming: true, draftKey,
      }),
    ));
    // A live run with a draft: quiet Stop and Follow-up, and the filled slot steers like Enter.
    assert.match(html, /class="chat-input-field-row"><textarea[\s\S]*?<\/textarea><div class="chat-input-actions">/);
    assert.match(html, /class="composer-btn is-icon" aria-label="Stop"/);
    assert.match(html, /class="composer-btn is-icon" aria-label="Follow-up"/);
    assert.match(html, /class="composer-send" aria-label="Steer"/);
    assert.doesNotMatch(html, /composer-btn-label/);
    assert.doesNotMatch(html, /#ef4444/);
  } finally {
    clearDraft(draftKey);
  }
});

test("shows context as an always-visible ring readout that only colors past 70%", () => {
  const render = (percent, tokens) => renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      contextUsage: { percent, contextWindow: 872000, tokens },
      cacheHitRate: 98,
      onOpenSessionStats() {},
    }),
  ));
  const low = render(17, 150000).match(/<button[^>]*data-top-panel-trigger="session"[\s\S]*?<\/button>/)?.[0];
  assert.ok(low);
  assert.match(low, /class="composer-btn chat-input-context"/);
  assert.match(low, /viewBox="0 0 16 16"/);
  assert.match(low, /stroke-dasharray="17 100"/);
  assert.match(low, /<\/svg><span>150k\/872k<\/span><span class="chat-input-context-cache">cache 98%<\/span><\/button>/);
  assert.match(low, /title="Context usage: 150k \/ 872k \(17\.0%\)[^"]*Avg cache hit rate: 98\.0%"/);
  assert.match(low, /aria-controls="workspace-top-panel"/);
  assert.doesNotMatch(low, /Compact context/);

  assert.match(render(72, 628000), /class="composer-btn chat-input-context is-warning"/);
  assert.match(render(90, 785000), /class="composer-btn chat-input-context is-high"/);
});

test("groups model and effort on the dock and folds rare controls", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      onThinkingLevelChange() {},
      thinkingLevel: "high",
      onToolPresetChange() {},
      onModelChange() {},
      model: { provider: "openai", modelId: "gpt-test" },
      modelList: [{ provider: "openai", id: "gpt-test", name: "GPT Test" }],
      contextUsage: { percent: 72, contextWindow: 500000, tokens: 360000 },
      onCompact() {},
    }),
  ));
  const attach = html.indexOf('aria-label="Attach image"');
  const model = html.indexOf(">GPT Test<");
  const effort = html.indexOf("Change reasoning level");
  const context = html.indexOf("360k / 500k");
  const more = html.indexOf("More controls");
  const send = html.indexOf('aria-label="Send"');
  assert.ok(send >= 0 && attach > send && model > attach && effort > model && context > effort && more > context);
  assert.doesNotMatch(html, />default<|>chat-only<|>Compact context/);
  assert.match(html, /class="chat-input-composer"[\s\S]*class="chat-input-dock"/);
});

test("keeps effort visible but locked while streaming", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(source, /\{onThinkingLevelChange && \(/);
  assert.doesNotMatch(source, /THINKING_LEVEL_DESC_KEYS/);
  assert.doesNotMatch(source, /ThinkingIcon active=\{thinkingLevel/);
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      onThinkingLevelChange() {},
      thinkingLevel: "high",
      onToolPresetChange() {},
      onCompact() {},
    }),
  ));
  assert.match(html, /aria-label="Change reasoning level"/);
  assert.match(html, />high<\/span>/);
  assert.doesNotMatch(html, /Change tool preset/);
  assert.doesNotMatch(html, /Compact context/);
});

test("keeps empty Send quiet and highlights text or image submissions", () => {
  const draftKey = "test:composer-send-appearance";
  try {
    for (const draft of [
      { value: "", images: [] },
      { value: "Hello", images: [] },
      { value: "", images: [{ data: "aW1hZ2U=", mimeType: "image/png" }] },
    ]) {
      clearDraft(draftKey);
      setDraft(draftKey, draft);
      const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
        React.createElement(ChatInput, { onSend() {}, onAbort() {}, isStreaming: false, draftKey }),
      ));
      const send = html.match(/<button[^>]*aria-label="Send"[\s\S]*?<\/button>/)?.[0];
      assert.ok(send);
      const empty = !draft.value && draft.images.length === 0;
      assert.equal(send.includes('disabled=""'), empty);
      assert.match(send, /class="composer-send"/);
      assert.match(send, /<svg width="14" height="14" viewBox="0 0 24 24"[^>]*stroke-width="1.9"/);
      assert.doesNotMatch(send, /composer-btn-label/);
      assert.match(html, /class="chat-input-composer"[\s\S]*class="chat-input-dock"/);
      const attach = html.match(/<button[^>]*aria-label="Attach image"[\s\S]*?<\/button>/)?.[0];
      assert.match(attach ?? "", /<svg width="13" height="13"[^>]*stroke-width="2"/);
    }
  } finally {
    clearDraft(draftKey);
  }
});

test("integrates image generation into the image button menu instead of a standalone toolbar button", () => {
  const withoutGen = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ChatInput, { onSend() {}, onAbort() {}, isStreaming: false }),
  ));
  assert.match(withoutGen, /aria-label="Attach image"/);
  assert.doesNotMatch(withoutGen, /aria-label="Attach image \/ Generate image"/);
  assert.doesNotMatch(withoutGen, /aria-haspopup="menu"/);

  const withGen = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ChatInput, { onSend() {}, onAbort() {}, onOpenImageGeneration() {}, isStreaming: false }),
  ));
  assert.match(withGen, /aria-label="Attach image \/ Generate image"/);
  assert.match(withGen, /aria-haspopup="menu"/);
  assert.doesNotMatch(withGen, /<button[^>]*aria-label="Generate image"[^>]*class="inline-flex h-7 w-7/);
});

test("keeps queued subagent sessions inspectable without accepting input", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ChatInput, { onSend() {}, onAbort() {}, isStreaming: false, disabled: true }),
  ));

  assert.match(html, /<textarea[^>]*disabled=""[^>]*placeholder="Queued"/);
  assert.match(html, /<button[^>]*aria-label="Send"[^>]*disabled=""/);
});

test("keeps rare session controls in one always-available menu", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-label=\{t\("chat.moreControls"\)\}/);
  // tools and compact drill down in place; compact needs a confirming second click.
  assert.match(source, /setControlsView\("tools"\)/);
  assert.match(source, /setControlsView\("compact"\)/);
  assert.match(source, /t\("chat.compactConfirm"\)/);
  assert.doesNotMatch(source, /onSoundToggle/);
  assert.doesNotMatch(source, /className="chat-input-toolbar-controls"/);
  assert.doesNotMatch(source, /mobileContractLabel/);
  assert.doesNotMatch(source, /title=\{t\("chat.collapseControls"\)\}/);
});

test("keeps the message input free of hints but accessible", () => {
  for (const compact of [false, true]) {
    for (const isStreaming of [false, true]) {
      const html = renderToStaticMarkup(React.createElement(
        I18nProvider,
        null,
        React.createElement(ChatInput, {
          onSend() {}, onAbort() {}, onSteer() {}, onFollowUp() {}, compact, isStreaming,
        }),
      ));
      const textarea = html.match(/<textarea\b[^>]*>/)?.[0];
      assert.ok(textarea);
      assert.doesNotMatch(textarea, /placeholder=/);
      assert.match(textarea, /aria-label="[^"]+"/);
    }
  }
});

test("shows the follow-up shortcut in the button tooltip", () => {
  const draftKey = "test:follow-up-tooltip";
  try {
    setDraft(draftKey, { value: "queue next", images: [] });
    const html = renderToStaticMarkup(
      React.createElement(I18nProvider, null, React.createElement(ChatInput, {
        onSend() {}, onAbort() {}, onSteer() {}, onFollowUp() {}, isStreaming: true, draftKey,
      })),
    );

    assert.match(html, /title="Queue this message after the agent finishes \(Alt\/Option\+Enter\)"/);
    assert.match(html, /aria-keyshortcuts="Alt\+Enter"/);
  } finally {
    clearDraft(draftKey);
  }
});

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelErrorBanner, {
        error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Model error/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(
    renderToStaticMarkup(
      React.createElement(I18nProvider, null, React.createElement(ModelErrorBanner, { error: null })),
    ),
    "",
  );
});

test("renders enabledModels scope warnings", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelScopeWarningBanner, {
        warnings: ['No models match pattern "ghost-gateway/*"'],
      }),
    ),
  );

  assert.match(html, /Model scope warning/);
  assert.match(html, /ghost-gateway/);
  assert.equal(
    renderToStaticMarkup(
      React.createElement(I18nProvider, null, React.createElement(ModelScopeWarningBanner, { warnings: [] })),
    ),
    "",
  );
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        modelError: "Invalid models.json schema",
        modelList: [],
        modelNames: {},
      }),
    ),
  );

  assert.match(html, />No models</);
  assert.match(html, /title="No available models"/);
});

test("renders the read-only tool preset as the active selection", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onToolPresetChange() {},
        isStreaming: false,
        toolPreset: "read-only",
      }),
    ),
  );

  assert.match(html, /title="Change tool preset: read-only"/);
  assert.match(html, />read-only<\/span>/);
});

test("renders the empty tool preset as chat-only in the toolbar", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onToolPresetChange() {},
        isStreaming: false,
        toolPreset: "none",
      }),
    ),
  );

  assert.match(html, /title="Change tool preset: Chat only"/);
  assert.match(html, />chat-only<\/span>/);
});

test("renders the compact composer with the standard Send button and no session controls", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        compact: true,
      }),
    ),
  );

  assert.match(html, /<textarea/);
  assert.match(html, /aria-label="Send"/);
  assert.match(html, /class="composer-send" aria-label="Send"/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.doesNotMatch(html, /type="file"|Attach image|Change tool preset/);
});

test("shows and locks the optimistic model while a switch is pending", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
        modelList: [{ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
        modelSwitching: true,
      }),
    ),
  );

  assert.match(html, /title="Switching model"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, />DeepSeek V4 Flash</);
  assert.match(html, /animation:spin 0\.8s linear infinite/);
});

test("renders the toolbar model as a plain dock button without a chip icon", () => {
  const html = renderToStaticMarkup(React.createElement(ModelSelector, {
    options: [{ provider: "openai", modelId: "gpt-test", name: "GPT Test" }],
    value: { provider: "openai", modelId: "gpt-test" }, onChange() {},
  }));
  assert.match(html, /class="composer-btn model-selector-trigger"/);
  assert.match(html, />GPT Test<\/span><\/button>/);
  assert.doesNotMatch(html, /<rect x="4" y="4" width="16" height="16"/);
});

test("keeps the model listbox keyboard and ARIA contract explicit", () => {
  const source = readFileSync(new URL("./ModelSelector.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-controls=\{listboxId\}/);
  assert.match(source, /aria-activedescendant=\{open \? activeOptionId : undefined\}/);
  assert.match(source, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(source, /event\.key === "Home" \|\| event\.key === "End"/);
  assert.match(source, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(source, /event\.key === "Escape" && open/);
  assert.match(source, /window\.addEventListener\("scroll", updateAnchor, true\)/);
  assert.match(source, /window\.addEventListener\("resize", updateAnchor\)/);
  assert.match(source, /id=\{listboxId\}/);
  assert.match(source, /id=\{`\$\{listboxId\}-option-/);
  assert.match(source, /activeOptionId/);
});

test("renders the shared field model selector as a disabled gray control", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelSelector, {
        options: [{ provider: "openai", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
        value: null,
        onChange() {},
        onClear() {},
        emptyLabel: "Parent default",
        ariaLabel: "Model override",
        disabled: true,
        variant: "field",
      }),
    ),
  );

  assert.match(html, /aria-label="Model override"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /background:var\(--bg-panel\)/);
  assert.match(html, />Parent default</);
  assert.match(html, /<rect x="4" y="4" width="16" height="16"/);
});

test("caps an upward menu to the visible space above its anchor", () => {
  assert.equal(getUpwardMenuMaxHeight(343, 36), 299);
  assert.equal(getUpwardMenuMaxHeight(40, 36), 0);
});

test("compresses large images while preserving small images and GIFs", async () => {
  assert.equal(shouldCompressImageFile({ size: 1024 * 1024, type: "image/png" }), false);
  assert.equal(shouldCompressImageFile({ size: 1024 * 1024 + 1, type: "image/png" }), true);
  assert.equal(shouldCompressImageFile({ size: 2 * 1024 * 1024, type: "image/gif" }), false);

  const originals = {
    FileReader: globalThis.FileReader,
    createImageBitmap: globalThis.createImageBitmap,
    document: globalThis.document,
  };
  let bitmapCalls = 0;
  let closed = false;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }),
    toDataURL: () => "data:image/jpeg;base64,COMPRESSED",
  };

  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,ORIGINAL";
      this.onload();
    }
  };
  globalThis.createImageBitmap = async () => {
    bitmapCalls += 1;
    return { width: 2048, height: 1024, close() { closed = true; } };
  };
  globalThis.document = { createElement: () => canvas };

  try {
    assert.deepEqual(await compressImageFile({ size: 1024, type: "image/png" }), {
      data: "ORIGINAL",
      mimeType: "image/png",
    });
    assert.deepEqual(await compressImageFile({ size: 2 * 1024 * 1024, type: "image/png" }), {
      data: "COMPRESSED",
      mimeType: "image/jpeg",
    });
    assert.equal(bitmapCalls, 1);
    assert.equal(canvas.width, 1024);
    assert.equal(canvas.height, 512);
    assert.equal(closed, true);
  } finally {
    globalThis.FileReader = originals.FileReader;
    globalThis.createImageBitmap = originals.createImageBitmap;
    globalThis.document = originals.document;
  }
});

test("recognizes exact slash commands for one-Enter submission", () => {
  const builtin = { name: "copy", description: "", source: "builtin" };
  assert.equal(isExactSlashCommand("/copy", builtin), true);
  assert.equal(isExactSlashCommand("  /copy  ", builtin), true);
  assert.equal(isExactSlashCommand("/co", builtin), false);
  assert.equal(isExactSlashCommand("/copy extra", builtin), false);
  assert.equal(isExactSlashCommand("/copy", { ...builtin, source: "extension" }), false);
});

test("clears a completed built-in only while its submitted input is unchanged", () => {
  assert.equal(canClearBuiltinCommandInput("/copy", 0, "/copy"), true);
  assert.equal(canClearBuiltinCommandInput("new follow-up", 0, "/copy"), false);
  assert.equal(canClearBuiltinCommandInput("/copy", 1, "/copy"), false);
});

test("keeps only read-only built-ins available while a run is active", () => {
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/copy"), true);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/session"), true);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/compact"), false);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/reload"), false);
});

test("restores text and base64 images when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "text", text: "Review this image @src/example.ts " },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ],
  };

  assert.equal(getUserMessageText(message), "Review this image @src/example.ts ");
  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/png" },
  ]);
});

test("restores legacy flat image entries when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "image", data: "AQID", mimeType: "image/jpeg" },
    ],
  };

  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/jpeg" },
  ]);
});

test("does not restore a historical message over a pending image attachment", () => {
  assert.equal(canRestoreUserMessage("", 0, 0), true);
  assert.equal(canRestoreUserMessage("", 1, 0), false);
  assert.equal(canRestoreUserMessage("", 0, 1), false);
  assert.equal(canRestoreUserMessage("draft", 0, 0), false);
});

test("restores a cleared submission using the queued React state", () => {
  let value = "failed submission";
  const updates = [
    () => "",
    (current) => mergeRestoredSubmissionText("failed submission", current),
  ];

  for (const update of updates) value = update(value);

  assert.equal(value, "failed submission");
  assert.equal(
    mergeRestoredSubmissionText("failed submission", "new draft"),
    "failed submission\n\nnew draft",
  );
  assert.equal(
    mergeRestoredSubmissionText("failed submission", "failed submission"),
    "failed submission\n\nfailed submission",
  );
});

test("keeps a failed first submission recoverable across a composer remount", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeRestoredSubmissionDraft(
    "failed submission",
    [image],
    "",
    [],
  );

  assert.deepEqual(restored, {
    value: "failed submission",
    images: [image],
  });
  assert.deepEqual(
    mergeRestoredSubmissionDraft("failed submission", [image], "new draft", []),
    {
      value: "failed submission\n\nnew draft",
      images: [image],
    },
  );
});

test("preserves duplicate image attachments when restoring a submission", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeRestoredSubmissionDraft("", [image, image], "", [image]);

  assert.deepEqual(restored.images, [image, image, image]);
});

test("keeps restored images above the per-message send limit", () => {
  const submitted = Array.from({ length: 8 }, (_, index) => ({
    data: `AQID${index}`,
    mimeType: "image/png",
  }));
  const current = Array.from({ length: 5 }, (_, index) => ({
    data: `BAUG${index}`,
    mimeType: "image/png",
  }));
  const restored = mergeRestoredSubmissionDraft("queued", submitted, "draft", current);
  assert.equal(restored.images.length, 13);
  assert.equal(restored.images[0].data, submitted[0].data);
  assert.equal(restored.images[12].data, current[4].data);
});

test("moves a provisional new-session draft to the real session key", () => {
  const provisionalKey = "new:/tmp/rekey-test";
  const sessionKey = "session-rekey-test";
  clearDraft(provisionalKey);
  clearDraft(sessionKey);
  setDraft(provisionalKey, { value: "queued while preflight ran", images: [] });

  assert.deepEqual(rekeyDraft(provisionalKey, sessionKey), {
    value: "queued while preflight ran",
    images: [],
  });
  assert.equal(getDraft(provisionalKey), null);
  assert.deepEqual(getDraft(sessionKey), {
    value: "queued while preflight ran",
    images: [],
  });

  clearDraft(sessionKey);
});

test("rekey keeps a synchronously restored draft when React state is still empty", () => {
  const provisionalKey = "new:/tmp/rekey-race";
  const sessionKey = "session-rekey-race";
  clearDraft(provisionalKey);
  clearDraft(sessionKey);
  setDraft(provisionalKey, { value: "restored before state flush", images: [] });

  assert.deepEqual(
    rekeyDraft(provisionalKey, sessionKey, { value: "", images: [] }),
    { value: "restored before state flush", images: [] },
  );
  assert.equal(getDraft(provisionalKey), null);
  assert.deepEqual(getDraft(sessionKey), {
    value: "restored before state flush",
    images: [],
  });

  clearDraft(sessionKey);
});

test("renders compact errors above the input as a wrapping alert", () => {
  const error = "Compaction failed: OpenAI API error (403): <html>request forbidden</html>";
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onCompact() {},
        isStreaming: false,
        compactError: error,
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Compaction failed: OpenAI API error/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
  assert.match(html, /white-space:pre-wrap/);
  assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
});

test("modelSupportsImageInput warns only when modality info is known and lacks image", () => {
  const modelList = [
    { id: "text-only", name: "Text Only", provider: "ollama", input: ["text"] },
    { id: "vision", name: "Vision", provider: "anthropic", input: ["text", "image"] },
    { id: "unknown", name: "Unknown", provider: "custom", input: undefined },
  ];

  assert.equal(modelSupportsImageInput({ provider: "ollama", modelId: "text-only" }, modelList), false);
  assert.equal(modelSupportsImageInput({ provider: "anthropic", modelId: "vision" }, modelList), true);
  // Unknown modality info never blocks the user.
  assert.equal(modelSupportsImageInput({ provider: "custom", modelId: "unknown" }, modelList), true);
  // Model missing from the list is treated as unknown.
  assert.equal(modelSupportsImageInput({ provider: "x", modelId: "missing" }, modelList), true);
  assert.equal(modelSupportsImageInput(null, modelList), true);
  assert.equal(modelSupportsImageInput({ provider: "ollama", modelId: "text-only" }, undefined), true);
});

test("renders image warnings for known text-only defaults without an explicit model selection", () => {
  const draftKey = "new:/tmp/image-warning-default";
  const modelList = [
    { id: "text-only", name: "Text Only", provider: "custom", input: ["text"] },
    { id: "vision", name: "Vision", provider: "custom", input: ["text", "image"] },
    { id: "unknown", name: "Unknown", provider: "custom" },
  ];
  setDraft(draftKey, {
    value: "Describe this image",
    images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
  });

  try {
    for (const [modelId, warningExpected] of [["text-only", true], ["vision", false], ["unknown", false], [null, false]]) {
      const html = renderToStaticMarkup(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(ChatInput, {
            onSend() {},
            onAbort() {},
            isStreaming: false,
            isAutoModelSelection: true,
            model: modelId ? { provider: "custom", modelId } : null,
            modelList,
            draftKey,
          }),
        ),
      );

      assert.match(html, /<img/);
      assert.equal(html.includes("Images may not be sent"), warningExpected, `default model: ${modelId}`);
      if (warningExpected) {
        assert.match(html, /The selected model \(Text Only\) does not support image input/);
        assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
      }
    }
  } finally {
    clearDraft(draftKey);
  }
});

test("keeps over-limit restored images in the composer and blocks send", () => {
  const draftKey = "new:/tmp/too-many-restored-images";
  const images = Array.from({ length: 11 }, (_, index) => ({
    data: Buffer.from(`img${index}`).toString("base64"),
    mimeType: "image/png",
  }));
  setDraft(draftKey, { value: "recalled queue", images });

  try {
    const html = renderToStaticMarkup(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(ChatInput, {
          onSend() {},
          onAbort() {},
          isStreaming: false,
          draftKey,
        }),
      ),
    );

    assert.equal((html.match(/<img/g) ?? []).length, 11);
    assert.match(html, /Too many images to send/);
    assert.match(html, /This draft has 11 images/);
    assert.match(html, /disabled=""/);
    assert.ok(html.indexOf("Too many images to send") < html.indexOf("<textarea"));
  } finally {
    clearDraft(draftKey);
  }
});

test("wraps @ file picker selection and caps the menu above the composer", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(source, /setAtActiveIndex\(\(i\) => atMatches\.length === 0 \? 0 : \(i \+ 1\) % atMatches\.length\)/);
  assert.match(source, /min\(48vh, 400px, \$\{atMenuMaxHeight\}px\)/);
  assert.match(source, /<fieldset\s+disabled=\{builtinCommandPending\}\s+aria-busy=\{builtinCommandPending\}/);
});
