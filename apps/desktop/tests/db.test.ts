import { StateDb } from "../src/db.ts";

const eq = (actual: unknown, expected: unknown, msg?: string) => {
  const ja = JSON.stringify(actual), je = JSON.stringify(expected);
  if (ja !== je) {
    throw new Error(`${msg ?? "不相等"}\n  实际: ${ja}\n  期望: ${je}`);
  }
};
const hex = (n: number) => "a".repeat(60) + String(n).padStart(4, "0");

Deno.test("StateDb 基础读写与 upsert", () => {
  const dir = Deno.makeTempDirSync();
  const db = new StateDb(`${dir}/state.db`, `${dir}/legacy`);

  db.markProcessed(hex(1), "a.wav");
  db.markProcessed(hex(1), "a-改名.wav"); // upsert 覆盖
  eq(db.getProcessed().size, 1);
  eq(db.getProcessed().get(hex(1))?.name, "a-改名.wav");

  db.markUploaded(hex(1), { bucket: "b", objectKey: "k1", at: "t1" });
  eq(db.getUploads().get(hex(1)), { bucket: "b", objectKey: "k1", at: "t1" });

  db.putCachedHash("/p", 10, 1.5, "h1");
  db.putCachedHash("/p", 20, 2.5, "h2");
  eq(db.getCachedHash("/p"), { size: 20, mtime: 2.5, hash: "h2" });

  const r = { id: hex(2), name: "b.wav", status: "done" as const };
  db.saveResult(r);
  eq(db.getResult(hex(2))?.name, "b.wav");
  eq(db.getResult("no-such"), null);

  // brief 列: 保存后可按 id 查询, 更新覆盖
  eq(db.getBriefs().size, 0);
  db.saveResult({ ...r, brief: "一段测试简介" });
  db.saveResult({ id: hex(3), name: "c.wav", status: "done", brief: "另一条" });
  eq(db.getBriefs().get(hex(2)), "一段测试简介");
  eq(db.getBriefs().get(hex(3)), "另一条");
  db.saveResult({ ...r, brief: undefined }); // 清除
  eq(db.getBriefs().has(hex(2)), false);
});

Deno.test("StateDb allStatuses 与中断恢复", () => {
  const dir = Deno.makeTempDirSync();
  const db = new StateDb(`${dir}/state.db`, `${dir}/legacy`);

  db.saveResult({ id: hex(1), name: "a.wav", status: "done", meta: { tos: { objectKey: "k" } } });
  db.saveResult({ id: hex(2), name: "b.wav", status: "processing", stage: "transcribing" });
  eq(db.allStatuses()[hex(1)], { status: "done", uploaded: true });
  eq(db.allStatuses()[hex(2)].status, "processing");

  eq(db.recoverInterrupted(), 1);
  const recovered = db.getResult(hex(2));
  eq(recovered?.status, "error");
  eq((recovered?.error ?? "").includes("中断"), true);
  eq(db.recoverInterrupted(), 0); // 幂等
});

Deno.test("StateDb 自动迁移旧 JSON 数据", async () => {
  const dir = Deno.makeTempDirSync();
  const legacy = `${dir}/legacy`;
  Deno.mkdirSync(`${legacy}/results`, { recursive: true });
  Deno.writeTextFileSync(
    `${legacy}/processed.json`,
    JSON.stringify({ abc123: { at: "2026-01-01T00:00:00", name: "旧.wav" } }),
  );
  Deno.writeTextFileSync(
    `${legacy}/uploads.json`,
    JSON.stringify({ abc123: { bucket: "bk", objectKey: "p/k", at: "t" } }),
  );
  Deno.writeTextFileSync(
    `${legacy}/hash-cache.json`,
    JSON.stringify({ "/old": { size: 1, mtime: 2, hash: "h" } }),
  );
  Deno.writeTextFileSync(
    `${legacy}/results/def456.json`,
    JSON.stringify({ id: "def456", name: "旧结果.wav", status: "done" }),
  );

  const db = new StateDb(`${dir}/state.db`, legacy);
  eq(db.getProcessed().get("abc123")?.name, "旧.wav");
  eq(db.getUploads().get("abc123")?.objectKey, "p/k");
  eq(db.getCachedHash("/old")?.hash, "h");
  eq(db.getResult("def456")?.name, "旧结果.wav");
  // 旧文件已改名备份
  eq(await Deno.stat(`${legacy}/processed.json.bak`).then(() => true, () => false), true);
  eq(await Deno.stat(`${legacy}/results.bak`).then(() => true, () => false), true);

  // 二次打开幂等(不会重复导入/报错)
  const db2 = new StateDb(`${dir}/state.db`, legacy);
  eq(db2.getProcessed().size, 1);
});
