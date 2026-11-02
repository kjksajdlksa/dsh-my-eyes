# 我的眼睛（My Eyes）

[![verify](https://github.com/kjksajdlksa/dsh-my-eyes/actions/workflows/verify.yml/badge.svg)](https://github.com/kjksajdlksa/dsh-my-eyes/actions/workflows/verify.yml)

给 DeepSeek Harness 的模型装一双**看得见你电脑屏幕的眼睛**：能截屏、能单看某个窗口（被挡住也行）、能录一小段动态画面。它不依赖任何第三方包、不需要外部视觉 API、不弹热键，装好即用。

- 插件包名：`@local/dsh-my-eyes`
- 工具名：`eyes`
- 版本：见 [VERSION](D:\DeepSeekHarness\default-workspace\my-eyes\VERSION)（当前 1.2.1）
- 安装位置：`D:\DeepSeekHarness\default-workspace\my-eyes`（profile 里以 junction 链接，不占 C 盘）
- 源码仓库：<https://github.com/kjksajdlksa/dsh-my-eyes>（自更新通道 `github:kjksajdlksa/dsh-my-eyes`，见「自更新与迭代」）

## 它做了什么

| action | 作用 | 什么时候用 |
| --- | --- | --- |
| `info` | 引擎版本、显示器几何、光标、前台窗口、工作集内存、更新通道 | 先确认「眼睛」活着、屏幕多大 |
| `look` | 截一张图并以图片返回：整屏 / 指定显示器 / 指定区域 / 指定窗口 | 「看看我现在屏幕上是什么」 |
| `windows` | 列出可见窗口的 id、标题、进程、位置尺寸、是否前台 | 要截某个窗口、或确认前台应用 |
| `watch` | 录一段动态：N 帧 → **动图 GIF**（给人看）+ **拼图 PNG**（给模型看） | 「这个动画/视频/操作过程是什么」 |
| `selfcheck` | 真跑一遍截屏 + 录像 + 编码，结果写进 `state.json` | 升级后 / 怀疑它坏了 |
| `update` | 从 GitHub 仓库或本地目录拉新版本，校验失败自动回滚 | 维护 |

窗口截图走 `PrintWindow`，由窗口自己渲染内容，所以**被其他窗口挡住也能拿到完整画面**（独立运行的传统 PowerShell 控制台是已知例外）。

## 用法示例

```text
eyes { action: "look" }                                    # 看整屏
eyes { action: "look", monitor: 0, maxWidth: 1600 }        # 只看主显示器，高清
eyes { action: "look", target: "window", window: "Chrome" }# 只看 Chrome 窗口
eyes { action: "look", x: 0, y: 0, width: 960, height: 540}# 看左上角一块
eyes { action: "watch", durationMs: 4000, fps: 3 }         # 录 4 秒，返回动图 + 拼图
eyes { action: "selfcheck" }                               # 自检
eyes { action: "update", source: "github:kjksajdlksa/dsh-my-eyes" }         # 升级到最新
eyes { action: "update", source: "github:kjksajdlksa/dsh-my-eyes@v1.2.1" }  # 固定到某个 tag
```

返回里同时给**图片内容**（模型当场看见）和**文件路径**（可复用、可给用户打开）。

## 何时自动开启动态识别

模型被授权**按需自主开启**：当任务需要「动起来才看得清」的信息（视频、动画、游戏、滚动界面、操作过程、状态跳变），直接调 `watch`，不必先问用户。判断标准只有一条——静态 `look` 无法回答这个问题时就用 `watch`，用完把 `clip.gif` 与 `contact-sheet.png` 的路径一起交给用户。

## 产物落在哪（全部在 D 盘）

| 内容 | 路径 |
| --- | --- |
| 工作目录（默认） | `D:\DeepSeekHarness\dsh-home\eyes\` |
| 每次截图/录像 | `<工作目录>\capture-<时间戳>\`、`<工作目录>\watch-<时间戳>\` |
| 动图 | `...\clip.gif` |
| 拼图（模型看的那张） | `...\contact-sheet.png` |
| 逐帧原始图 | `...\frame-000.bmp` … |
| 运行状态与自检历史 | `<工作目录>\state.json` |
| GitHub 更新缓存 | `<工作目录>\update-cache\<owner>-<repo>@<ref>\` |
| 更新前的备份 | `<工作目录>\backup-<旧版本>-<时间戳>\` |
| 孤儿引擎登记表 | `%TEMP%\dsh-my-eyes\engines\*.json`（`%TEMP%` 在本机是 `D:\Temp`） |

录像目录默认只保留最近 30 个，旧的自动清掉（可用 `keep` 参数调）。

## 稳定性设计

- **零第三方依赖**：PowerShell 5.1 + Node 内置模块。GIF 编码器、PNG 拼图器、BMP 解码器都是本插件自带的纯实现，没有 ffmpeg / ImageMagick / Python 依赖，也不会被 npm 供应链打击。
- **常驻引擎**：冷启动 PowerShell 要 2–3 秒，所以引擎启动一次后按行协议复用，单次调用 60–400 ms。
- **崩溃自愈**：引擎异常退出会自动重启，10 分钟内最多 3 次，超过就明确报错而不是无限重启。
- **不卡系统**：录像默认 3 fps、720px 宽、最多 40 帧；引擎空闲 8 分钟自动退出；10 分钟无调用就停，不常驻吃内存。
- **不留孤儿**：每个引擎把自己的 pid 和归属进程写进登记表；下次启动时清掉「归属进程已死」的引擎，避免遗留 80 MB 的 PowerShell。
- **失败可见**：所有异常写进 `state.json`（`errors`、`lastError`），`selfcheck` 给出逐步耗时与失败原因。

## 自更新与迭代（GitHub 通道）

更新来源默认就是本插件的发布仓库 `github:kjksajdlksa/dsh-my-eyes`（可用 `config.updateSource` 覆盖），`source` 参数可直接换：

| 写法 | 含义 |
| --- | --- |
| （不带 `source`） | 默认 = `github:kjksajdlksa/dsh-my-eyes` |
| `github:owner/repo` | 仓库默认分支 |
| `github:owner/repo@v1.2.1` | 固定 tag / 分支 / commit（可复现） |
| `https://github.com/owner/repo` | 同上，URL 形式 |
| `D:\path\to\payload` | 本地分发包目录（`dist/latest` 那套布局） |

拉取有两条通道：

| 通道 | 怎么走 | 什么时候 |
| --- | --- | --- |
| **GitHub REST API zipball**（默认） | `api.github.com` 解析 ref → 签名 zip → `Expand-Archive`；commit 用 API 查 | 最稳：不需要 git，HTTPS 到 github.com 被重置/没装 git 也能用，支持私有仓库 token |
| **git 浅克隆 / 浅 fetch**（兜底） | 一个 commit 的克隆或增量 fetch，缓存复用 | API 被限流或不通时自动切换；配置 `preferGit: true` 可让它优先（能蹭本地 git 配置与代理） |

两条通道失败互不掩盖：结果里同时给出两边的失败原因。

拿到源码后：读 `package.json` 版本 → 与已安装版本比较 → 备份当前版本 → 拷贝 `index.js` / `eyes.ps1` / `tools` / `package.json` / `cordis.patch.yml` / `VERSION` / `README.md` / `locale` / `scripts` → 用新引擎做一次冒烟校验 → 失败自动回滚。返回里带 `repo`、`ref`、`commit`（两条通道都有），升级到哪一版可追溯。

| `status` | 含义 |
| --- | --- |
| `updated` | 已替换，带 `restartRequired: true`，需要重启 Harness 让新代码生效 |
| `current` | 磁盘上的版本不低于远端（同一进程里再次升级到更低版本也走这里，不会把文件换旧） |
| `fetch-failed` | 两条通道都拿不到（404 / 私有仓库缺 token / 限流 / 网络重置） |
| `bad-source` / `invalid-package` / `no-source` / `not-applicable` | 写法错 / 包不像本插件 / 目录不存在 / 源就是自己 |

私有仓库：设置环境变量 `GITHUB_TOKEN`（或插件配置 `githubToken`）。走 git 通道时 token 只在当次调用里以 `http.extraheader` 出现，**不会写进 `.git/config`**；走 API 通道时只放在请求头里，两端都会在报错信息里被打码。

### 发布流程（仓库侧）

```bash
node scripts/verify.mjs                      # 静态门禁：版本三处一致、模块语法、清单完整、BOM/密钥扫描
node scripts/release.mjs --bump 1.2.1        # 升版本 + 生成 dist/latest（含 MANIFEST.json 校验和）
node scripts/check-release.mjs dist/latest   # 校验分发包版本、必需文件、每个文件的 SHA-256
node scripts/selfcheck.mjs                   # 真机冒烟（需要桌面会话）
node scripts/integration.mjs <workDir>       # 以 DSH 方式加载插件，跑全部 action
git tag v1.2.1 && git push origin main --tags
```

推 tag 后 GitHub Actions（`.github/workflows/release.yml`）会校验 `tag == v$VERSION`、跑静态门禁、构建分发包并发布 Release；每次 push/PR 跑 `verify.yml`（Windows + Linux 双平台矩阵，只跑不需要桌面的部分）。

升级大版本时同步改 `package.json`、`VERSION`、`eyes.ps1` 里的 `$script:EngineVersion` 三处——`scripts/release.mjs --bump` 与 `scripts/verify.mjs` 会替你把关。

## 权限与隐私

- 只读屏幕、只写自己的产物目录，**不控制键鼠、不启动程序、不改系统设置**。
- 截图里可能出现聊天、密码框等私密内容：模型被要求只看任务需要的东西、不转写敏感信息。
- 本插件使用会话现有的 `danger-full-access` 文件权限，因为要把图写到 D 盘工作目录。

## 排障

| 现象 | 处理 |
| --- | --- |
| `capture engine did not start` | 跑 `node scripts/selfcheck.mjs`；PowerShell 被策略拦时确认 `-ExecutionPolicy Bypass` 可用 |
| `capture engine crashed 3 times` | 看 `state.json` 的 `lastError`；多为屏幕会话切换（锁屏/远程桌面）导致，解锁后重试 |
| 截到黑屏 | 受保护内容（DRM 视频、部分硬件加速界面）无法截取，属 Windows 限制 |
| 动图打不开 | 用浏览器打开 `clip.gif`；模型侧请直接看 `contact-sheet.png` |
| `update` 返回 `fetch-failed` + 404 | 仓库名写错 / 私有仓库没给 `GITHUB_TOKEN` / ref 不存在 |
| `update` 返回 `fetch-failed` + 403 | 未认证的 API 限流（60 次/小时），配 `GITHUB_TOKEN` 即可 |
| `update` 说 `updated` 但行为没变 | 需要重启 Harness；`info` 里 `version` 是新版本、`loadedVersion` 是旧版本、`restartRequired: true` |
| 想强制重装同一版本 | 删掉 `<工作目录>\update-cache\<slug>`，把 `source` 指到本地 `dist/latest` |
| `bad-source` | 写法不对，用 `github:owner/repo[@ref]` 或绝对目录 |
| 想彻底停掉 | 关掉 Harness 即可；引擎随进程退出，孤儿由登记表兜底清理 |

## 文件

| 文件 | 作用 |
| --- | --- |
| [index.js](D:\DeepSeekHarness\default-workspace\my-eyes\index.js) | 工具注册、动作编排、附件提交、状态记录、自更新 |
| [eyes.ps1](D:\DeepSeekHarness\default-workspace\my-eyes\eyes.ps1) | 截图引擎（Win32 枚举窗口 / CopyFromScreen / PrintWindow），常驻行协议 |
| [tools/engine.mjs](D:\DeepSeekHarness\default-workspace\my-eyes\tools\engine.mjs) | 引擎生命周期：启动、重启上限、空闲回收、孤儿清理 |
| [tools/github.mjs](D:\DeepSeekHarness\default-workspace\my-eyes\tools\github.mjs) | GitHub 更新通道：spec 解析、浅克隆/fetch、zip 兜底、token 打码 |
| [tools/bmp.mjs](D:\DeepSeekHarness\default-workspace\my-eyes\tools\bmp.mjs) | 24 位 BMP 解码 |
| [tools/gif.mjs](D:\DeepSeekHarness\default-workspace\my-eyes\tools\gif.mjs) | GIF89a 动图编码（调色板 + LZW + 抖动） |
| [tools/sheet.mjs](D:\DeepSeekHarness\default-workspace\my-eyes\tools\sheet.mjs) | 拼图合成 + PNG 写出 + 5×7 点阵字幕 |
| [scripts/verify.mjs](D:\DeepSeekHarness\default-workspace\my-eyes\scripts\verify.mjs) | 静态门禁（无需桌面，CI 与本地都用） |
| [scripts/selfcheck.mjs](D:\DeepSeekHarness\default-workspace\my-eyes\scripts\selfcheck.mjs) | 脱离 DSH 的端到端冒烟测试 |
| [scripts/integration.mjs](D:\DeepSeekHarness\default-workspace\my-eyes\scripts\integration.mjs) | 以 DSH 的方式加载插件并调用工具 |
| [scripts/release.mjs](D:\DeepSeekHarness\default-workspace\my-eyes\scripts\release.mjs) | 打包自更新分发包 + 升版本 |
| [.github/workflows/verify.yml](D:\DeepSeekHarness\default-workspace\my-eyes\.github\workflows\verify.yml) | push/PR 的双平台静态门禁 |
| [.github/workflows/release.yml](D:\DeepSeekHarness\default-workspace\my-eyes\.github\workflows\release.yml) | tag 触发：校验版本、构建分发包、发 Release |
