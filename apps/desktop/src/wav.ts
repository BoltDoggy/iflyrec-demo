/**
 * WAV 头修复 —— 部分录音设备写出的 WAV 头部损坏:
 * RIFF 声明长度远小于实际文件(播放器/识别服务按声明长度读, 得到"空音频"),
 * 或 data chunk 声明大小超出实际数据。按实际文件大小改写这两个字段。
 */
export function fixWavHeader(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 12) return null;
  const is = (i: number, tag: string) =>
    String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]) === tag;
  if (!is(0, "RIFF") || !is(8, "WAVE")) return null; // 不是 WAV, 不处理

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffOk = view.getUint32(4, true) === bytes.length - 8;

  // 找 data chunk, 声明大小超出实际可用数据则记下待收敛
  let dataFix: { offset: number; size: number } | null = null;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const size = view.getUint32(off + 4, true);
    if (is(off, "data") && size > bytes.length - (off + 8)) {
      dataFix = { offset: off + 4, size: bytes.length - (off + 8) };
      break;
    }
    off += 8 + size + (size & 1);
  }

  if (riffOk && !dataFix) return null; // 头部正常
  const out = new Uint8Array(bytes); // 拷贝, 不改动原内存
  const ov = new DataView(out.buffer);
  if (!riffOk) ov.setUint32(4, out.length - 8, true);
  if (dataFix) ov.setUint32(dataFix.offset, dataFix.size, true);
  return out;
}

/** 文件版: 需要修复时写临时文件返回其路径, 否则返回原路径(调用方负责删除临时文件)。 */
export async function fixWavFile(file: string): Promise<string> {
  const bytes = await Deno.readFile(file);
  const fixed = fixWavHeader(bytes);
  if (!fixed) return file;
  const tmp = await Deno.makeTempFile({ suffix: ".wav" });
  await Deno.writeFile(tmp, fixed);
  console.log(`[wav] 修复损坏的 WAV 头: ${file}`);
  return tmp;
}
