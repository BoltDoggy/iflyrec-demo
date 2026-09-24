import { fixWavHeader } from "../src/wav.ts";

const eq = (actual: unknown, expected: unknown, msg?: string) => {
  const ja = JSON.stringify(actual), je = JSON.stringify(expected);
  if (ja !== je) {
    throw new Error(`${msg ?? "不相等"}\n  实际: ${ja}\n  期望: ${je}`);
  }
};

/** 构造一个最小 wav: 44 字节头 + payload */
function makeWav(declareRiff: number, declareData: number, payloadLen: number): Uint8Array {
  const bytes = new Uint8Array(44 + payloadLen);
  const v = new DataView(bytes.buffer);
  const ascii = (i: number, s: string) => [...s].forEach((c, k) => bytes[i + k] = c.charCodeAt(0));
  ascii(0, "RIFF");
  v.setUint32(4, declareRiff, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, declareData, true);
  return bytes;
}

Deno.test("正常的 WAV 头不需要修复", () => {
  const wav = makeWav(36 + 100, 100, 100);
  eq(fixWavHeader(wav), null);
});

Deno.test("RIFF 声明过小 -> 按实际大小改写", () => {
  const wav = makeWav(28, 96, 96); // 实际 44+96=140, 声明 28 (录音设备的 bug 形态)
  const fixed = fixWavHeader(wav);
  if (fixed === null) throw new Error("应修复但返回 null");
  eq(new DataView(fixed.buffer).getUint32(4, true), 140 - 8);
});

Deno.test("data 声明超出实际 -> 收敛", () => {
  const wav = makeWav(36 + 100, 200, 100); // data 声明 200, 实际只有 100
  const fixed = fixWavHeader(wav);
  if (fixed === null) throw new Error("应修复但返回 null");
  eq(new DataView(fixed.buffer).getUint32(40, true), 100);
});

Deno.test("非 WAV 数据不处理", () => {
  eq(fixWavHeader(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null);
});
