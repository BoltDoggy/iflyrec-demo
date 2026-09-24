# iflyrec-demo

pnpm monorepo + [Bun](https://bun.sh) 实现的目录新增文件检测工具。

## 结构

```
.
├── package.json            # workspace 根 (pnpm)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── core/               # @iflyrec/detect-core — 扫描/快照/比对 核心库 (bun test)
│   └── cli/                # @iflyrec/detect-cli  — 命令行入口, bin: detect-new-files
└── apps/
    └── desktop/            # Deno 桌面应用: 文件处理台 (独立 deno.json, 不进 pnpm workspace)
```

## 快速开始

```bash
pnpm install

# 单次检测: 首次运行建基线, 之后每次报出新增 (stdout 逐行输出路径)
pnpm detect -- /path/to/dir -e wav mp3

# 递归子目录 / 忽略大小写 / 指定状态文件
pnpm detect -- /path/to/dir -e txt,log -r --ignore-case --state /tmp/state.json

# 内容识别: 跨目录发现相同内容的文件 (标注 [dup] 指向最早见过的路径)
pnpm detect -- /dirA -e txt --content-id
pnpm detect -- /dirB -e txt --content-id     # B 中与 A 内容相同的文件会被标注

# 已见内容直接不报新增、不计入退出码
pnpm detect -- /dirB -e txt --skip-known

# 持续监控, 每 5 秒扫描一次, Ctrl+C 退出
pnpm detect -- /path/to/dir -e wav -w -i 5

# 直接用 bun 运行 / 通过 bin 运行 (需 bun 在 PATH)
bun packages/cli/src/main.ts /path/to/dir -e wav
./packages/cli/bin/detect-new-files /path/to/dir -e wav
```

## 行为说明

- 首次运行（无状态文件）默认只建立基线不报新增；加 `--report-existing` 可把现有文件全部报为新增。
- 状态文件默认存放在 `~/.local/state/detect-new-files/`，按"目录+后缀+选项"自动区分，多组监控互不干扰。
- 快照只保留仍存在的文件，删除后重建的同名文件会再次视为新增。
- `--reset` 删除状态文件，下次运行重建基线。

## 内容识别（跨目录识别相同文件）

默认"新增"判定只认路径。开启 `--content-id` 后按 **SHA-256 内容指纹** 判定同一性：

- 全局注册表 `~/.local/state/detect-new-files/registry.json`，所有目录/后缀组合共享；
  相同内容即使换了目录、改了文件名（甚至删掉原件后再出现）也会被识别为"同一个文件"。
- 报新增时对内容重复的文件在 stderr 标注 `[dup] <path> 内容与已见文件相同: <已知路径>`，stdout 路径列表保持干净。
- `--skip-known`：内容已见过的文件直接不报、不计入退出码（隐含 `--content-id`）。
- 指纹按 `路径 → {size, mtime, hash}` 缓存，文件没变不重算，重复扫描开销很小。
- `--reset-registry` 清空注册表；`--reset` 只清基线、不清注册表。
- 注意：hash 时整文件读入内存，超大文件场景建议改分块。

## 桌面应用 (apps/desktop, Deno)

文件夹列表 + 后缀配置 → 递归扫描 → **按内容指纹去重**（同内容多副本合并为一条，可展开查看全部路径）→ 列表展示 → 多选批量处理 → 结果查看与持久化。

**处理管线**（`src/pipeline.ts`）：`转写(带说话人分离) → 会议纪要总结 → 思维导图大纲`，分阶段落盘、失败重试不重复已计费阶段、并发限制 2。点列表行打开详情弹层：转写文稿（说话人轮次+时间戳）/ 总结（Markdown）/ 思维导图（markmap **本地内置**于 `public/vendor/`，无需外网；零插件配置避免运行时 CDN 请求）。

**服务配置**（设置面板 → 服务配置，Key 只存本机不入库）：

| 服务 | 默认 | 说明 |
|---|---|---|
| ASR | mock | 豆包（火山引擎）录音文件识别：默认**极速版**（`/api/v3/auc/bigmodel/recognize/flash` 同步接口，本地文件 base64 直传 ≤100MB/2h，resource id `volc.bigasr.auc_turbo`，需在控制台授权该资源）；**标准版**（`volc.bigasr.auc`）支持 >2h 长音频，仅接受音频 URL——已接入 **TOS 上传**（官方 SDK 处理签名）：本地文件自动上传到配置的 bucket（对象按内容指纹命名、1 天自动过期），取 6 小时预签名 URL 提交识别（[标准版文档](https://docs.volcengine.com/docs/DoubaoVoice/audio-file-recognition-standard-edition?lang=zh)）。说话人分离 `enable_speaker_info`；极速版若不返回说话人字段则降级为单说话人 |
| LLM | mock | OpenAI 兼容接口（baseUrl / apiKey / model，示例配置指向 GLM）；负责纪要与导图大纲生成 |

```bash
cd apps/desktop
deno task start     # 启动并自动打开独立窗口 (Chrome app 模式, 无 Chrome 则默认浏览器)
deno task dev       # 开发模式 (--watch)
deno task test      # 单元测试 (turns 合并 / 豆包响应解析)
deno task audio     # 生成双人对话测试音频 test-dialog.wav (macOS say 合成)
```

- 形态：Deno 本地服务 (`localhost:17654`) + 网页 UI；Deno 生态没有官方原生 GUI，真原生窗口需 Tauri/Electron 类壳。
- `--no-open` 不自动开窗口；`PORT=xxx` 自定义端口。
- 输入框可直接粘贴从终端复制的路径（自动去掉引号与空格转义，如 `/Volumes/My\ Disk`）；无法读取的目录会在扫描后提示具体原因（路径不存在 / 无权限读取）。
- mock 模式无网络无 Key 即可全流程演示；在服务配置里选豆包并填入 API Key 后即为真实处理。
- 数据目录 `~/.local/state/iflyrec-desktop/`：`settings.json`（目录/后缀/API Key）、`processed.json`（已处理记录，按内容指纹）、`hash-cache.json`（size+mtime 指纹缓存）、`results/`（各文件处理结果，按内容指纹，副本共享）。
- 已处理按**内容指纹**记录：副本改名/移动后仍会被识别为已处理。

## 退出码

| 码 | 含义     | 典型用法                     |
|----|--------|----------------------------|
| 0  | 无新增  |                            |
| 10 | 有新增  | shell/cron 里用 `$?` 做判断 |
| 2  | 出错    |                            |

## 开发

```bash
pnpm test        # packages/core 的单元测试 (bun:test)
pnpm typecheck   # tsc --noEmit (core + cli)
```
