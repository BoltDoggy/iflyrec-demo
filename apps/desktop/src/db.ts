/**
 * 状态存储 —— SQLite (Deno 原生 node:sqlite, 零第三方依赖)。
 * 取代原来的 JSON 文件(processed/uploads/results/hash-cache):
 * 事务(BEGIN IMMEDIATE)保证原子读改写, 单连接天然串行, WAL 支持跨进程。
 * 首次启动自动把旧 JSON 数据导入并改名 .bak 备份, 无损迁移。
 */
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./store.ts";

export type Stage = "queued" | "uploading" | "transcribing" | "summarizing" | "mindmapping";
export type ResultStatus = "processing" | "done" | "error";

export interface ProcessResult {
  id: string; // 内容指纹
  name: string;
  status: ResultStatus;
  stage?: Stage;
  error?: string;
  transcript?: {
    segments: { speaker: string; start: number; end: number; text: string }[];
    duration: number;
    fullText: string;
  };
  turns?: { speaker: string; start: number; end: number; text: string }[];
  summary?: string;
  mindmap?: string;
  /** 一句话简介(列表展示用) */
  brief?: string;
  /** provider 内部状态(如豆包的任务 id), 用于断点续跑时接续查询 */
  asrState?: Record<string, string>;
  meta?: {
    at?: string;
    asrMs?: number;
    llmMs?: number;
    duration?: number;
    asrProvider?: string;
    tos?: { objectKey: string };
  };
}

export interface UploadRec {
  bucket: string;
  objectKey: string;
  at: string;
}

const now = () => new Date().toISOString().slice(0, 19);

export class StateDb {
  #db: DatabaseSync;

  constructor(
    public readonly path: string,
    legacyDir: string = DATA_DIR,
  ) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    Deno.mkdirSync(dir, { recursive: true }); // 同步: 构造函数里不能等异步 mkdir
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA busy_timeout = 5000;");
    this.#db.exec(`CREATE TABLE IF NOT EXISTS processed (
      hash TEXT PRIMARY KEY, at TEXT NOT NULL, name TEXT NOT NULL)`);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS uploads (
      hash TEXT PRIMARY KEY, bucket TEXT NOT NULL, object_key TEXT NOT NULL, at TEXT NOT NULL)`);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS results (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, stage TEXT, error TEXT,
      uploaded INTEGER NOT NULL DEFAULT 0, brief TEXT, json TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    // 旧库补列(列已存在时忽略)
    try {
      this.#db.exec("ALTER TABLE results ADD COLUMN brief TEXT");
    } catch { /* column exists */ };
    this.#db.exec(`CREATE TABLE IF NOT EXISTS hash_cache (
      path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL, hash TEXT NOT NULL)`);
    this.#db.exec("CREATE INDEX IF NOT EXISTS idx_results_status ON results(status)");
    this.#migrateLegacy(legacyDir);
  }

  /** 原子读改写事务。 */
  #tx(fn: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  /* ---------- 旧 JSON 数据迁移: 导入后把源文件改名 .bak ---------- */

  #migrateLegacy(legacyDir: string): void {
    // processed.json / uploads.json / hash-cache.json
    for (const [file, import_] of [
      [`${legacyDir}/processed.json`, (m: Record<string, { at?: string; name?: string }>) => {
        const st = this.#db.prepare(
          "INSERT OR IGNORE INTO processed (hash, at, name) VALUES (?, ?, ?)",
        );
        for (const [h, v] of Object.entries(m)) st.run(h, v.at ?? "", v.name ?? "");
      }],
      [`${legacyDir}/uploads.json`, (m: Record<string, UploadRec>) => {
        const st = this.#db.prepare(
          "INSERT OR IGNORE INTO uploads (hash, bucket, object_key, at) VALUES (?, ?, ?, ?)",
        );
        for (const [h, v] of Object.entries(m)) {
          st.run(h, v.bucket ?? "", v.objectKey ?? "", v.at ?? "");
        }
      }],
      [
        `${legacyDir}/hash-cache.json`,
        (m: Record<string, { size?: number; mtime?: number; hash?: string }>) => {
          const st = this.#db.prepare(
            "INSERT OR IGNORE INTO hash_cache (path, size, mtime, hash) VALUES (?, ?, ?, ?)",
          );
          for (const [p, v] of Object.entries(m)) {
            st.run(p, v.size ?? 0, v.mtime ?? 0, v.hash ?? "");
          }
        },
      ],
    ] as const) {
      const data = readJsonSync(file);
      if (data && typeof data === "object") {
        this.#tx(() => import_(data as never));
        try {
          Deno.renameSync(file, `${file}.bak`);
          console.log(`[db] 已迁移 ${file} -> SQLite`);
        } catch { /* 重命名失败不影响, INSERT OR IGNORE 幂等 */ }
      }
    }
    // results/*.json
    try {
      for (const e of Deno.readDirSync(`${legacyDir}/results`)) {
        if (!e.isFile || !e.name.endsWith(".json")) continue;
        const r = readJsonSync(`${legacyDir}/results/${e.name}`) as ProcessResult | null;
        if (r?.id) this.saveResult(r);
      }
      Deno.renameSync(`${legacyDir}/results`, `${legacyDir}/results.bak`);
      console.log(`[db] 已迁移 ${legacyDir}/results -> SQLite`);
    } catch {
      // 目录不存在(全新安装)
    }
  }

  /* ---------- processed ---------- */

  markProcessed(hash: string, name: string): void {
    this.#tx(() => {
      this.#db.prepare(
        `INSERT INTO processed (hash, at, name) VALUES (?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET at = excluded.at, name = excluded.name`,
      ).run(hash, now(), name);
    });
  }

  getProcessed(): Map<string, { at: string; name: string }> {
    const out = new Map<string, { at: string; name: string }>();
    for (
      const row of this.#db.prepare("SELECT hash, at, name FROM processed").all() as {
        hash: string;
        at: string;
        name: string;
      }[]
    ) {
      out.set(row.hash, { at: row.at, name: row.name });
    }
    return out;
  }

  /* ---------- uploads ---------- */

  markUploaded(hash: string, rec: UploadRec): void {
    this.#tx(() => {
      this.#db.prepare(
        `INSERT INTO uploads (hash, bucket, object_key, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET bucket = excluded.bucket,
           object_key = excluded.object_key, at = excluded.at`,
      ).run(hash, rec.bucket, rec.objectKey, rec.at);
    });
  }

  getUploads(): Map<string, UploadRec> {
    const out = new Map<string, UploadRec>();
    for (
      const row of this.#db.prepare(
        "SELECT hash, bucket, object_key, at FROM uploads",
      ).all() as { hash: string; bucket: string; object_key: string; at: string }[]
    ) {
      out.set(row.hash, { bucket: row.bucket, objectKey: row.object_key, at: row.at });
    }
    return out;
  }

  /* ---------- results ---------- */

  saveResult(r: ProcessResult): void {
    this.#tx(() => {
      this.#db.prepare(
        `INSERT INTO results (id, name, status, stage, error, uploaded, brief, json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status,
           stage = excluded.stage, error = excluded.error, uploaded = excluded.uploaded,
           brief = excluded.brief, json = excluded.json, updated_at = excluded.updated_at`,
      ).run(
        r.id,
        r.name,
        r.status,
        r.stage ?? null,
        r.error ?? null,
        r.meta?.tos ? 1 : 0,
        r.brief ?? null,
        JSON.stringify(r),
        now(),
      );
    });
  }

  /** 所有已生成简介的条目: id -> 简介。 */
  getBriefs(): Map<string, string> {
    const out = new Map<string, string>();
    for (
      const row of this.#db.prepare(
        "SELECT id, brief FROM results WHERE brief IS NOT NULL",
      ).all() as { id: string; brief: string }[]
    ) {
      out.set(row.id, row.brief);
    }
    return out;
  }

  getResult(id: string): ProcessResult | null {
    const row = this.#db.prepare("SELECT json FROM results WHERE id = ?").get(id) as
      | { json: string }
      | undefined;
    return row ? JSON.parse(row.json) as ProcessResult : null;
  }

  allStatuses(): Record<string, {
    status: ResultStatus;
    stage?: Stage;
    error?: string;
    uploaded?: boolean;
  }> {
    const out: Record<string, {
      status: ResultStatus;
      stage?: Stage;
      error?: string;
      uploaded?: boolean;
    }> = {};
    for (
      const row of this.#db.prepare(
        "SELECT id, status, stage, error, uploaded FROM results",
      ).all() as {
        id: string;
        status: ResultStatus;
        stage: Stage | null;
        error: string | null;
        uploaded: number;
      }[]
    ) {
      out[row.id] = {
        status: row.status,
        stage: row.stage ?? undefined,
        error: row.error ?? undefined,
        uploaded: row.uploaded === 1,
      };
    }
    return out;
  }

  /** 服务启动时恢复: 残留 processing(上次进程中断)的任务标记为可重试的失败。 */
  recoverInterrupted(): number {
    let n = 0;
    for (
      const row of this.#db.prepare(
        "SELECT id FROM results WHERE status = 'processing'",
      ).all() as { id: string }[]
    ) {
      const r = this.getResult(row.id);
      if (!r) continue;
      r.status = "error";
      r.stage = undefined;
      r.error = "服务重启导致处理中断, 请重新勾选处理(已完成阶段不会重复计费)";
      this.saveResult(r);
      n++;
    }
    return n;
  }

  /* ---------- hash cache ---------- */

  getCachedHash(path: string): { size: number; mtime: number; hash: string } | null {
    const row = this.#db.prepare(
      "SELECT size, mtime, hash FROM hash_cache WHERE path = ?",
    ).get(path) as { size: number; mtime: number; hash: string } | undefined;
    return row ?? null;
  }

  putCachedHash(path: string, size: number, mtime: number, hash: string): void {
    this.#tx(() => {
      this.#db.prepare(
        `INSERT INTO hash_cache (path, size, mtime, hash) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime,
           hash = excluded.hash`,
      ).run(path, size, mtime, hash);
    });
  }

  /* ---------- 重置 ---------- */

  clearRegistry(): void {
    this.#db.exec("DELETE FROM hash_cache");
  }

  clearResults(): void {
    this.#db.exec("DELETE FROM results");
    this.#db.exec("DELETE FROM processed");
  }
}

/** 同步读 JSON(迁移在构造函数里执行, 不能 await), 失败返回 null。 */
function readJsonSync(file: string): unknown {
  try {
    return JSON.parse(Deno.readTextFileSync(file));
  } catch {
    return null;
  }
}

const DB_PATH = `${DATA_DIR}/state.db`;
let singleton: StateDb | null = null;

/** 进程级单例(懒加载, 避免测试引入副作用)。 */
export function getDb(): StateDb {
  return singleton ??= new StateDb(DB_PATH);
}
