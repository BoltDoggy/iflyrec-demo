import { mkdir, rename } from "node:fs/promises";
import path from "node:path";

/** 原子写 JSON: 先写 .tmp 再 rename, 避免中途打断产生损坏文件。 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await Bun.write(tmp, JSON.stringify(data, null, 1));
  await rename(tmp, file);
}
