#!/bin/bash
# 生成双人对话测试音频 (macOS say, 两个中文声音交替), 输出 16k 单声道 wav。
# 用法: ./scripts/make-test-audio.sh 输出.wav
set -euo pipefail
OUT="${1:?用法: $0 输出.wav}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

V1="${ASR_TEST_VOICE_1:-Tingting}"   # 说话人 1
V2="${ASR_TEST_VOICE_2:-Meijia}"     # 说话人 2
i=0
while IFS='|' read -r voice text; do
  [ -z "$text" ] && continue
  say -v "$voice" -o "$TMP/$i.aiff" "$text"
  afconvert -f WAVE -d LEI16@16000 -c 1 "$TMP/$i.aiff" "$TMP/$i.wav"
  i=$((i + 1))
done <<'LINES'
Tingting|大家好，今天我们讨论第二季度的工作安排。
Meijia|我先说一下进展，语音识别模块已经完成了联调。
Tingting|很好，那转写准确率现在是什么水平？
Meijia|中文场景大概百分之九十七，说话人分离也稳定了。
Tingting|那总结和思维导图这两个功能什么时候能上？
Meijia|本周开发完，下周开始内部试用。
Tingting|好，你负责发试用通知，我准备评审材料，周五再同步一次。
LINES

# 拼接 PCM (跳过每个 wav 的 44 字节头, 重写数据长度)
python3 - "$TMP" "$OUT" <<'PY'
import struct, sys, glob

tmp, out = sys.argv[1], sys.argv[2]
pcm = b"".join(
    open(f, "rb").read()[44:] for f in sorted(glob.glob(f"{tmp}/*.wav"))
)
with open(out, "wb") as f:
    f.write(b"RIFF")
    f.write(struct.pack("<I", 36 + len(pcm)))
    f.write(b"WAVEfmt ")
    f.write(struct.pack("<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16))
    f.write(b"data")
    f.write(struct.pack("<I", len(pcm)))
    f.write(pcm)
print(f"已生成 {out} ({len(pcm) / 32000:.1f}s)")
PY
