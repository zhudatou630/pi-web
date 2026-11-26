import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const globalCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const tabSource = await readFile(new URL("./ChatTabBar.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const messageSource = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
const beaconSource = await readFile(new URL("./LivePulseBeacon.tsx", import.meta.url), "utf8");

test("session state is one 8px dot: running breathes in the dim gray, still under reduced motion", () => {
  assert.match(globalCss, /\.session-status-dot \{[^}]*width: 8px;[^}]*height: 8px;[^}]*border-radius: 50%;/);
  assert.match(globalCss, /\.session-status-dot\[data-status="running"\] \{\s*background: var\(--text-dim\);\s*animation: session-status-breathe 1\.6s ease-in-out infinite;/);
  assert.match(globalCss, /@keyframes session-status-breathe \{\s*0%, 100% \{ opacity: 1; \}\s*50% \{ opacity: 0\.35; \}/);
  assert.match(globalCss, /\.session-status-dot\[data-status="unread"\] \{ background: var\(--accent\); \}/);
  assert.match(globalCss, /\.session-status-dot\[data-status="awaiting"\] \{ background: var\(--warning\); \}/);
  assert.match(globalCss, /\.session-status-dot\[data-status="error"\] \{ background: var\(--danger\); \}/);
  assert.match(globalCss, /@media \(prefers-reduced-motion: reduce\) \{\s*\.session-status-dot\[data-status="running"\] \{\s*animation: none;/);
  assert.doesNotMatch(globalCss, /live-pulse-beacon-(halo|core)|@keyframes live-pulse/);
});

test("every running mark is the same dot: sidebar, chat tabs, process steps, live rows", async () => {
  const panelSource = await readFile(new URL("./AgentSessionPanel.tsx", import.meta.url), "utf8");
  assert.match(beaconSource, /<span className="session-status-dot" data-status="running" aria-hidden="true" \/>/);
  assert.match(sidebarSource, /<SessionStatusDot status=\{status\} \/>/);
  assert.match(tabSource, /<SessionStatusDot status=\{state\} \/>/);
  assert.match(messageSource, /function StepSlot[\s\S]*?data-status="running"/);
  assert.match(chatWindowSource, /\{isStreaming \? \([\s\S]*?<LivePulseBeacon/);
  // An idle manual compaction gets the live process row by itself; a run already labels it.
  assert.match(chatWindowSource, /function CompactionActivity[\s\S]*?<LivePulseBeacon size=\{12\} \/>[\s\S]*?<ProcessLiveDuration/);
  assert.match(chatWindowSource, /\{isCompacting && !sessionBusy && !streamState\.isStreaming && <CompactionActivity t=\{t\} \/>\}/);
  assert.match(panelSource, /if \(status === "running" \|\| status === "starting"\) \{\s*return <LivePulseBeacon/);
});
