import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { diff, loadState, saveState, scan, stateFileFor } from "./index";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "detect-core-"));
  mkdirSync(path.join(dir, "sub"));
  writeFileSync(path.join(dir, "a.wav"), "");
  writeFileSync(path.join(dir, "b.log"), "");
  writeFileSync(path.join(dir, "UPPER.WAV"), "");
  writeFileSync(path.join(dir, "sub", "c.wav"), "");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cfg = (over: Partial<Parameters<typeof scan>[0]> = {}) => ({
  directory: dir,
  exts: ["wav"],
  recursive: false,
  ignoreCase: false,
  ...over,
});

describe("scan", () => {
  test("匹配指定后缀且大小写敏感, 不递归时不含子目录", () => {
    const files = scan(cfg());
    expect([...files].map((f) => path.basename(f)).sort()).toEqual(["a.wav"]);
  });

  test("递归包含子目录", () => {
    const files = scan(cfg({ recursive: true }));
    expect(files.has(path.join(dir, "sub", "c.wav"))).toBe(true);
  });

  test("ignore-case 忽略大小写", () => {
    const files = scan(cfg({ ignoreCase: true, exts: ["WAV".toLowerCase()] }));
    expect(files.size).toBe(2);
  });

  test("多后缀匹配 (大小写敏感, UPPER.WAV 不算)", () => {
    const files = scan(cfg({ recursive: true, exts: ["wav", "log"] }));
    expect(files.size).toBe(3);
  });
});

describe("diff", () => {
  test("返回 current 相对 prev 的新增", () => {
    const prev = new Set(["a", "b"]);
    const current = new Set(["b", "c"]);
    expect(diff(current, prev)).toEqual(new Set(["c"]));
  });
});

describe("state", () => {
  test("无文件时返回 null", async () => {
    expect(await loadState(path.join(dir, "no-such-state.json"))).toBeNull();
  });

  test("保存后可读回, 且损坏文件视为 null", async () => {
    const file = path.join(dir, "state.json");
    await saveState(file, new Set(["x", "a"]));
    expect(await loadState(file)).toEqual(new Set(["a", "x"]));

    writeFileSync(file, "{not json");
    expect(await loadState(file)).toBeNull();
  });

  test("stateFileFor 按目录+后缀+选项区分", () => {
    const a = stateFileFor(cfg());
    const b = stateFileFor(cfg({ recursive: true }));
    const c = stateFileFor(cfg({ exts: ["mp3"] }));
    expect(new Set([a, b, c]).size).toBe(3);
    expect(path.isAbsolute(a)).toBe(true);
    expect(a.endsWith(".json")).toBe(true);
  });

  test("显式 --state 直接使用", () => {
    expect(stateFileFor(cfg(), "/tmp/my.json")).toBe("/tmp/my.json");
  });
});
