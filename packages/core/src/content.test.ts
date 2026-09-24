import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildHashIndex,
  classifyDups,
  ensureHashed,
  hashFile,
  loadRegistry,
  registryFile,
  saveRegistry,
} from "./content";

let root: string;
const dirA = () => path.join(root, "a");
const dirB = () => path.join(root, "b");

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "detect-content-"));
  mkdirSync(dirA());
  mkdirSync(dirB());
  writeFileSync(path.join(dirA(), "one.txt"), "hello world");
  writeFileSync(path.join(dirB(), "copy.txt"), "hello world"); // 相同内容, 不同目录不同名
  writeFileSync(path.join(dirB(), "other.txt"), "different");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("hashFile", () => {
  test("相同内容 hash 相同, 不同内容不同", async () => {
    const h1 = await hashFile(path.join(dirA(), "one.txt"));
    const h2 = await hashFile(path.join(dirB(), "copy.txt"));
    const h3 = await hashFile(path.join(dirB(), "other.txt"));
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe("registry", () => {
  test("保存后可读回; 损坏视为空", async () => {
    const file = path.join(root, "reg.json");
    await saveRegistry(file, {
      entries: { "/x": { size: 1, mtime: 2, hash: "ab", firstSeen: "2026-01-01T00:00:00" } },
    });
    expect((await loadRegistry(file)).entries["/x"]?.hash).toBe("ab");
    writeFileSync(file, "{oops");
    expect(await loadRegistry(file)).toEqual({ entries: {} });
  });

  test("registryFile 位于默认状态目录", () => {
    expect(registryFile().endsWith(path.join("detect-new-files", "registry.json"))).toBe(true);
  });
});

describe("ensureHashed + classifyDups", () => {
  test("跨目录相同内容被识别为重复", async () => {
    const reg = { entries: {} };
    await ensureHashed(new Set([path.join(dirA(), "one.txt")]), reg);
    const known = buildHashIndex(reg);

    // 之后另一个目录出现同内容文件
    const setB = new Set([path.join(dirB(), "copy.txt"), path.join(dirB(), "other.txt")]);
    await ensureHashed(setB, reg);
    const dups = classifyDups(setB, reg, known);
    expect(dups.get(path.join(dirB(), "copy.txt"))).toBe(path.join(dirA(), "one.txt"));
    expect(dups.has(path.join(dirB(), "other.txt"))).toBe(false);
  });

  test("同批次内相同内容: 排序在后者标为前者的重复", async () => {
    const reg = { entries: {} };
    const f1 = path.join(dirA(), "one.txt");
    const f2 = path.join(dirB(), "copy.txt");
    const news = new Set([f2, f1]);
    await ensureHashed(news, reg);
    const dups = classifyDups(news, reg, new Map());
    expect(dups.get(f2)).toBe(f1);
    expect(dups.has(f1)).toBe(false);
  });

  test("size+mtime 未变时不重算 (缓存命中)", async () => {
    const reg = { entries: {} };
    const files = new Set([path.join(dirA(), "one.txt")]);
    await ensureHashed(files, reg);
    const before = JSON.parse(JSON.stringify(reg.entries));
    await ensureHashed(files, reg);
    expect(reg.entries).toEqual(before);
  });
});
