/**
 * @iflyrec/detect-core — 新增文件检测的核心逻辑: 扫描、快照状态、比对、内容指纹。
 */
import { homedir } from "node:os";
import path from "node:path";
import { Glob } from "bun";
import { writeJsonAtomic } from "./io";

export * from "./content";

export const EXIT_OK = 0; // 无新增
export const EXIT_NEW = 10; // 有新增文件
export const EXIT_ERR = 2; // 出错

export interface WatchConfig {
  /** 绝对路径 */
  directory: string;
  /** 规范化后的后缀 (无前导点; ignoreCase 时已小写) */
  exts: string[];
  recursive: boolean;
  ignoreCase: boolean;
}

/** 扫描目录下所有匹配后缀的文件, 返回绝对路径集合。 */
export function scan(cfg: WatchConfig): Set<string> {
  const glob = new Glob(cfg.recursive ? "**/*" : "*");
  const entries = glob.scanSync({
    cwd: cfg.directory,
    dot: true,
    onlyFiles: true,
    absolute: true,
  });
  const files = new Set<string>();
  for (const file of entries) {
    const name = path.basename(file);
    const cmp = cfg.ignoreCase ? name.toLowerCase() : name;
    if (cfg.exts.some((ext) => cmp.endsWith("." + ext))) {
      files.add(file);
    }
  }
  return files;
}

/** current 中不在 prev 里的文件。 */
export function diff(current: Set<string>, prev: Set<string>): Set<string> {
  return new Set([...current].filter((f) => !prev.has(f)));
}

/** 状态文件路径: 显式指定则直接用; 否则按 目录+后缀+选项 哈希生成, 多组监控互不干扰。 */
export function stateFileFor(cfg: WatchConfig, stateArg?: string): string {
  if (stateArg) return stateArg;
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    `${cfg.directory}|${[...cfg.exts].sort().join(",")}|r=${cfg.recursive}|ic=${cfg.ignoreCase}`,
  );
  const key = hasher.digest("hex").slice(0, 16);
  return path.join(homedir(), ".local/state/detect-new-files", `${key}.json`);
}

/** 读取上次快照; 无状态文件或损坏时返回 null, 视为首次运行。 */
export async function loadState(file: string): Promise<Set<string> | null> {
  const f = Bun.file(file);
  if (!(await f.exists())) return null;
  try {
    const data = (await f.json()) as Partial<{ files: string[] }>;
    if (!Array.isArray(data.files)) return null;
    return new Set(data.files);
  } catch {
    return null; // 损坏的状态文件视为首次运行
  }
}

/** 原子写入快照。只保留传入的文件集合 —— 已删除的文件移出基线, 删除后重建的同名文件会再次视为新增。 */
export async function saveState(file: string, files: Set<string>): Promise<void> {
  await writeJsonAtomic(file, {
    files: [...files].sort(),
    updated: new Date().toISOString().slice(0, 19),
  });
}
