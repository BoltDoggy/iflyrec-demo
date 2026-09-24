/**
 * TOS (火山引擎对象存储) 上传 —— 豆包"标准版"识别只接受音频 URL,
 * 本地文件先上传 TOS 再取预签名 URL 交给识别服务。
 *
 * 使用官方 SDK (@volcengine/tos-sdk) 处理 TOS4 签名, 避免手写签名算法。
 * 对象 key 用内容指纹命名(同内容不重复上传), 一天后自动过期清理,
 * 下载走 6 小时有效的预签名 URL, 桶无需开公共读。
 */
import { TosClient } from "npm:@volcengine/tos-sdk@2.9.1";
import { getDb } from "../db.ts";

export interface TosConfig {
  region: string;
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  prefix: string;
}

export function tosConfigured(t: TosConfig): boolean {
  return Boolean(t.bucket.trim() && t.accessKeyId.trim() && t.accessKeySecret.trim());
}

export function tosConfigError(t: TosConfig): string {
  const missing = [
    !t.bucket.trim() && "bucket",
    !t.accessKeyId.trim() && "AccessKeyID",
    !t.accessKeySecret.trim() && "AccessKeySecret",
  ].filter(Boolean);
  return missing.length ? `TOS 配置缺少: ${missing.join(", ")}` : "";
}

/**
 * 上传文件到 TOS 并返回预签名下载 URL。
 * 对象 key 用内容指纹命名, 已存在(未过期)则跳过上传 —— 幂等且省流量。
 */
export async function uploadForUrl(
  file: string,
  key: string,
  cfg: TosConfig,
  contentHash?: string,
): Promise<{ url: string; objectKey: string; uploaded: boolean }> {
  const client = new TosClient({
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
    region: cfg.region,
    endpoint: cfg.endpoint,
  });
  const objectKey = `${cfg.prefix.replace(/\/+$/, "")}/${key}`;
  let uploaded = false;
  try {
    await client.headObject({ bucket: cfg.bucket, key: objectKey });
  } catch {
    try {
      // putObjectFromFile 由 SDK 流式读文件, 大音频不必整块进内存
      await client.putObjectFromFile({
        bucket: cfg.bucket,
        key: objectKey,
        filePath: file,
        // 一天后自动删除, 录音不在桶里累积; 过期后重试会重新上传
        headers: { "x-tos-object-expires": "1" },
      });
      uploaded = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`TOS 上传失败: ${msg.slice(0, 200)}`);
    }
  }
  if (contentHash) {
    getDb().markUploaded(contentHash, {
      bucket: cfg.bucket,
      objectKey,
      at: new Date().toISOString().slice(0, 19),
    });
  }
  const url = String(
    client.getPreSignedUrl({
      method: "GET",
      bucket: cfg.bucket,
      key: objectKey,
      expires: 6 * 3600, // URL 6 小时有效, 覆盖识别窗口
    }),
  );
  return { url, objectKey, uploaded };
}
