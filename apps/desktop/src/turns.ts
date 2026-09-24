/** 说话人轮次合并: 连续同说话人且间隔小于阈值的片段合成一轮。纯函数, 便于测试。 */
import type { Segment } from "./providers/asr.ts";

export interface Turn {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export const MERGE_GAP = 3000; // 同说话人间隔 ≤3s 视为同一轮

export function mergeSegments(segments: Segment[], gapMs = MERGE_GAP): Turn[] {
  const turns: Turn[] = [];
  for (const seg of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker && seg.start - last.end <= gapMs) {
      last.end = Math.max(last.end, seg.end);
      last.text = `${last.text}${seg.text}`.replace(/\s+/g, "");
    } else {
      turns.push({ speaker: seg.speaker, start: seg.start, end: seg.end, text: seg.text });
    }
  }
  return turns;
}
