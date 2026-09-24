/** ASR (带说话人分离的语音转写) Provider 接口与 mock 实现。 */
import type { TosConfig } from "./tos.ts";

/** 一段语音片段; start/end 为毫秒, speaker 为服务端返回的说话人标识("1"/"2"/...) */
export interface Segment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  segments: Segment[];
  duration: number; // 音频时长(毫秒)
  fullText: string;
}

export interface AsrConfig {
  provider: "mock" | "doubao";
  apiKey: string;
  /** doubao: 极速版=本地文件 base64 直传(≤100MB/2h); 标准版=上传 TOS 后以 URL 提交 */
  edition: "flash" | "standard";
  /** doubao 资源 id; 极速版 volc.bigasr.auc_turbo / 标准版 volc.bigasr.auc */
  resourceId: string;
  /** 说话人分离引擎版本(标准版): "200" 普通(≤5人) / "300" 会议长音频 */
  ssdVersion: "200" | "300";
  /** 标准版上传目标 TOS */
  tos: TosConfig;
}

/** 交给 provider 的文件元信息; hash 为内容指纹, 用作 TOS 对象 key。 */
export interface AsrFileMeta {
  hash?: string;
}

export type AsrProvider = (
  file: string,
  cfg: AsrConfig,
  meta?: AsrFileMeta,
) => Promise<Transcript>;

/** 说话人显示名: "1" -> "说话人 1" */
export const speakerLabel = (spk: string) => `说话人 ${spk}`;

/* ---------------- mock ---------------- */

const MOCK_LINES: [string, string][] = [
  ["1", "大家好，今天我们讨论一下第二季度的工作安排。"],
  ["2", "我先说一下进展：语音识别模块已经完成了联调。"],
  ["1", "很好，那转写准确率现在是什么水平？"],
  ["2", "中文场景大概百分之九十七，说话人分离也稳定了。"],
  ["1", "那总结和思维导图这两个功能什么时候能上？"],
  ["2", "本周开发完，下周开始内部试用。"],
  ["1", "好，待办我先记一下：你负责发试用通知，我准备评审材料。"],
  ["2", "没问题，我们周五再同步一次。"],
];

/** mock 转写: 无网络/无 Key 时走全流程演示。 */
export const mockAsr: AsrProvider = async (file, _cfg, _meta) => {
  _cfg;
  _meta; // 参数仅为对齐接口
  await new Promise((r) => setTimeout(r, 600));
  let t = 300;
  const segments: Segment[] = MOCK_LINES.map(([speaker, text]) => {
    const dur = Math.max(1200, text.length * 260);
    const seg: Segment = { speaker, start: t, end: t + dur, text };
    t += dur + 400;
    return seg;
  });
  console.log(`[mock] ASR 完成: ${file}`);
  return {
    segments,
    duration: t,
    fullText: segments.map((s) => s.text).join(""),
  };
};
