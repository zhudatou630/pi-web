import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const globalCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const tabSource = await readFile(new URL("./ChatTabBar.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const beaconSource = await readFile(new URL("./LivePulseBeacon.tsx", import.meta.url), "utf8");

test("defines a refined beacon with an expanding wave ring and glowing core", () => {
  assert.match(globalCss, /\.live-pulse-beacon-halo\s*\{[^}]*width:\s*5px;[^}]*height:\s*5px;/);
  assert.match(globalCss, /\.live-pulse-beacon-halo\s*\{[^}]*border:\s*1\.2px solid var\(--accent\);/);
  assert.match(globalCss, /\.live-pulse-beacon-halo\s*\{[^}]*opacity:\s*0;/);
  assert.match(globalCss, /\.live-pulse-beacon-core\s*\{[^}]*width:\s*5px;[^}]*height:\s*5px;/);
  assert.match(globalCss, /\.live-pulse-beacon-core\s*\{[^}]*box-shadow:/);
  assert.match(globalCss, /@keyframes live-pulse-wave/);
  assert.match(globalCss, /@keyframes live-pulse-core/);
  assert.match(globalCss, /@media \(prefers-reduced-motion: reduce\)/);
});

test("unifies running status indicator across sidebar, chat tabs, process steps, and subagent switcher", async () => {
  const panelSource = await readFile(new URL("./AgentSessionPanel.tsx", import.meta.url), "utf8");
  assert.match(sidebarSource, /function RunningSessionIndicator\(\)[\s\S]*?<LivePulseBeacon/);
  assert.match(sidebarSource, /activity\.running > 0[\s\S]*?<LivePulseBeacon size=\{10\}/);
  assert.match(tabSource, /\{isRunning \? \(\s*<LivePulseBeacon/);
  assert.match(chatWindowSource, /\{isStreaming && \([\s\S]*?<LivePulseBeacon/);
  assert.match(panelSource, /if \(status === "running" \|\| status === "starting"\) \{\s*return <LivePulseBeacon/);
  assert.match(beaconSource, /export function LivePulseBeacon/);
});
