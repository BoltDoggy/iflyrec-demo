/** LLM Provider: OpenAI 兼容接口 (/chat/completions) + mock。用于纪要总结与思维导图大纲。 */

export interface LlmConfig {
  provider: "mock" | "openai";
  baseUrl: string; // 如 https://open.bigmodel.cn/api/paas/v4
  apiKey: string;
  model: string; // 如 glm-4-flash
}

export type LlmChat = (system: string, user: string) => Promise<string>;

async function openaiChat(cfg: LlmConfig, system: string, user: string): Promise<string> {
  if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) {
    throw new Error("未配置完整的 LLM 服务 (设置 → 服务配置: baseUrl / apiKey / model)");
  }
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM 请求失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("LLM 返回为空");
  }
  return content.trim();
}

/* ---------------- prompt ---------------- */

export const SUMMARY_SYSTEM = `你是专业的会议纪要助手。根据带说话人标注的多人对话转写文稿输出 Markdown 会议纪要, 结构固定为:
## 一句话总结
## 关键要点
(3-7 条, 每条一句话)
## 决议与结论
(如无写"本次会议未形成明确决议")
## 待办事项
(- [ ] @说话人: 事项 的清单; 如无写"无")
## 分歧与风险
(如有才写, 无则省略本节)
只依据文稿内容, 不编造; 提及具体数字与人名(说话人以"说话人 N"指代)时保持原文。`;

export const MINDMAP_SYSTEM = `把会议内容整理成思维导图大纲, 只输出 Markdown 本身, 不要任何解释或代码块围栏。
格式: 一级标题(#)为会议主题(≤12字), 二级标题(##)为 3-6 个主题分支(≤15字), 三级(###)及列表项为具体要点(每条≤20字)。
层次不超过 3 级, 内容忠实于文稿。`;

/* ---------------- mock ---------------- */

const mockLlmChat = (kind: "summary" | "mindmap"): LlmChat =>
async (_system, user) => {
  _system;
  await new Promise((r) => setTimeout(r, 400));
  const head = user.split("\n").find((l) => l.trim()) ?? "会议";
  if (kind === "summary") {
    return `> ⚠️ mock 数据(未配置真实 LLM)
## 一句话总结
${head.slice(0, 40)} … 团队同步了进展并明确了下一步分工。
## 关键要点
- 识别模块完成联调, 中文准确率约 97%
- 总结与思维导图功能本周完成开发
- 下周开始内部试用
## 决议与结论
- 周五再次同步进度
## 待办事项
- [ ] @说话人 1: 准备评审材料
- [ ] @说话人 2: 发出试用通知`;
  }
  return `# 会议纪要(mock)
## 进展
### 识别模块联调完成
### 中文准确率约 97%
## 计划
### 总结与导图本周开发
### 下周内部试用
## 分工
### 说话人1 评审材料
### 说话人2 试用通知`;
};

/** 组装带说话人的文稿文本, 供两个 prompt 复用。 */
export function transcriptToPromptText(
  turns: { speaker: string; start: number; text: string }[],
): string {
  return turns.map((t) => `[${fmtTime(t.start)}] 说话人 ${t.speaker}: ${t.text}`).join("\n");
}

export function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function getSummaryChat(cfg: LlmConfig): LlmChat {
  return cfg.provider === "mock" ? mockLlmChat("summary") : (s, u) => openaiChat(cfg, s, u);
}

export function getMindmapChat(cfg: LlmConfig): LlmChat {
  return cfg.provider === "mock" ? mockLlmChat("mindmap") : (s, u) => openaiChat(cfg, s, u);
}
