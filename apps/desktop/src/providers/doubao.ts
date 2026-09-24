/**
 * 豆包(火山引擎)录音文件识别 adapter。
 *
 * - 极速版 (默认): POST /api/v3/auc/bigmodel/recognize/flash —— 同步接口,
 *   一次请求直接返回识别结果; 音频支持 audio.data base64 直传(本地文件上传),
 *   文件 ≤100MB / 时长 ≤2h, 格式 wav/mp3/ogg; resource id: volc.bigasr.auc_turbo。
 * - 标准版: submit/query 异步轮询, 仅支持 audio.url —— 本地文件先上传 TOS
 *   取预签名 URL 再提交(见 tos.ts); 说话人分离参数最全, 支持 >2h 长音频。
 *
 * 说话人分离: request.enable_speaker_info + show_utterances, 结果在
 * result.utterances[].additions.speaker; 解析不到时降级为单说话人 "1"。
 *
 * 文档: docs.volcengine.com/docs/DoubaoVoice (录音文件识别标准版 / 极速版识别)
 */
import type {
  AsrAdapter,
  AsrConfig,
  AsrFileMeta,
  AsrProvider,
  Segment,
  Transcript,
  UploadedRef,
} from "./asr.ts";
import { tosConfigError, tosConfigured, uploadForUrl } from "./tos.ts";
import { fixWavFile } from "../wav.ts";

const HOST = "https://openspeech.bytedance.com";
const POLL_INTERVAL = 2000;

export class DoubaoError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = "DoubaoError";
  }
}

const uuid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 分块 base64, 避免大文件 String.fromCharCode 栈溢出。 */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** 各版本支持的格式不同, 分开映射。 */
const FLASH_FORMATS: Record<string, string> = {
  ".wav": "wav",
  ".mp3": "mp3",
  ".ogg": "ogg",
  ".opus": "ogg",
};
const STANDARD_FORMATS: Record<string, string> = {
  ".wav": "wav",
  ".mp3": "mp3",
  ".m4a": "m4a",
  ".aac": "aac",
  ".ogg": "ogg",
  ".opus": "ogg",
  ".amr": "amr",
  ".spx": "spx",
};

function audioFormat(file: string, flash: boolean): string {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  const table = flash ? FLASH_FORMATS : STANDARD_FORMATS;
  const fmt = table[ext];
  if (!fmt) {
    const supported = Object.keys(table).join("/");
    throw new DoubaoError(
      `${flash ? "极速版" : "标准版"}不支持 ${ext} (支持 ${supported})`,
    );
  }
  return fmt;
}

/** 查询状态码分类: done=识别完成, pending=继续轮询, 其他=失败。 */
export function classifyStatus(code: string): "done" | "pending" | "error" {
  if (code === "20000000") return "done";
  if (code === "20000001" || code === "20000002") return "pending"; // 处理中/排队中
  return "error";
}

async function post(
  path: string,
  body: unknown,
  apiKey: string,
  resourceId: string,
  requestId: string,
  timeoutMs = 60_000,
): Promise<Response> {
  const res = await fetch(`${HOST}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": requestId,
      "X-Api-Sequence": "-1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // 403/4xx 时服务端把原因放在响应体或 X-Api-Message 里, 必须带出来
    const text = await res.text().catch(() => "");
    const msg = res.headers.get("X-Api-Message");
    const logid = res.headers.get("X-Tt-Logid") ?? "";
    throw new DoubaoError(
      `HTTP ${res.status} (${path})${msg ? `: ${msg}` : ""}${
        text ? ` | ${text.slice(0, 150)}` : ""
      }${logid ? ` logid=${logid}` : ""}`,
    );
  }
  return res;
}

function apiMessage(body: Record<string, unknown>): string {
  const m = body["X-Api-Message"] ?? body.message;
  return typeof m === "string" ? m : "请求失败";
}

/** 业务状态码 -> 可操作的中文提示。 */
function friendlyStatus(code: string): string {
  if (code === "20000003") return "音频中没有检测到人声 (静音或损坏的录音, 可尝试换一个文件)";
  if (code === "45000030") return "API Key 未授权该资源, 请到豆包语音控制台开通并授权";
  if (code === "45000151") return "音频格式不正确";
  return "";
}

/** 解析识别响应 -> Transcript (极速版响应体与标准版查询响应同构)。导出以便单测。 */
export function parseQueryResponse(body: {
  result?: {
    text?: string;
    utterances?: {
      text?: string;
      start_time?: number;
      end_time?: number;
      additions?: { speaker?: string };
    }[];
  };
  audio_info?: { duration?: number };
}): Transcript {
  const utterances = body.result?.utterances ?? [];
  const segments: Segment[] = utterances
    .filter((u) => (u.text ?? "").trim().length > 0)
    .map((u) => ({
      speaker: u.additions?.speaker?.trim() || "1", // 无说话人信息时降级为单说话人
      start: u.start_time ?? 0,
      end: u.end_time ?? 0,
      text: (u.text ?? "").trim(),
    }));
  return {
    segments,
    duration: body.audio_info?.duration ?? 0,
    fullText: body.result?.text ?? segments.map((s) => s.text).join(""),
  };
}

/** 极速版: 同步识别, 本地文件 base64 直传。 */
async function recognizeFlash(file: string, cfg: AsrConfig): Promise<Transcript> {
  const data = toBase64(await Deno.readFile(file));
  const res = await post(
    "/api/v3/auc/bigmodel/recognize/flash",
    {
      user: { uid: "iflyrec-demo" },
      audio: { format: audioFormat(file, true), data },
      request: {
        model_name: "bigmodel",
        enable_itn: true,
        enable_punc: true,
        enable_speaker_info: true, // 说话人分离
        show_utterances: true, // 返回分句(含说话人)
      },
    },
    cfg.apiKey,
    cfg.resourceId,
    uuid(),
    2 * 60 * 60 * 1000, // 同步识别长音频可能要很久, 与极速版时长上限(2h)对齐
  );
  const body = await res.json() as Record<string, unknown>;
  const code = res.headers.get("X-Api-Status-Code") ?? "";
  if (code !== "20000000") {
    const logid = res.headers.get("X-Tt-Logid") ?? "";
    throw new DoubaoError(
      `${apiMessage(body)} (${code})${logid ? ` logid=${logid}` : ""}`,
      code,
    );
  }
  return parseQueryResponse(body);
}

/** 标准版上传阶段: 上传 TOS 取预签名 URL。极速版/mock 返回 null(无需上传)。 */
export const doubaoUpload: NonNullable<AsrAdapter["upload"]> = async (file, cfg, meta) => {
  if (cfg.edition !== "standard" || !cfg.apiKey) return null;
  if (!tosConfigured(cfg.tos)) return null; // 配置缺失的报错留给转写阶段, 信息更完整
  const fixed = await fixWavFile(file);
  try {
    const ext = fixed.slice(fixed.lastIndexOf(".")).toLowerCase();
    const key = `${meta?.hash ?? fixed.slice(fixed.lastIndexOf("/") + 1).replace(/\.\w+$/, "")}${ext}`;
    return await uploadForUrl(fixed, key, cfg.tos, meta?.hash);
  } finally {
    if (fixed !== file) await Deno.remove(fixed).catch(() => {});
  }
};

/** 标准版: 提交音频 URL -> 轮询 query。uploaded 为管线预上传的结果(缺省时自行上传)。 */
async function recognizeStandard(
  file: string,
  cfg: AsrConfig,
  meta: AsrFileMeta | undefined,
  uploaded?: UploadedRef,
): Promise<Transcript> {
  if (!tosConfigured(cfg.tos)) {
    throw new DoubaoError(
      `标准版仅支持音频 URL, 需要先配置 TOS 上传 (${tosConfigError(cfg.tos) || "设置 → 服务配置 → TOS"})`,
    );
  }
  let ref = uploaded;
  if (!ref) {
    const fixed = await fixWavFile(file);
    try {
      const ext = fixed.slice(fixed.lastIndexOf(".")).toLowerCase();
      const key = `${meta?.hash ?? fixed.slice(fixed.lastIndexOf("/") + 1).replace(/\.\w+$/, "")}${ext}`;
      ref = await uploadForUrl(fixed, key, cfg.tos, meta?.hash);
    } finally {
      if (fixed !== file) await Deno.remove(fixed).catch(() => {});
    }
  }
  return recognizeStandardByUrl(ref.url, audioFormat(file, false), cfg, meta);
}

export const doubaoAsr: AsrProvider = async (file, cfg, meta, uploaded) => {
  if (!cfg.apiKey) {
    throw new DoubaoError("未配置豆包 API Key (设置 → 服务配置)");
  }
  // 录音设备可能写出损坏的 WAV 头(识别端读到"静音"), 先尝试修复
  const fixed = await fixWavFile(file);
  try {
    // 必须 return await: 否则 finally(删临时文件)先于识别完成执行
    return await (cfg.edition === "flash"
      ? recognizeFlash(fixed, cfg)
      : recognizeStandard(fixed, cfg, meta, uploaded));
  } finally {
    if (fixed !== file) await Deno.remove(fixed).catch(() => {});
  }
};

export const doubaoAdapter: AsrAdapter = { transcribe: doubaoAsr, upload: doubaoUpload };

/* ---------- 标准版 submit/query 实现 ---------- */

/** 查询一次任务状态。 */
async function queryTask(
  cfg: AsrConfig,
  taskId: string,
): Promise<{
  cls: "done" | "pending" | "error";
  code: string;
  body: Record<string, unknown>;
}> {
  const res = await post("/api/v3/auc/bigmodel/query", {}, cfg.apiKey, cfg.resourceId, taskId);
  const code = res.headers.get("X-Api-Status-Code") ?? "";
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { cls: classifyStatus(code), code, body };
}

async function recognizeStandardByUrl(
  url: string,
  format: string,
  cfg: AsrConfig,
  meta?: AsrFileMeta,
): Promise<Transcript> {
  // v3 协议(实测): 任务 id 就是提交时自带的 X-Api-Request-Id, 响应体为空 JSON, 查询时复用同一 id
  let taskId = meta?.resume?.taskId;

  // 断点续跑: 先探测上次遗留的任务 —— 已完成直接拿结果(不重复计费), 已失效则重新提交
  if (taskId) {
    const q = await queryTask(cfg, taskId);
    if (q.cls === "done") return parseQueryResponse(q.body);
    if (q.cls === "error") {
      console.log(`[doubao] 旧任务 ${taskId.slice(0, 8)}… 已失效(${q.code}), 重新提交`);
      meta?.saveState?.({});
      taskId = undefined;
    }
    // pending: 继续轮询该任务
  }

  if (!taskId) {
    taskId = uuid();
    const submitRes = await post(
      "/api/v3/auc/bigmodel/submit",
      {
        user: { uid: "iflyrec-demo" },
        audio: { url, format },
        request: {
          model_name: "bigmodel",
          enable_itn: true,
          enable_punc: true,
          enable_speaker_info: true, // 说话人分离(需配合 show_utterances)
          show_utterances: true,
          ssd_version: cfg.ssdVersion, // 实测 300 才能有效分离, 200 不分
        },
      },
      cfg.apiKey,
      cfg.resourceId,
      taskId,
    );
    const submitCode = submitRes.headers.get("X-Api-Status-Code") ?? "";
    const submitBody = await submitRes.json().catch(() => ({})) as Record<string, unknown>;
    if (submitCode !== "20000000") {
      const hint = friendlyStatus(submitCode);
      throw new DoubaoError(`${hint || apiMessage(submitBody)} (${submitCode})`, submitCode);
    }
    // 持久化任务 id: 服务重启/重试时可接续查询, 不重复提交
    meta?.saveState?.({ taskId });
  }

  // 轮询直到完成 —— 不设客户端超时(文档: 任务通常 3 小时内完成; 放弃等待会浪费已提交的任务)
  for (;;) {
    await sleep(POLL_INTERVAL);
    const q = await queryTask(cfg, taskId);
    if (q.cls === "pending") continue;
    if (q.cls === "error") {
      // 任务已终态失败: 清除状态, 避免重试时反复查询死任务
      meta?.saveState?.({});
      const hint = friendlyStatus(q.code);
      throw new DoubaoError(`${hint || apiMessage(q.body)} (${q.code})`, q.code);
    }
    return parseQueryResponse(q.body);
  }
}
