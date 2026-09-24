import { TosClient } from "npm:@volcengine/tos-sdk@2.9.1";

const eq = (actual: unknown, expected: unknown, msg?: string) => {
  const ja = JSON.stringify(actual), je = JSON.stringify(expected);
  if (ja !== je) {
    throw new Error(`${msg ?? "不相等"}\n  实际: ${ja}\n  期望: ${je}`);
  }
};

Deno.test("TOS SDK 预签名 URL 生成 (离线冒烟)", () => {
  const c = new TosClient({
    accessKeyId: "AKTEST",
    accessKeySecret: "SKTEST",
    region: "cn-beijing",
    endpoint: "tos-cn-beijing.volces.com",
  });
  const url = String(
    c.getPreSignedUrl({
      method: "GET",
      bucket: "demo-bucket",
      key: "iflyrec-desktop/abc.wav",
      expires: 3600,
    }),
  );
  eq(url.startsWith("https://demo-bucket.tos-cn-beijing.volces.com/iflyrec-desktop/abc.wav?"), true);
  eq(url.includes("X-Tos-Algorithm=TOS4-HMAC-SHA256"), true);
  eq(url.includes("X-Tos-Signature="), true);
});
