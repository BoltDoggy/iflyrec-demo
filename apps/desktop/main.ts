/**
 * iflyrec 文件处理台 — Deno 本地服务 + 网页 UI 的桌面应用。
 *
 * 功能: 配置文件夹列表与后缀 -> 扫描(递归) -> 按内容指纹去重 -> 列表展示
 *       -> 多选"处理"(当前为 mock) -> 已处理标记持久化。
 *
 * 处理逻辑目前是 mock, 只集中在 processFiles() 一处, 接真实需求时替换它即可。
 *
 * 运行: deno task start   (--no-open 不自动开窗口, PORT=xxx 自定义端口)
 */
const PORT = Number(Deno.env.get("PORT") ?? 17654);
const NO_OPEN = Deno.args.includes("--no-open");
const ROOT = import.meta.dirname ?? ".";
const PUBLIC = `${ROOT}/public`;

const HOME = Deno.env.get("HOME") ?? ".";
const DATA_DIR = `${HOME}/.local/state/iflyrec-desktop`;
const FILES = {
  settings: `${DATA_DIR}/settings.json`,
  processed: `${DATA_DIR}/processed.json`,
  cache: `${DATA_DIR}/hash-cache.json`,
};

interface Settings {
  folders: string[];
  exts: string[];
}
interface ProcessedRecord {
  at: string;
  name: string;
}
interface CacheEntry {
  size: number;
  mtime: number;
  hash: string;
}
interface CopyInfo {
  path: string;
  folder: string;
}
interface Entry {
  id: string; // 内容指纹; 同内容多副本共用一个 id, 天然去重
  name: string;
  size: number;
  mtime: number;
  copies: CopyInfo[];
  processed: boolean;
  processedAt: string | null;
}
interface SkippedFolder {
  path: string;
  reason: "not_found" | "no_perm";
}

const DEFAULT_SETTINGS: Settings = { folders: [], exts: ["wav", "mp3", "txt"] };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const joinPath = (dir: string, name: string) =>
  dir.endsWith("/") ? dir + name : `${dir}/${name}`;
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * 输入容错: 还原从终端复制来的路径 —— 去掉引号包裹与空格转义。
 * 如 "/Volumes/NO NAME" 或 /Volumes/NO\ NAME 都会还原成 /Volumes/NO NAME。
 */
function cleanPath(raw: string): string {
  let p = raw.trim();
  if (
    p.length > 1 &&
    ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))
  ) {
    p = p.slice(1, -1);
  }
  return p.replace(/\\(.)/g, "$1").replace(/\/+$/, "") || "/";
}

// ---------- 持久化 ----------

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(file)) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await Deno.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(data, null, 1));
  await Deno.rename(tmp, file);
}

function normalizeExts(raw: string[]): string[] {
  return [
    ...new Set(
      raw
        .join(",")
        .split(",")
        .map((s) => s.trim().replace(/^\.+/, "").toLowerCase())
        .filter(Boolean),
    ),
  ];
}

// ---------- 扫描 + 内容去重 ----------

async function* walk(dir: string): AsyncGenerator<string> {
  try {
    // readDir 是惰性迭代, 目录不存在/无权限的错误在迭代时才抛出, 必须包住循环
    for await (const e of Deno.readDir(dir)) {
      if (e.name.startsWith(".") || e.isSymlink) continue; // 跳过 .DS_Store/.git 等
      const p = joinPath(dir, e.name);
      if (e.isDirectory) yield* walk(p);
      else if (e.isFile) yield p;
    }
  } catch {
    return; // 读不到的目录直接跳过, 上层用 skipped 提示
  }
}

async function sha256(file: string): Promise<string | null> {
  try {
    const buf = await Deno.readFile(file);
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

const folderOf = (p: string, folders: string[]) =>
  folders.find((f) => p === f || p.startsWith(f.endsWith("/") ? f : f + "/")) ?? "";

/** 扫描所有目录, 按内容指纹分组去重; 返回列表条目和无法读取的目录(含原因)。 */
async function scanAll(settings: Settings): Promise<{ entries: Entry[]; skipped: SkippedFolder[] }> {
  const { folders, exts } = settings;
  const norm = exts.map((e) => e.toLowerCase());

  // 1. 收集匹配后缀的文件路径 (目录列表可能有嵌套包含, 先按路径去重)
  const paths = new Set<string>();
  const skipped: SkippedFolder[] = [];
  for (const folder of folders) {
    try {
      const st = await Deno.stat(folder);
      if (!st.isDirectory) {
        skipped.push({ path: folder, reason: "not_found" });
        continue;
      }
    } catch (e) {
      skipped.push({
        path: folder,
        reason: e instanceof Deno.errors.PermissionDenied ? "no_perm" : "not_found",
      });
      continue;
    }
    // stat 不需要读权限; chmod 000 的目录 stat 正常但 readDir 失败, 探测一次可读性
    try {
      for await (const _ of Deno.readDir(folder)) break;
    } catch {
      skipped.push({ path: folder, reason: "no_perm" });
      continue;
    }
    for await (const p of walk(folder)) {
      const name = basename(p).toLowerCase();
      if (norm.some((e) => name.endsWith("." + e))) paths.add(p);
    }
  }

  // 2. 指纹(带 size+mtime 缓存) -> 按内容分组, 多副本合一
  const cache = await readJson<Record<string, CacheEntry>>(FILES.cache, {});
  const groups = new Map<
    string,
    { size: number; mtime: number; copies: CopyInfo[] }
  >();
  for (const p of paths) {
    let st;
    try {
      st = await Deno.stat(p);
    } catch {
      continue;
    }
    const c = cache[p];
    let hash: string | undefined;
    const mtime = st.mtime?.getTime() ?? 0;
    if (c && c.size === st.size && c.mtime === mtime) {
      hash = c.hash;
    } else {
      const h = await sha256(p);
      if (h === null) continue;
      hash = h;
      cache[p] = { size: st.size, mtime, hash: h };
    }
    const g = groups.get(hash) ?? {
      size: st.size,
      mtime,
      copies: [] as CopyInfo[],
    };
    g.copies.push({ path: p, folder: folderOf(p, folders) });
    groups.set(hash, g);
  }
  await writeJson(FILES.cache, cache);

  const processed = await readJson<Record<string, ProcessedRecord>>(FILES.processed, {});
  const entries: Entry[] = [...groups.entries()].map(([hash, g]) => {
    const copies = g.copies.sort((a, b) => a.path.localeCompare(b.path));
    return {
      id: hash,
      name: basename(copies[0].path),
      size: g.size,
      mtime: g.mtime,
      copies,
      processed: hash in processed,
      processedAt: processed[hash]?.at ?? null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { entries, skipped };
}

// ---------- mock 处理 ----------

/**
 * MOCK: 模拟处理耗时后, 把内容指纹写入已处理表。
 * 真实需求落地时, 只需要替换这个函数的内部实现。
 */
async function processFiles(ids: string[]): Promise<number> {
  const settings = await readJson<Settings>(FILES.settings, DEFAULT_SETTINGS);
  const { entries } = await scanAll(settings);
  const nameOf = new Map(entries.map((e) => [e.id, e.name]));
  const processed = await readJson<Record<string, ProcessedRecord>>(FILES.processed, {});
  await Promise.all(
    ids.map(async (id) => {
      await delay(250 + Math.random() * 250); // mock 耗时
      processed[id] = {
        at: new Date().toISOString().slice(0, 19),
        name: nameOf.get(id) ?? "",
      };
      console.log(`[mock] 已处理: ${nameOf.get(id) ?? id}`);
    }),
  );
  await writeJson(FILES.processed, processed);
  return ids.length;
}

// ---------- HTTP ----------

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function staticFile(name: string): Promise<Response> {
  try {
    const body = await Deno.readTextFile(`${PUBLIC}/${name}`);
    return new Response(body, {
      headers: { "Content-Type": MIME[name.slice(name.lastIndexOf("."))] },
    });
  } catch {
    return json({ error: "not found" }, 404);
  }
}

async function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);

  if (req.method === "GET") {
    if (pathname === "/" || pathname === "/index.html") return staticFile("index.html");
    if (pathname === "/app.js") return staticFile("app.js");
    if (pathname === "/style.css") return staticFile("style.css");
  }

  if (pathname === "/api/settings") {
    if (req.method === "GET") {
      return json(await readJson(FILES.settings, DEFAULT_SETTINGS));
    }
    if (req.method === "PUT") {
      const body = await req.json().catch(() => null) as Settings | null;
      if (!body || !Array.isArray(body.folders) || !Array.isArray(body.exts)) {
        return json({ error: "参数不合法, 需要 folders 与 exts 数组" }, 400);
      }
      const settings: Settings = {
        folders: [...new Set(body.folders.map((f) => cleanPath(String(f))).filter(Boolean))],
        exts: normalizeExts(body.exts.map(String)),
      };
      await writeJson(FILES.settings, settings);
      return json(settings);
    }
  }

  if (pathname === "/api/scan" && req.method === "POST") {
    const settings = await readJson<Settings>(FILES.settings, DEFAULT_SETTINGS);
    return json(await scanAll(settings));
  }

  if (pathname === "/api/process" && req.method === "POST") {
    const body = await req.json().catch(() => null) as { ids?: unknown } | null;
    const ids = [...new Set(((body?.ids as unknown[] | undefined) ?? []).map(String))];
    if (ids.length === 0) return json({ error: "没有选择文件" }, 400);
    const n = await processFiles(ids);
    return json({ processed: n });
  }

  return json({ error: "not found" }, 404);
}

// ---------- 启动 ----------

async function openWindow(url: string): Promise<void> {
  // 优先用 Chrome 的 app 模式开独立无标签窗口(更像桌面应用), 失败退回默认浏览器
  const cmds: string[][] = [
    ["open", "-na", "Google Chrome", "--args", `--app=${url}`],
    ["open", url],
  ];
  for (const [bin, ...args] of cmds) {
    try {
      const r = await new Deno.Command(bin, { args }).output();
      if (r.success) return;
    } catch {
      // 试下一种
    }
  }
}

Deno.serve({ port: PORT }, handle);
const url = `http://localhost:${PORT}`;
console.log(`文件处理台已启动: ${url}`);
console.log(`数据目录: ${DATA_DIR} (settings/processed/hash-cache)`);
if (!NO_OPEN) await openWindow(url);
