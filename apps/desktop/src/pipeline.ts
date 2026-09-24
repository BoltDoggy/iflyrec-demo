/**
 * 处理管线: 转写 -> 纪要总结 -> 思维导图大纲。
 * 分阶段落盘(results/{指纹}.json), 失败重试时复用已完成阶段, 不重复计费。
 */
import { FILES, RESULTS_DIR, readJson, writeJson } from "./store.ts";
import { type AsrConfig, type Transcript, mockAsr } from "./providers/asr.ts";
import { doubaoAsr } from "./providers/doubao.ts";
import {
  type LlmConfig,
  MINDMAP_SYSTEM,
  SUMMARY_SYSTEM,
  getMindmapChat,
  getSummaryChat,
  transcriptToPromptText,
} from "./providers/llm.ts";
import { type Turn, mergeSegments } from "./turns.ts";

export type Stage = "transcribing" | "summarizing" | "mindmapping";
export type ResultStatus = "processing" | "done" | "error";

export interface ProcessResult {
  id: string; // 内容指纹
  name: string;
  status: ResultStatus;
  stage?: Stage;
  error?: string;
  transcript?: Transcript;
  turns?: Turn[];
  summary?: string;
  mindmap?: string;
  meta?: {
    at?: string;
    asrMs?: number;
    llmMs?: number;
    duration?: number;
    asrProvider?: string;
  };
}

export interface ApiConfig {
  asr: AsrConfig;
  llm: LlmConfig;
}

export interface PipelineEntry {
  id: string;
  path: string; // 主副本路径
  name: string;
}

export const MAX_CONCURRENT = 2;
const resultFile = (id: string) => `${RESULTS_DIR}/${id}.json`;
const active = new Set<string>();

function getAsr(cfg: ApiConfig) {
  return cfg.asr.provider === "doubao" ? doubaoAsr : mockAsr;
}

/* ---------- 简单并发限制 (同时最多 MAX_CONCURRENT 个文件) ---------- */

let activeCount = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeCount >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  activeCount++;
  try {
    return await fn();
  } finally {
    activeCount--;
    waiting.shift()?.();
  }
}

/* ---------- 主流程 ---------- */

async function markProcessed(id: string, name: string): Promise<void> {
  const processed = await readJson<
    Record<string, { at: string; name: string }>
  >(FILES.processed, {});
  processed[id] = { at: new Date().toISOString().slice(0, 19), name };
  await writeJson(FILES.processed, processed);
}

async function run(entry: PipelineEntry, cfg: ApiConfig): Promise<void> {
  await withSlot(async () => {
    const file = resultFile(entry.id);
    const r: ProcessResult = await readJson(file, {
      id: entry.id,
      name: entry.name,
      status: "processing",
    });
    r.id = entry.id;
    r.name = entry.name;
    r.status = "processing";
    r.error = undefined;

    try {
      // 断点续跑: 已有转写结果则跳过 ASR (不重复计费)
      if (!r.transcript?.segments?.length) {
        r.stage = "transcribing";
        await writeJson(file, r, RESULTS_DIR);
        const t0 = Date.now();
        r.transcript = await getAsr(cfg)(entry.path, cfg.asr, { hash: entry.id });
        r.meta = {
          ...r.meta,
          asrMs: Date.now() - t0,
          asrProvider: cfg.asr.provider,
          duration: r.transcript.duration,
        };
        r.turns = mergeSegments(r.transcript.segments);
        await writeJson(file, r, RESULTS_DIR);
      } else if (!r.turns?.length) {
        r.turns = mergeSegments(r.transcript.segments);
      }

      const promptText = transcriptToPromptText(r.turns!);

      if (!r.summary) {
        r.stage = "summarizing";
        await writeJson(file, r, RESULTS_DIR);
        const t0 = Date.now();
        r.summary = await getSummaryChat(cfg.llm)(SUMMARY_SYSTEM, promptText);
        r.meta = { ...r.meta, llmMs: (r.meta?.llmMs ?? 0) + (Date.now() - t0) };
        await writeJson(file, r, RESULTS_DIR);
      }

      if (!r.mindmap) {
        r.stage = "mindmapping";
        await writeJson(file, r, RESULTS_DIR);
        const t0 = Date.now();
        r.mindmap = await getMindmapChat(cfg.llm)(MINDMAP_SYSTEM, promptText);
        r.meta = { ...r.meta, llmMs: (r.meta?.llmMs ?? 0) + (Date.now() - t0) };
      }

      r.status = "done";
      r.stage = undefined;
      r.meta = { ...r.meta, at: new Date().toISOString().slice(0, 19) };
      await writeJson(file, r, RESULTS_DIR);
      await markProcessed(entry.id, entry.name);
      console.log(
        `[pipeline] 完成 ${entry.name} (ASR ${r.meta.asrMs}ms, LLM ${r.meta.llmMs}ms)`,
      );
    } catch (err) {
      r.status = "error";
      r.stage = undefined;
      r.error = err instanceof Error ? err.message : String(err);
      await writeJson(file, r, RESULTS_DIR);
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

export async function getResult(id: string): Promise<ProcessResult | null> {
  if (!/^[0-9a-f]{6,64}$/.test(id)) return null;
  const r = await readJson<ProcessResult | null>(resultFile(id), null);
  return r;
}

/** 所有结果的状态摘要, 供前端轮询。 */
export async function allStatuses(): Promise<
  Record<string, { status: ResultStatus; stage?: Stage; error?: string }>
> {
  const out: Record<string, { status: ResultStatus; stage?: Stage; error?: string }> = {};
  try {
    for await (const e of Deno.readDir(RESULTS_DIR)) {
      if (!e.isFile || !e.name.endsWith(".json")) continue;
      const r = await readJson<ProcessResult | null>(`${RESULTS_DIR}/${e.name}`, null);
      if (r?.id) out[r.id] = { status: r.status, stage: r.stage, error: r.error };
    }
  } catch {
    // 目录不存在时返回空
  }
  return out;
}

export const activeIds = (): string[] => [...active];
