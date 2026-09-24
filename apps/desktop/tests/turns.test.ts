import { mergeSegments } from "../src/turns.ts";

/** 零依赖断言 (环境无法访问 jsr.io)。 */
const eq = (actual: unknown, expected: unknown, msg?: string) => {
  const ja = JSON.stringify(actual), je = JSON.stringify(expected);
  if (ja !== je) {
    throw new Error(`${msg ?? "不相等"}\n  实际: ${ja}\n  期望: ${je}`);
  }
};

Deno.test("连续同说话人且间隔小合并为一轮", () => {
  const turns = mergeSegments([
    { speaker: "1", start: 0, end: 1000, text: "你好," },
    { speaker: "1", start: 1200, end: 2000, text: "今天开会。" },
  ]);
  eq(turns.length, 1);
  eq(turns[0].text, "你好,今天开会。");
  eq(turns[0].start, 0);
  eq(turns[0].end, 2000);
});

Deno.test("说话人切换分轮", () => {
  const turns = mergeSegments([
    { speaker: "1", start: 0, end: 1000, text: "你好。" },
    { speaker: "2", start: 1100, end: 2000, text: "你好。" },
    { speaker: "1", start: 2100, end: 3000, text: "开始吧。" },
  ]);
  eq(turns.map((t) => t.speaker), ["1", "2", "1"]);
});

Deno.test("同说话人但间隔超过阈值(3s)分轮", () => {
  const turns = mergeSegments([
    { speaker: "1", start: 0, end: 1000, text: "第一段。" },
    { speaker: "1", start: 5000, end: 6000, text: "第二段。" },
  ]);
  eq(turns.length, 2);
});

Deno.test("空输入返回空数组", () => {
  eq(mergeSegments([]), []);
});
