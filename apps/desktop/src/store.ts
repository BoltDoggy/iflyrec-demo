/** 共享的持久化位置与 JSON 读写(原子写)。业务状态在 SQLite(src/db.ts), 这里只留 settings。 */
import { homedir } from "node:os";

export const HOME = homedir();
export const DATA_DIR = `${HOME}/.local/state/iflyrec-desktop`;
export const FILES = {
  settings: `${DATA_DIR}/settings.json`,
};
export const RESULTS_DIR = `${DATA_DIR}/results`;

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(file)) as T;
  } catch {
    return fallback;
  }
}

/* ---------- 状态文件的并发安全: 同一文件的写串行化, 读改写整体加锁 ---------- */

const fileLocks = new Map<string, Promise<unknown>>();

function lock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(file) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  fileLocks.set(file, next);
  return next;
}

async function writeLocked(file: string, data: unknown, dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(data, null, 1));
  await Deno.rename(tmp, file);
}

/** 原子写 JSON(先 .tmp 再 rename); 同一文件的并发写自动串行。 */
export function writeJson(file: string, data: unknown, dir = DATA_DIR): Promise<void> {
  return lock(file, () => writeLocked(file, data, dir));
}

/**
 * 原子读-改-写: 整个临界区持锁, 并发的更新不会互相覆盖或撞掉临时文件。
 * update 返回新值或直接原地修改 cur 均可。
 */
export function updateJson<T>(
  file: string,
  fallback: T,
  update: (cur: T) => T | void,
  dir = DATA_DIR,
): Promise<T> {
  return lock(file, async () => {
    const cur = await readJson(file, fallback);
    const ret = update(cur);
    const next = (ret ?? cur) as T;
    await writeLocked(file, next, dir);
    return next;
  });
}
