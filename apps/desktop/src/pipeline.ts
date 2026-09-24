/**
 * 处理管线: 上传(独立并发) -> 转写(带说话人分离) -> 纪要总结 -> 思维导图大纲。
 * 分阶段落盘(SQLite), 失败重试时复用已完成阶段, 不重复计费。
 */
import { type ProcessResult, getDb } from "./db.ts";
import { type AsrAdapter, type UploadedRef, mockAsr } from "./providers/asr.ts";
import { doubaoAdapter } from "./providers/doubao.ts";
import {
  BRIEF_SYSTEM,
  MINDMAP_SYSTEM,
  SUMMARY_SYSTEM,
  getBriefChat,
  getMindmapChat,
  getSummaryChat,
  transcriptToPromptText,
} from "./providers/llm.ts";
import { mergeSegments } from "./turns.ts";

export type { ProcessResult, ResultStatus, Stage } from "./db.ts";

export interface ApiConfig {
  asr: import("./providers/asr.ts").AsrConfig;
  llm: import("./providers/llm.ts").LlmConfig;
}

export interface PipelineEntry {
  id: string;
  path: string; // 主副本路径
  name: string;
}

export const MAX_PROC_CONCURRENT = 2; // 转写+LLM 是慢阶段, 限制 2
export const MAX_UPLOAD_CONCURRENT = 4; // 上传快且独立, 单独排队不占识别名额
const active = new Set<string>();

function getAsr(cfg: ApiConfig): AsrAdapter {
  return cfg.asr.provider === "doubao" ? doubaoAdapter : { transcribe: mockAsr };
}

/* ---------- 并发限制: 上传与识别各自独立的水位 ---------- */

function makeSlot(max: number) {
  let activeCount = 0;
  const waiting: Array<() => void> = [];
  return async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (activeCount >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    activeCount++;
    try {
      return await fn();
    } finally {
      activeCount--;
      waiting.shift()?.();
    }
  };
}

const withProcSlot = makeSlot(MAX_PROC_CONCURRENT);
const withUploadSlot = makeSlot(MAX_UPLOAD_CONCURRENT);

async function run(entry: PipelineEntry, cfg: ApiConfig): Promise<void> {
  const db = getDb();
  const r: ProcessResult = db.getResult(entry.id) ?? {
    id: entry.id,
    name: entry.name,
    status: "processing",
  };
  r.id = entry.id;
  r.name = entry.name;
  r.status = "processing";
  r.error = undefined;
  const adapter = getAsr(cfg);

  // ---- 上传阶段: 独立队列(并发 4), 不占识别名额; 每个文件上传完即可排识别 ----
  let uploaded: UploadedRef | null = null;
  if (!r.transcript?.segments?.length && adapter.upload) {
    try {
      r.stage = "queued"; // 等待上传坑位
      db.saveResult(r);
      uploaded = await withUploadSlot(() => {
        r.stage = "uploading"; // 真正开始上传
        db.saveResult(r);
        return adapter.upload!(entry.path, cfg.asr, { hash: entry.id });
      });
      if (uploaded) r.meta = { ...r.meta, tos: { objectKey: uploaded.objectKey } };
    } catch (err) {
      r.status = "error";
      r.stage = undefined;
      r.error = err instanceof Error ? err.message : String(err);
      db.saveResult(r);
      console.error(`[pipeline] 上传失败 ${entry.name}:`, r.error);
      return;
    }
  }

  // ---- 识别 + 总结 + 导图: 慢阶段队列(并发 2) ----
  r.stage = "queued"; // 等待识别坑位
  db.saveResult(r);
  await withProcSlot(async () => {
    try {
      // 断点续跑: 已有转写结果则跳过 ASR (不重复计费)
      if (!r.transcript?.segments?.length) {
        r.stage = "transcribing";
        db.saveResult(r);
        const t0 = Date.now();
        r.transcript = await adapter.transcribe(
          entry.path,
          cfg.asr,
          {
            hash: entry.id,
            // 上次运行遗留的任务 id(如豆包): 优先接续查询, 不重复提交
            resume: r.asrState,
            // provider 途中上报状态(任务 id) -> 持久化到结果
            saveState: (state: Record<string, string>) => {
              r.asrState = Object.keys(state).length ? { ...state } : undefined;
              db.saveResult(r);
            },
          },
          uploaded ?? undefined,
        );
        r.meta = {
          ...r.meta,
          asrMs: Date.now() - t0,
          asrProvider: cfg.asr.provider,
          duration: r.transcript.duration,
        };
        r.turns = mergeSegments(r.transcript.segments);
        db.saveResult(r);
      } else if (!r.turns?.length) {
        r.turns = mergeSegments(r.transcript.segments);
      }

      const promptText = transcriptToPromptText(r.turns!);

      // 一句话简介(列表展示); 已有文稿的旧结果重跑时只补这一步
      if (!r.brief) {
        r.stage = "summarizing";
        db.saveResult(r);
        const t0 = Date.now();
        r.brief = (await getBriefChat(cfg.llm)(BRIEF_SYSTEM, promptText)).trim();
        r.meta = { ...r.meta, llmMs: (r.meta?.llmMs ?? 0) + (Date.now() - t0) };
        db.saveResult(r);
      }

      if (!r.summary) {
        r.stage = "summarizing";
        db.saveResult(r);
        const t0 = Date.now();
        r.summary = await getSummaryChat(cfg.llm)(SUMMARY_SYSTEM, promptText);
        r.meta = { ...r.meta, llmMs: (r.meta?.llmMs ?? 0) + (Date.now() - t0) };
        db.saveResult(r);
      }

      if (!r.mindmap) {
        r.stage = "mindmapping";
        db.saveResult(r);
        const t0 = Date.now();
        r.mindmap = await getMindmapChat(cfg.llm)(MINDMAP_SYSTEM, promptText);
        r.meta = { ...r.meta, llmMs: (r.meta?.llmMs ?? 0) + (Date.now() - t0) };
      }

      r.status = "done";
      r.stage = undefined;
      r.meta = { ...r.meta, at: new Date().toISOString().slice(0, 19) };
      db.saveResult(r);
      db.markProcessed(entry.id, entry.name);
      console.log(
        `[pipeline] 完成 ${entry.name} (ASR ${r.meta.asrMs}ms, LLM ${r.meta.llmMs}ms)`,
      );
    } catch (err) {
      r.status = "error";
      r.stage = undefined;
      r.error = err instanceof Error ? err.message : String(err);
      db.saveResult(r);
      console.error(`[pipeline] 失败 ${entry.name}:`, r.error);
    }
  });
}

/** 入队处理(异步执行, 不等待完成); 返回本次新入队的数量。 */
export function enqueue(entries: PipelineEntry[], cfg: ApiConfig): number {
  let queued = 0;
  for (const entry of entries) {
    if (active.has(entry.id)) continue;
    active.add(entry.id);
    queued++;
    run(entry, cfg).finally(() => active.delete(entry.id));
  }
  return queued;
}

export function getResult(id: string): Promise<ProcessResult | null> {
  if (!/^[0-9a-f]{6,64}$/.test(id)) return Promise.resolve(null);
  return Promise.resolve(getDb().getResult(id));
}

export function allStatuses() {
  return Promise.resolve(getDb().allStatuses());
}

export function recoverInterrupted(): Promise<number> {
  return Promise.resolve(getDb().recoverInterrupted());
}

export const activeIds = (): string[] => [...active];
