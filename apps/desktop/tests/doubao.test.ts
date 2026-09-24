import { classifyStatus, parseQueryResponse } from "../src/providers/doubao.ts";

const eq = (actual: unknown, expected: unknown, msg?: string) => {
  const ja = JSON.stringify(actual), je = JSON.stringify(expected);
  if (ja !== je) {
    throw new Error(`${msg ?? "不相等"}\n  实际: ${ja}\n  期望: ${je}`);
  }
};

Deno.test("classifyStatus 查询状态码分类", () => {
  eq(classifyStatus("20000000"), "done");
  eq(classifyStatus("20000001"), "pending");
  eq(classifyStatus("20000002"), "pending");
  eq(classifyStatus("45000001"), "error");
  eq(classifyStatus("55000031"), "error");
});

Deno.test("解析带说话人的 utterances", () => {
  const t = parseQueryResponse({
    audio_info: { duration: 6312 },
    result: {
      text: "你好大家好",
      utterances: [
        { text: "你好,", start_time: 480, end_time: 2000, additions: { speaker: "1" } },
        { text: "大家好。", start_time: 2100, end_time: 5880, additions: { speaker: "2" } },
      ],
    },
  });
  eq(t.duration, 6312);
  eq(t.segments, [
    { speaker: "1", start: 480, end: 2000, text: "你好," },
    { speaker: "2", start: 2100, end: 5880, text: "大家好。" },
  ]);
  eq(t.fullText, "你好大家好");
});

Deno.test("无说话人信息时降级为单说话人, 空文本片段被过滤", () => {
  const t = parseQueryResponse({
    result: {
      utterances: [
        { text: "只有一个人说。", start_time: 0, end_time: 3000 },
        { text: "  ", start_time: 3100, end_time: 3200 },
      ],
    },
  });
  eq(t.segments.length, 1);
  eq(t.segments[0].speaker, "1");
});

Deno.test("空结果", () => {
  const t = parseQueryResponse({});
  eq(t.segments, []);
  eq(t.fullText, "");
});
