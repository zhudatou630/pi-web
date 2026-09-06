import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { disambiguatePathLabels } = await createJiti(import.meta.url).import("./tab-labels.ts");

function labels(items) {
  return Object.fromEntries(disambiguatePathLabels(items));
}

test("unique names stay as basenames", () => {
  assert.deepEqual(labels([
    { id: "a", path: "/repo/app/page.tsx" },
    { id: "b", path: "/repo/lib/rpc-manager.ts" },
  ]), {
    a: "page.tsx",
    b: "rpc-manager.ts",
  });
});

test("conflicting names append the shortest distinguishing parent", () => {
  assert.deepEqual(labels([
    { id: "a", path: "/repo/app/api/sessions/route.ts" },
    { id: "b", path: "/repo/app/api/agent/route.ts" },
  ]), {
    a: "route.ts · sessions",
    b: "route.ts · agent",
  });
});

test("same parent name walks further up the path", () => {
  assert.deepEqual(labels([
    { id: "a", path: "/repo/app/sessions/route.ts" },
    { id: "b", path: "/repo/lib/sessions/route.ts" },
  ]), {
    a: "route.ts · app/sessions",
    b: "route.ts · lib/sessions",
  });
});

test("root and Windows paths keep browser slash rules", () => {
  assert.deepEqual(labels([
    { id: "root", path: "/route.ts" },
    { id: "nested", path: "/var/route.ts" },
  ]), {
    root: "route.ts",
    nested: "route.ts · var",
  });
  assert.deepEqual(labels([
    { id: "c", path: "C:\\repo\\app\\route.ts" },
    { id: "d", path: "D:\\repo\\app\\route.ts" },
  ]), {
    c: "route.ts · C:/repo/app",
    d: "route.ts · D:/repo/app",
  });
});

test("file and terminal tabs in one set disambiguate together", () => {
  assert.deepEqual(labels([
    { id: "file", path: "/work/apps/pi-web" },
    { id: "term", path: "/other/apps/pi-web" },
  ]), {
    file: "pi-web · work/apps",
    term: "pi-web · other/apps",
  });
});

test("closing one conflict restores the short name", () => {
  const both = labels([
    { id: "a", path: "/repo/app/route.ts" },
    { id: "b", path: "/repo/lib/route.ts" },
  ]);
  assert.equal(both.a, "route.ts · app");
  assert.deepEqual(labels([{ id: "a", path: "/repo/app/route.ts" }]), { a: "route.ts" });
});

test("each conflict uses its own shortest unique parent suffix", () => {
  assert.deepEqual(labels([
    { id: "sessions", path: "/repo/app/api/sessions/route.ts" },
    { id: "app-agent", path: "/repo/app/api/agent/route.ts" },
    { id: "lib-agent", path: "/repo/lib/api/agent/route.ts" },
  ]), {
    sessions: "route.ts · sessions",
    "app-agent": "route.ts · app/api/agent",
    "lib-agent": "route.ts · lib/api/agent",
  });
});

test("keeps a non-basename custom label when it is already unique", () => {
  assert.deepEqual(labels([
    { id: "notes", path: "/repo/docs/README.md", label: "notes" },
    { id: "route", path: "/repo/app/api/sessions/route.ts", label: "route.ts" },
  ]), {
    notes: "notes",
    route: "route.ts",
  });
});

test("groups and disambiguates by the existing label, not the path basename", () => {
  assert.deepEqual(labels([
    { id: "work", path: "/work/apps/pi-web", label: "workspace" },
    { id: "other", path: "/other/apps/pi-web", label: "workspace" },
    { id: "file", path: "/work/apps/pi-web/README.md", label: "README.md" },
  ]), {
    work: "workspace · work/apps",
    other: "workspace · other/apps",
    file: "README.md",
  });
});

test("identical paths stay on the original label instead of a fake absolute path", () => {
  assert.deepEqual(labels([
    { id: "file", path: "/repo/app/route.ts", label: "route.ts" },
    { id: "term", path: "/repo/app/route.ts", label: "route.ts" },
    { id: "other", path: "/repo/lib/route.ts", label: "route.ts" },
  ]), {
    file: "route.ts",
    term: "route.ts",
    other: "route.ts · lib",
  });
});
