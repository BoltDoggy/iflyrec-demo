import { existsSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  type Registry,
  type WatchConfig,
  EXIT_ERR,
  EXIT_NEW,
  EXIT_OK,
  buildHashIndex,
  classifyDups,
  diff,
  ensureHashed,
  loadRegistry,
  loadState,
  registryFile,
  saveRegistry,
  saveState,
  scan,
  stateFileFor,
} from "@iflyrec/detect-core";
import { type CliOptions, UsageError, parseCli, usage } from "./args";

/** 本地时间 "YYYY-MM-DD HH:mm:ss" (sv-SE locale 恰好是这个格式)。 */
const ts = () => new Date().toLocaleString("sv-SE", { hour12: false });

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/** 内容指纹上下文; 未开启内容识别时返回 null, 零开销。 */
interface ContentCtx {
  regFile: string;
  reg: Registry;
  /** 本次运行前已知的 hash -> 最早路径 */
  known: Map<string, string>;
}

async function contentCtxOf(opts: CliOptions): Promise<ContentCtx | null> {
  if (!opts.contentId && !opts.skipKnown) return null;
  const regFile = registryFile();
  const reg = await loadRegistry(regFile);
  return { regFile, reg, known: buildHashIndex(reg) };
}

/** 输出新增文件; skipKnown 时内容重复的跳过。返回 {打印数, 跳过数}。 */
function emit(
  news: Set<string>,
  dups: Map<string, string>,
  opts: CliOptions,
  fmt: (file: string) => string,
): { printed: number; skipped: number } {
  let printed = 0;
  let skipped = 0;
  for (const f of [...news].sort()) {
    const dupOf = dups.get(f);
    if (opts.skipKnown && dupOf) {
      skipped++;
      continue;
    }
    console.log(fmt(f));
    printed++;
    if (dupOf) console.error(`[dup] ${f} 内容与已见文件相同: ${dupOf}`);
  }
  return { printed, skipped };
}

async function runOnce(cfg: WatchConfig, stateFile: string, opts: CliOptions): Promise<number> {
  if (!statSync(cfg.directory).isDirectory()) {
    console.error(`错误: 目录不存在: ${cfg.directory}`);
    return EXIT_ERR;
  }
  const current = scan(cfg);
  const prev = await loadState(stateFile);
  const ctx = await contentCtxOf(opts);
  if (ctx) await ensureHashed(current, ctx.reg); // 指纹补齐(含基线文件, 注册表也要学习)

  let news: Set<string>;
  if (prev === null) {
    if (opts.reportExisting) {
      news = current;
    } else {
      news = new Set();
      console.error(`首次运行: 已建立基线, 匹配 ${current.size} 个文件 (本次不报新增)`);
    }
  } else {
    news = diff(current, prev);
  }

  const dups = ctx ? classifyDups(news, ctx.reg, ctx.known) : new Map();
  const { printed, skipped } = emit(news, dups, opts, (f) => f);

  await saveState(stateFile, current); // 快照只保留仍存在的文件
  if (ctx) await saveRegistry(ctx.regFile, ctx.reg);

  if (skipped > 0) console.error(`跳过 ${skipped} 个内容重复文件`);
  if (printed > 0) {
    const dupNote = dups.size > 0 && !opts.skipKnown ? ` (其中 ${dups.size} 个内容重复)` : "";
    console.error(`检测到 ${printed} 个新增文件${dupNote}`);
    return EXIT_NEW;
  }
  if (prev !== null) console.error("没有新增文件");
  return EXIT_OK;
}

async function runWatch(cfg: WatchConfig, stateFile: string, opts: CliOptions): Promise<number> {
  const content = opts.contentId || opts.skipKnown;
  console.error(
    `[${ts()}] 开始监控 ${cfg.directory} 后缀 [${opts.exts.join(" ")}] ` +
      `(间隔 ${opts.interval}s${content ? ", 内容识别开" : ""}, Ctrl+C 退出)`,
  );

  const ctx = await contentCtxOf(opts);
  let prev = await loadState(stateFile);
  if (prev === null) {
    prev = scan(cfg); // 首次运行先建基线
    if (ctx) await ensureHashed(prev, ctx.reg);
    await saveState(stateFile, prev);
    if (ctx) await saveRegistry(ctx.regFile, ctx.reg);
    console.error(`[${ts()}] 首次运行: 已建立基线, 匹配 ${prev.size} 个文件`);
  }

  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
  });

  while (!stopped) {
    await Bun.sleep(opts.interval * 1000);
    if (stopped) break;
    if (!existsSync(cfg.directory) || !statSync(cfg.directory).isDirectory()) {
      console.error(`[${ts()}] 错误: 目录已不存在, 退出监控: ${cfg.directory}`);
      return EXIT_ERR;
    }
    const current = scan(cfg);
    if (ctx) await ensureHashed(current, ctx.reg);
    const news = diff(current, prev);
    const dups = ctx ? classifyDups(news, ctx.reg, ctx.known) : new Map();
    const { printed, skipped } = emit(news, dups, opts, (f) => `[${ts()}] NEW ${f}`);
    if (printed > 0) console.error(`[${ts()}] 检测到 ${printed} 个新增文件`);
    if (skipped > 0) console.error(`[${ts()}] 跳过 ${skipped} 个内容重复文件`);
    prev = current;
    await saveState(stateFile, current);
    if (ctx) {
      await saveRegistry(ctx.regFile, ctx.reg);
      ctx.known = buildHashIndex(ctx.reg); // 本轮学到的内容, 下一轮即视为已知
    }
  }

  console.error(`\n[${ts()}] 已停止监控`);
  return EXIT_OK;
}

export async function run(argv: string[]): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseCli(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`错误: ${e.message}\n\n${usage()}`);
      return EXIT_ERR;
    }
    throw e;
  }
  if (opts.help) {
    console.log(usage());
    return EXIT_OK;
  }

  const directory = path.resolve(expandTilde(opts.directory));
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    console.error(`错误: 目录不存在或不是目录: ${directory}`);
    return EXIT_ERR;
  }

  const cfg: WatchConfig = {
    directory,
    exts: opts.exts,
    recursive: opts.recursive,
    ignoreCase: opts.ignoreCase,
  };
  const stateFile = stateFileFor(
    cfg,
    opts.state ? path.resolve(expandTilde(opts.state)) : undefined,
  );

  if (opts.reset || opts.resetRegistry) {
    if (opts.reset) {
      try {
        unlinkSync(stateFile);
        console.error(`已删除状态文件: ${stateFile}, 下次运行将重建基线`);
      } catch {
        console.error("状态文件不存在, 无需重置");
      }
    }
    if (opts.resetRegistry) {
      try {
        unlinkSync(registryFile());
        console.error(`已删除内容指纹注册表: ${registryFile()}`);
      } catch {
        console.error("内容指纹注册表不存在, 无需重置");
      }
    }
    return EXIT_OK;
  }

  return opts.watch ? runWatch(cfg, stateFile, opts) : runOnce(cfg, stateFile, opts);
}

if (import.meta.main) {
  const code = await run(process.argv.slice(2));
  process.exit(code);
}
