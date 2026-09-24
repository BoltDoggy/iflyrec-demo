/** 共享的持久化位置与 JSON 读写(原子写)。 */
import { homedir } from "node:os";

export const HOME = homedir();
export const DATA_DIR = `${HOME}/.local/state/iflyrec-desktop`;
export const FILES = {
  settings: `${DATA_DIR}/settings.json`,
  processed: `${DATA_DIR}/processed.json`,
  cache: `${DATA_DIR}/hash-cache.json`,
};
export const RESULTS_DIR = `${DATA_DIR}/results`;

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(file)) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(file: string, data: unknown, dir = DATA_DIR): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(data, null, 1));
  await Deno.rename(tmp, file);
}
