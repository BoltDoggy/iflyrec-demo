/**
 * 内容指纹注册表 —— 跨目录/跨时间识别"相同的文件"(内容一致)。
 * 注册表全局共享一份 (~/.local/state/detect-new-files/registry.json),
 * 所有 目录/后缀 组合共用; 记录见过的 内容指纹 -> 路径, 不随 --reset 基线一起清除。
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "./io";

export interface RegistryEntry {
  size: number;
  mtime: number;
  hash: string;
  firstSeen: string;
}

export interface Registry {
  /** 绝对路径 -> 条目 */
  entries: Record<string, RegistryEntry>;
}

export function registryFile(): string {
  return path.join(homedir(), ".local/state/detect-new-files", "registry.json");
}

export async function loadRegistry(file: string): Promise<Registry> {
  const f = Bun.file(file);
  if (!(await f.exists())) return { entries: {} };
  try {
    const data = (await f.json()) as Partial<Registry>;
    if (data && typeof data.entries === "object" && data.entries !== null) {
      return { entries: data.entries };
    }
  } catch {
    // 损坏的注册表视为空, 重建
  }
  return { entries: {} };
}

export async function saveRegistry(file: string, reg: Registry): Promise<void> {
  await writeJsonAtomic(file, { version: 1, entries: reg.entries });
}

export async function hashFile(file: string): Promise<string | null> {
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(await Bun.file(file).arrayBuffer()); // 整文件读入; 超大文件可改分块
    return hasher.digest("hex");
  } catch {
    return null; // 不可读的文件按"未知内容"处理, 不影响其余流程
  }
}

/** 为文件集合补齐指纹; size+mtime 未变的复用缓存, 不重算。 */
export async function ensureHashed(files: Set<string>, reg: Registry): Promise<void> {
  for (const file of files) {
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    const cached = reg.entries[file];
    if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) continue;
    const hash = await hashFile(file);
    if (hash === null) continue;
    reg.entries[file] = {
      size: st.size,
      mtime: st.mtimeMs,
      hash,
      firstSeen: cached?.firstSeen ?? new Date().toISOString().slice(0, 19),
    };
  }
}

/** hash -> 最早出现(firstSeen 最小)的路径, 用于给出"同哪个文件"。 */
export function buildHashIndex(reg: Registry): Map<string, string> {
  const earliest = new Map<string, { p: string; seen: string }>();
  for (const [p, e] of Object.entries(reg.entries)) {
    const cur = earliest.get(e.hash);
    if (!cur || e.firstSeen < cur.seen) earliest.set(e.hash, { p, seen: e.firstSeen });
  }
  const idx = new Map<string, string>();
  for (const [h, { p }] of earliest) idx.set(h, p);
  return idx;
}

/**
 * 标记 news 中"内容已知"的文件, 返回 file -> 同内容的已知文件:
 * - 指纹在本次运行前就见过 (known) -> 指向最早出现的路径
 * - 与同批次中更早出现的文件内容相同 -> 指向该文件
 */
export function classifyDups(
  news: Iterable<string>,
  reg: Registry,
  known: Map<string, string>,
): Map<string, string> {
  const dups = new Map<string, string>();
  const inRun = new Map<string, string>();
  for (const file of [...news].sort()) {
    const entry = reg.entries[file];
    if (!entry) continue;
    const knownPath = known.get(entry.hash);
    if (knownPath && knownPath !== file) {
      dups.set(file, knownPath);
    } else if (inRun.has(entry.hash)) {
      dups.set(file, inRun.get(entry.hash)!);
    } else {
      inRun.set(entry.hash, file);
    }
  }
  return dups;
}
