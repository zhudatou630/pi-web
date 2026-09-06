import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Isolated browser fixture: no Next dev/build and no production server involved.
test("ChatMinimap Hermes browser regressions", { timeout: 120000 }, async (t) => {
  let build, chromium;
  try {
    ({ build } = await import("esbuild"));
    ({ chromium } = await import("playwright"));
  } catch {
    t.skip("optional esbuild + playwright are needed for isolated browser regressions");
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), "chat-minimap-"));
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let browser, server;
  try {
    await build({
      stdin: {
        resolveDir: cwd,
        loader: "tsx",
        contents: `
          import React, { useRef } from 'react';
          import { createRoot } from 'react-dom/client';
          import { flushSync } from 'react-dom';
          import { ChatMinimap, ChatMinimapRail } from './components/ChatMinimap';
          import { I18nProvider } from './hooks/useI18n';
          const root = createRoot(document.getElementById('root'));
          window.requests = [];
          const jump = (id) => new Promise((resolve, reject) => window.requests.push({ id, resolve, reject }));
          window.settle = (index, name, message) => {
            const request = window.requests[index];
            if (!name) request.resolve();
            else request.reject(Object.assign(new Error(message), { name }));
          };
          const items = (count) => Array.from({ length: count }, (_, i) => ({ entryId: 'u' + i, preview: '问题 ' + i + ' ' + '很长的一行内容 '.repeat(30) }));
          function Fixture({ config }) {
            const scroll = useRef(null), content = useRef(null);
            if (config.mode === 'rail') return <ChatMinimapRail items={items(config.count ?? 10000)} activeEntryId={config.active ?? 'u2'} label="用户提问" left={config.left ?? 1262} top={config.top ?? 320} maxHeight={config.maxHeight} width={config.width} onJumpToEntry={jump} />;
            return <I18nProvider>
              <div id="chat" ref={scroll} style={{ height: 600, width: 1100, maxWidth: 'calc(100vw - 40px)', overflowY: 'auto', margin: '100px auto 0', background: '#fbfaf8' }}>
                <div id="content" ref={content} style={{ maxWidth: 820, margin: 'auto' }}>
                  {(config.groups ?? [['a49', 1000], ['u50', 60], ['a50', 1200], ['u51', 60]]).map(([id, height]) => <div key={id} data-entry-id={id} style={{ height, boxSizing: 'border-box', padding: '16px 24px', background: id.startsWith('u') ? '#efede9' : '#fbfaf8', borderBottom: '1px solid #e8e5e0', font: '15px/1.7 sans-serif' }}>{id.startsWith('u') ? '用户提问 ' + id.slice(1) : '长回答 / process 分组 ' + id + '（对应 user 已不在 DOM 窗口中）'}{!id.startsWith('u') && <><p>这里是上一轮提问的长回答。正文保持居中，提问目录固定在对话滚动区域右边缘。</p><p>将鼠标移到右侧的一小撮短线，向左展开全部用户提问；每条提问一行，点击即可返回对应位置。</p><p>目录可以滚动浏览，也支持方向键、Home、End 和 Esc。当前阅读位置由实际对话滚动状态决定。</p></>}</div>)}
                </div>
              </div>
              <ChatMinimap sessionId={config.session ?? 'session/a'} leafId={config.leaf ?? 'leaf b'} outlineRevision={config.revision ?? '1'} scrollContainer={scroll} contentContainer={content} loadedEntryIds={config.loaded ?? ['a49', ...Array.from({ length: 50 }, (_, i) => 'u' + (50 + i))]} onJumpToEntry={jump} />
            </I18nProvider>;
          }
          let key = 0;
          window.mount = (config, reset = true) => flushSync(() => root.render(<Fixture key={reset ? ++key : key} config={config} />));
        `,
      },
      outfile: path.join(directory, "fixture.js"),
      bundle: true,
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
    });
    server = createServer(async (req, res) => {
      if (req.url === "/fixture.js" || req.url === "/fixture.css") {
        res.setHeader("content-type", req.url.endsWith("css") ? "text/css" : "text/javascript");
        res.end(await readFile(path.join(directory, req.url.slice(1))));
      } else {
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>:root{--bg:#fbfaf8;--bg-secondary:#f1efeb;--bg-hover:#eeece7;--bg-selected:#e7e3dc;--text:#292722;--text-muted:#88847c;--border:#e0dcd5;--accent:#9b7543}body{margin:0;min-height:2200px;background:#fbfaf8;font-family:system-ui,sans-serif}#outside{position:absolute;top:780px;left:20px}</style></head><body><div id="root"></div><button id="outside">outside</button><script src="/fixture.js"></script></body></html>');
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const channel = process.env.CHAT_MINIMAP_BROWSER_CHANNEL;
    const installedChromium = await access(chromium.executablePath()).then(() => true, () => false);
    browser = await chromium.launch({
      headless: true,
      ...(channel ? { channel } : installedChromium ? { executablePath: chromium.executablePath() } : { channel: "chrome" }),
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const fetched = [];
    await page.route("**/api/sessions/**/outline*", async (route) => {
      fetched.push(route.request().url());
      await route.fulfill({ json: { items: Array.from({ length: 100 }, (_, i) => ({ entryId: `u${i}`, preview: `问题 ${i}：如何让对话提问目录更清晰，且不影响正文阅读？` })) } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const mount = (config, reset = true) => page.evaluate(({ config, reset }) => window.mount(config, reset), { config, reset });
    const trigger = page.locator("button[aria-expanded]");
    const panel = page.getByRole("navigation");
    const row = (i) => panel.locator(`button[data-outline-index="${i}"]`);
    const rows = panel.locator("button[data-outline-index]");
    // Navigation includes status/retry chrome; its first child is the virtual scrollport.
    const list = panel.locator(":scope > div").first();
    const active = () => panel.locator('[aria-current="location"]').getAttribute("data-outline-index");
    const waitActive = (index) => page.waitForFunction((index) => document.querySelector(`button[data-outline-index="${index}"][aria-current="location"]`), index);
    const open = async () => {
      await trigger.hover();
      await panel.waitFor();
      assert.equal(await trigger.getAttribute("aria-expanded"), "true");
      assert.equal(await panel.getAttribute("aria-label"), await trigger.getAttribute("aria-label"));
    };
    const leave = async () => {
      await page.mouse.move(10, 10, { steps: 12 });
      await panel.waitFor({ state: "detached" });
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    };
    // Cross the actual trigger/panel gap, pause there (not merely a direct locator.click),
    // then enter the panel and move to the row before issuing a physical mouse click.
    const enterPanel = async () => {
      await open();
      const tbox = await trigger.boundingBox(), pbox = await panel.boundingBox();
      assert.ok(pbox.x + pbox.width <= tbox.x + 1, "directory must expand left of trigger");
      const y = Math.max(pbox.y + 2, Math.min(pbox.y + pbox.height - 2, tbox.y + tbox.height / 2));
      await page.mouse.move(tbox.x + 2, y, { steps: 8 });
      await page.mouse.move((tbox.x + pbox.x + pbox.width) / 2, y, { steps: 8 });
      await page.waitForTimeout(180);
      assert.equal(await panel.count(), 1, "hover bridge must survive the gap");
      await page.mouse.move(pbox.x + pbox.width - 32, y, { steps: 8 });
      await page.waitForTimeout(100);
      assert.equal(await panel.count(), 1);
    };
    const clickRow = async (index) => {
      const box = await row(index).boundingBox();
      assert.ok(box, `row ${index} must be rendered before pointer navigation`);
      const pbox = await panel.boundingBox();
      const y = Math.max(box.y + 2, Math.min(box.y + box.height / 2, pbox.y + pbox.height - 2));
      await page.mouse.move(box.x + Math.min(100, box.width / 2), y, { steps: 12 });
      await page.mouse.down();
      await page.mouse.up();
    };
    const assertVirtual = async () => {
      const count = await rows.count();
      assert.ok(count > 0 && count <= 14, `36px virtual list should have at most 14 rows, got ${count}`);
    };
    const assertGeometry = async () => {
      await page.waitForFunction(() => {
        const chat = document.querySelector('#chat').getBoundingClientRect();
        const trigger = document.querySelector('button[aria-expanded]')?.getBoundingClientRect();
        return trigger && Math.abs(trigger.left - (chat.right - 28)) <= 1;
      });
      const chat = await page.locator("#chat").boundingBox(), box = await trigger.boundingBox();
      assert.ok(Math.abs(box.width - 24) <= 1, "trigger is 24px wide");
      assert.ok(box.y >= Math.max(0, chat.y) && box.y + box.height <= Math.min(page.viewportSize().height, chat.y + chat.height));
      await enterPanel();
      const pbox = await panel.boundingBox();
      assert.ok(pbox.x >= Math.max(0, chat.x) - 1, "panel stays within scroll container and viewport left");
      assert.ok(pbox.y >= Math.max(0, chat.y) - 1, "panel stays within visible top");
      assert.ok(pbox.y + pbox.height <= Math.min(page.viewportSize().height, chat.y + chat.height) + 1, "panel stays within visible bottom");
      assert.ok(pbox.x + pbox.width <= Math.min(page.viewportSize().width, chat.x + chat.width) + 1);
      await leave();
    };

    await t.test("compact decorative trigger opens one left-hand virtual directory; pointer bridge, truncation, close and reopen current", async () => {
      await mount({ mode: "rail" });
      await trigger.waitFor();
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
      assert.equal(await trigger.getAttribute("aria-label"), "用户提问");
      assert.equal(await panel.count(), 0);
      const markers = trigger.locator("[data-marker-index]");
      assert.ok(await markers.count() >= 3 && await markers.count() <= 15, "only a small cluster of decorative marks");
      assert.equal(await trigger.locator("button").count(), 0);
      assert.equal(await trigger.locator('[aria-current]').count(), 0, "decorative marks must not duplicate row aria-current");
      assert.ok(await markers.evaluateAll((els) => els.every((el) => el.tagName === 'SPAN' && el.getAttribute('aria-hidden') === 'true')));
      assert.equal(await trigger.locator('[data-marker-index="2"][data-active="true"]').count(), 1);
      assert.ok((await trigger.boundingBox()).height <= 140);
      const mark = await markers.first().evaluate((el) => {
        const style = getComputedStyle(el, '::before');
        return { width: parseFloat(style.width), height: parseFloat(style.height) };
      });
      assert.ok(mark.width <= 20 && mark.height <= 4, "decorative markers are short horizontal lines");
      await enterPanel();
      assert.equal(await panel.count(), 1);
      await waitActive(2);
      await assertVirtual();
      const pbox = await panel.boundingBox();
      assert.ok(pbox.width >= 400 && pbox.width <= 440, "default directory width is 440px");
      assert.equal(pbox.height, 400, "maxHeight includes border and padding");
      const first = await row(1).boundingBox(), second = await row(2).boundingBox();
      assert.equal(second.y - first.y, 36);
      assert.equal(second.height, 36);
      // Allow a dedicated text span inside the row, while requiring real ellipsis/overflow.
      assert.ok(await row(1).evaluate((el) => [el, ...el.querySelectorAll('*')].some((node) => {
        const style = getComputedStyle(node);
        return style.whiteSpace === 'nowrap' && style.textOverflow === 'ellipsis' && node.scrollWidth > node.clientWidth;
      })));
      const appearance = (el) => {
        const s = getComputedStyle(el);
        return [s.backgroundColor, s.color, s.fontWeight, s.borderColor].join('|');
      };
      assert.notEqual(await row(2).evaluate(appearance), await row(1).evaluate(appearance), "current row must be visually highlighted");
      assert.equal(await page.evaluate(({ x, y }) => {
        const modal = document.createElement('div');
        modal.id = 'fixture-modal';
        Object.assign(modal.style, { position: 'fixed', inset: '0', zIndex: '90', background: 'white' });
        document.body.append(modal);
        const topmost = document.elementFromPoint(x, y)?.id;
        modal.remove();
        return topmost;
      }, { x: pbox.x + 100, y: pbox.y + 12 }), 'fixture-modal');
      await page.evaluate(() => { window.requests = []; });
      await clickRow(3);
      await page.waitForFunction(() => window.requests.length === 1);
      assert.equal(await page.evaluate(() => window.requests[0].id), "u3");
      assert.equal(await active(), "2", "click must not optimistically change current row");
      await page.evaluate(() => window.settle(0));
      await page.getByRole("status").waitFor({ state: "detached" });
      assert.equal(await active(), "2", "promise resolution alone must not change current row");
      await leave(); // Also closes after a click has left keyboard focus inside the panel.
      await mount({ mode: "rail", active: "u7500" }, false);
      await enterPanel();
      await waitActive(7500);
      await assertVirtual();
      await page.mouse.wheel(0, 2000);
      await page.waitForFunction(() => !document.querySelector('button[data-outline-index="7500"]'));
      await leave();
      await enterPanel();
      await waitActive(7500);
      await leave();
    });

    await t.test("keyboard Arrow/Home/End/Escape and wheel browse all 10000 rows without scrolling the page", async () => {
      await mount({ mode: "rail" });
      const pageTop = await page.evaluate(() => window.scrollY);
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      await panel.waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-outline-index')), true);
      await page.keyboard.press("End");
      await row(9999).waitFor();
      assert.equal(await row(9999).evaluate((el) => el === document.activeElement), true);
      await assertVirtual();
      await page.keyboard.press("ArrowUp");
      assert.equal(await row(9998).evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press("Home");
      await row(0).waitFor();
      assert.equal(await row(0).evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press("ArrowDown");
      assert.equal(await row(1).evaluate((el) => el === document.activeElement), true);
      assert.equal(await page.evaluate(() => window.scrollY), pageTop);
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
      assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
      await page.locator("#outside").focus();
      await enterPanel();
      await page.mouse.wheel(0, 2000);
      await page.waitForFunction(() => document.querySelector('nav > div')?.scrollTop > 1000);
      await assertVirtual();
      await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await row(9999).waitFor();
      const bottom = await list.evaluate((el) => el.scrollTop);
      await page.mouse.wheel(0, 1000);
      await page.waitForTimeout(120);
      assert.equal(await page.evaluate(() => window.scrollY), pageTop, "wheel at directory boundary must not scroll body");
      await page.mouse.wheel(0, -2000);
      await page.waitForFunction((bottom) => document.querySelector('nav > div')?.scrollTop < bottom - 1000, bottom);
      await assertVirtual();
      await leave();
      await enterPanel();
      await waitActive(2);
      await leave();
    });

    await t.test("async loading, rejection/retry, AbortError and latest-click wins without optimistic highlight", async () => {
      await mount({ mode: "rail", count: 10 });
      await page.evaluate(() => { window.requests = []; });
      await enterPanel();
      await clickRow(3);
      await page.getByRole("status").waitFor();
      assert.match(await page.getByRole("status").innerText(), /正在跳转/);
      assert.equal(await active(), "2");
      await clickRow(4);
      await page.evaluate(() => window.settle(1, "Error", "目标不在分支"));
      await page.getByRole("button", { name: "重试", exact: true }).waitFor();
      await page.evaluate(() => window.settle(0, "AbortError", "old cancelled"));
      assert.match(await page.getByRole("status").innerText(), /目标不在分支/);
      await page.getByRole("button", { name: "重试", exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.requests.map((r) => r.id)), ["u3", "u4", "u4"]);
      await page.evaluate(() => window.settle(2));
      await page.getByRole("status").waitFor({ state: "detached" });
      await leave();
      await enterPanel();
      await clickRow(5);
      await page.evaluate(() => window.settle(3, "AbortError", "cancelled"));
      await page.getByRole("status").waitFor({ state: "detached" });
      await clickRow(6);
      await clickRow(7);
      await page.evaluate(() => { window.settle(5, "Error", "new failure"); window.settle(4); });
      await page.getByRole("button", { name: "重试", exact: true }).waitFor();
      assert.match(await page.getByRole("status").innerText(), /new failure/);
      assert.equal(await active(), "2");
      await clickRow(8);
      await leave();
      await mount({ mode: "rail", count: 3 });
      await page.evaluate(() => window.settle(6, "Error", "unmounted"));
      await enterPanel();
      assert.equal(await page.getByRole("status").count(), 0);
      await leave();
    });

    await t.test("outline API, suffix-owner long answer, cached scroll geometry and Hermes screenshots", async () => {
      await page.locator("#outside").focus();
      await mount({ mode: "full" });
      await open();
      await waitActive(49);
      assert.ok(fetched.at(-1).includes("/api/sessions/session%2Fa/outline?leafId=leaf+b"));
      await leave();
      await assertGeometry();
      await page.screenshot({ path: "/tmp/chat-minimap-hermes-default.png" });
      await enterPanel();
      await waitActive(49);
      await page.screenshot({ path: "/tmp/chat-minimap-hermes-open.png" });
      await page.waitForTimeout(100); // let initial ResizeObserver delivery settle
      await page.evaluate(() => {
        window.rectReads = 0;
        document.querySelectorAll('[data-entry-id]').forEach((node) => {
          const original = node.getBoundingClientRect.bind(node);
          node.getBoundingClientRect = () => { window.rectReads++; return original(); };
        });
      });
      await page.locator("#chat").evaluate((el) => { el.scrollTop = 700; });
      await page.waitForTimeout(80);
      assert.equal(await active(), "49");
      assert.equal(await page.evaluate(() => window.rectReads), 0);
      await page.locator("#chat").evaluate((el) => { el.scrollTop = 980; });
      await waitActive(50);
      assert.equal(await page.evaluate(() => window.rectReads), 0);
      const pageTop = await page.evaluate(() => window.scrollY);
      // Mutation + resize moves the next turn below the reading line without a scroll event.
      await page.locator('[data-entry-id="a49"]').evaluate((el) => { el.style.height = "1500px"; });
      await waitActive(49);
      assert.ok(await page.evaluate(() => window.rectReads) > 0);
      assert.equal(await page.evaluate(() => window.scrollY), pageTop);
      await page.evaluate(() => {
        window.nestedReads = 0;
        const nested = document.createElement('div');
        nested.dataset.entryId = 'u99';
        const original = nested.getBoundingClientRect.bind(nested);
        nested.getBoundingClientRect = () => { window.nestedReads++; return original(); };
        document.querySelector('[data-entry-id="a49"]').append(nested);
      });
      await page.waitForTimeout(80);
      assert.equal(await active(), "49");
      assert.equal(await page.evaluate(() => window.nestedReads), 0);
      await leave();
      const before = fetched.length;
      await mount({ mode: "full", revision: "2" }, false);
      await open();
      await waitActive(49);
      assert.equal(fetched.length, before + 1);
      await leave();
    });

    await t.test("trigger stays at chat.right - 28 through wide/narrow columns, sidebar movement, zoom and narrow viewports", async () => {
      await mount({ mode: "full" });
      await trigger.waitFor();
      await assertGeometry();
      const originalX = (await trigger.boundingBox()).x;
      await page.locator("#content").evaluate((el) => { el.style.maxWidth = "420px"; });
      await page.waitForTimeout(100);
      await assertGeometry();
      assert.equal((await trigger.boundingBox()).x, originalX, "narrow body must not move trigger");
      await page.locator("#content").evaluate((el) => { el.style.marginLeft = "20px"; el.style.marginRight = "auto"; });
      await page.waitForTimeout(100);
      await assertGeometry();
      assert.equal((await trigger.boundingBox()).x, originalX, "off-center body must not move trigger");
      await page.setViewportSize({ width: 1920, height: 1080 });
      await assertGeometry();
      // Sidebar opens: move and resize the actual scroll container, not the body column.
      await page.locator("#chat").evaluate((el) => { el.style.marginLeft = "320px"; el.style.marginRight = "0"; el.style.width = "900px"; });
      await assertGeometry();
      // CSS zoom exercises scaled DOM rects without a Next shell/browser UI dependency.
      await page.locator("#chat").evaluate((el) => { el.style.zoom = "1.25"; });
      await assertGeometry();
      await page.locator("#chat").evaluate((el) => { el.style.zoom = "0.8"; });
      await assertGeometry();
      await mount({ mode: "full" });
      await page.setViewportSize({ width: 800, height: 800 });
      await assertGeometry();
      await page.setViewportSize({ width: 390, height: 760 });
      await assertGeometry();
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await t.test("suffix containing no user belongs to final outline turn; session changes clear stale jump errors", async () => {
      await mount({ mode: "full", loaded: ["a99"], groups: [["a99", 2500]] });
      await enterPanel();
      await waitActive(99);
      await page.evaluate(() => { window.requests = []; });
      await clickRow(99);
      await page.getByRole("status").waitFor();
      await mount({ mode: "full", session: "next" }, false);
      await enterPanel();
      await waitActive(49);
      await page.evaluate(() => window.settle(0, "Error", "old session error"));
      assert.equal(await page.getByRole("status").count(), 0);
      await leave();
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
