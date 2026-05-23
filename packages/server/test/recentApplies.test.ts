import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RecentApplies } from "../src/state/recentApplies.ts";

async function tmpFile(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "visual-edit-recent-"));
  return path.join(dir, name);
}

test("push() persists entries to disk", async () => {
  const file = await tmpFile("history.json");
  const r = new RecentApplies();
  await r.load(file);
  r.push({
    file: "page.tsx",
    line: 1,
    col: 0,
    before: "p-4",
    after: "p-6",
    appliedAt: 1,
  });
  await r.persistNow();

  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw) as { applies: { before: string }[] };
  assert.equal(parsed.applies.length, 1);
  assert.equal(parsed.applies[0]!.before, "p-4");
});

test("load() restores entries from disk", async () => {
  const file = await tmpFile("history.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      applies: [
        { file: "a.tsx", line: 1, col: 0, before: "p-4", after: "p-6", appliedAt: 1 },
        { file: "b.tsx", line: 2, col: 4, before: "m-2", after: "m-4", appliedAt: 2 },
      ],
    }),
  );

  const r = new RecentApplies();
  await r.load(file);
  assert.equal(r.size, 2);
  assert.equal(r.find()?.file, "b.tsx"); // most-recent
});

test("load() skips invalid entries in the persisted file", async () => {
  const file = await tmpFile("history.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      applies: [
        { file: "good.tsx", line: 1, col: 0, before: "p-4", after: "p-6", appliedAt: 1 },
        { garbage: true },
        "not an object",
        null,
      ],
    }),
  );
  const r = new RecentApplies();
  await r.load(file);
  assert.equal(r.size, 1);
  assert.equal(r.list()[0]!.file, "good.tsx");
});

test("load() is silent on missing file (empty buffer)", async () => {
  const file = await tmpFile("history.json");
  // No write — file doesn't exist.
  await fs.rm(path.dirname(file), { recursive: true, force: true });
  const r = new RecentApplies();
  await r.load(file);
  assert.equal(r.size, 0);
});

test("remove() persists the updated buffer", async () => {
  const file = await tmpFile("history.json");
  const r = new RecentApplies();
  await r.load(file);
  const a1 = {
    file: "a.tsx",
    line: 1,
    col: 0,
    before: "p-4",
    after: "p-6",
    appliedAt: 1,
  };
  r.push(a1);
  await r.persistNow();
  r.remove(a1);
  await r.persistNow();

  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
    applies: unknown[];
  };
  assert.equal(parsed.applies.length, 0);
});

test("maxSize is enforced on load (truncates oldest)", async () => {
  const file = await tmpFile("history.json");
  const big = Array.from({ length: 100 }, (_, i) => ({
    file: `f${i}.tsx`,
    line: 1,
    col: 0,
    before: "p-4",
    after: "p-6",
    appliedAt: i,
  }));
  await fs.writeFile(file, JSON.stringify({ applies: big }));

  const r = new RecentApplies(50);
  await r.load(file);
  assert.equal(r.size, 50);
  // Most-recent should be the highest appliedAt that survived (the last 50).
  assert.equal(r.find()?.appliedAt, 99);
});
