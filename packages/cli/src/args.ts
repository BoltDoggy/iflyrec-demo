export class UsageError extends Error {}

export interface CliOptions {
  directory: string;
  exts: string[];
  recursive: boolean;
  ignoreCase: boolean;
  watch: boolean;
  interval: number;
  state?: string;
  reset: boolean;
  reportExisting: boolean;
  contentId: boolean;
  skipKnown: boolean;
  resetRegistry: boolean;
  help: boolean;
}

export function usage(): string {
  return `用法: detect-new-files <目录> -e <后缀...> [选项]

检测指定目录下指定后缀的新增文件。

参数:
  <目录>                 要检测的目录
  -e, --ext <后缀...>   文件后缀, 可多个: -e wav mp3 或 -e wav,mp3 (前导点可有可无)

选项:
  -r, --recursive       递归扫描子目录
  --ignore-case         后缀匹配忽略大小写
  -w, --watch           持续监控模式
  -i, --interval <秒>   监控模式的扫描间隔 (默认 5)
  --state <FILE>        状态文件路径 (默认按 目录+后缀+选项 自动生成)
  --reset               删除状态文件并退出, 下次运行重建基线
  --report-existing     首次运行时把现有文件也报为新增 (默认首次只建基线)
  --content-id          开启内容指纹: 跨目录识别相同内容, 报新增时标注 [dup]
  --skip-known          内容已见过的文件不报新增、不计入退出码 (隐含 --content-id)
  --reset-registry      删除全局内容指纹注册表并退出
  -h, --help            显示本帮助

行为:
  - 首次运行(无状态文件)默认只建立基线不报新增; 之后每次运行与上次快照比对,
    新增文件路径逐行打印到 stdout, 便于接管道继续处理。
  - 状态文件默认在 ~/.local/state/detect-new-files/ 下按 目录+后缀+选项 自动生成。
  - 快照只保留仍存在的文件, 删除后重建的同名文件会再次视为新增。
  - 内容指纹注册表全局共享 (registry.json), 所有目录/后缀组合共用:
    相同内容即使换了目录或文件名也会被识别; --reset 只清基线, 不清注册表。

退出码: 0=无新增  10=有新增  2=出错 (--skip-known 跳过的重复文件不计入退出码)`;
}

export function parseCli(argv: string[]): CliOptions {
  const o: Omit<CliOptions, "directory" | "exts"> = {
    recursive: false,
    ignoreCase: false,
    watch: false,
    interval: 5,
    reset: false,
    reportExisting: false,
    contentId: false,
    skipKnown: false,
    resetRegistry: false,
    help: false,
  };
  const extsRaw: string[] = [];
  const positional: string[] = [];

  let i = 0;
  const nextValue = (flag: string): string => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
      throw new UsageError(`${flag} 需要一个值`);
    }
    return argv[++i];
  };

  while (i < argv.length) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        o.help = true;
        break;
      case "-e":
      case "--ext": {
        let got = false;
        while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
          extsRaw.push(argv[++i]);
          got = true;
        }
        if (!got) throw new UsageError(`${a} 至少需要一个后缀值`);
        break;
      }
      case "-r":
      case "--recursive":
        o.recursive = true;
        break;
      case "--ignore-case":
        o.ignoreCase = true;
        break;
      case "-w":
      case "--watch":
        o.watch = true;
        break;
      case "-i":
      case "--interval": {
        const raw = nextValue(a);
        const v = Number(raw);
        if (!Number.isFinite(v)) throw new UsageError(`--interval 需要数字, 得到: ${raw}`);
        o.interval = v;
        break;
      }
      case "--state":
        o.state = nextValue(a);
        break;
      case "--reset":
        o.reset = true;
        break;
      case "--report-existing":
        o.reportExisting = true;
        break;
      case "--content-id":
        o.contentId = true;
        break;
      case "--skip-known":
        o.skipKnown = true;
        break;
      case "--reset-registry":
        o.resetRegistry = true;
        break;
      default:
        if (a.startsWith("-")) throw new UsageError(`未知参数: ${a}`);
        positional.push(a);
    }
    i++;
  }

  if (positional.length !== 1) {
    throw new UsageError(`需要恰好一个目录参数, 得到 ${positional.length} 个`);
  }
  const exts = [
    ...new Set(
      extsRaw
        .flatMap((s) => s.split(","))
        .map((s) => s.trim().replace(/^\.+/, ""))
        .filter(Boolean)
        .map((s) => (o.ignoreCase ? s.toLowerCase() : s)),
    ),
  ];
  if (exts.length === 0) throw new UsageError("没有有效的后缀 (用 -e wav mp3 指定)");
  if (o.watch && o.interval <= 0) throw new UsageError("--interval 必须大于 0");

  return { ...o, directory: positional[0], exts };
}
