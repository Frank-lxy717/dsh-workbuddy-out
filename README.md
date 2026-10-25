# dsh-workbuddy-out

把任务派给 WorkBuddy 上的 CodeBuddy 专家，完成后读回**交接文档**与**产物文件**。

这是给 DeepSeek Harness 用的成本优化通道：DSH 负责规划、校验、返工；WorkBuddy 专家负责在它擅长的领域（PPT、短剧、汇报演讲、报告……）产出成品。消耗的是 WorkBuddy 账号的签到积分与免费/夜间额度，不烧 DSH 的 token。

三个工具：`workbuddy_run`（派活）、`workbuddy_list_experts`（看有哪些专家）、`workbuddy_status`（通道体检）。另外带一个 `wb` 命令行，同一套逻辑不经过模型也能用。

---

## 前提

| 条件 | 说明 |
|---|---|
| WorkBuddy 桌面端已安装并登录过 | 需要它的 CLI 与专家包缓存 |
| Node.js ≥ 20 | 在 DSH 插件进程里 `process.execPath` 是 **Electron**，跑 WorkBuddy CLI 会失败，所以插件会单独解析系统 `node.exe` |
| 至少一个专家包缓存 | `~/.workbuddy/plugins/cache/experts/`；`wb list` 只列本地已有的 |

---

## 安装

### 方式 A：装进 DSH（推荐）

1. 把整个包目录放到任意位置，例如 `~/dsh-plugins/dsh-workbuddy-out`。
2. 让 DSH 装上它——在 DSH 会话里说一句「把这个目录装成 bundle」，或直接调用：

   ```
   plugin_manager({ action: "install_bundle", target: "<包目录的绝对路径>" })
   ```

   也可以走命令行：`dsh plugin add <包目录的绝对路径>`。
3. 重启 DSH，三个 `workbuddy_*` 工具就出现在工具列表里。

包自带 `cordis.patch.yml`，`package.json` 里用 `dsh.bundle.patch` 指向它，装的时候不需要你手写 patch。

### 方式 B：只在命令行用

不装进 DSH 也能用，`bin/wb.mjs` 是独立入口：

```powershell
cd <包目录>
node bin\wb.mjs doctor --deep
```

想让它变成 `wb` 命令：`npm link`（在包目录里执行）。

### 方式 C：分发给别人

```powershell
npm pack          # 产出 dsh-workbuddy-out-0.2.0.tgz
```

对方 `npm i <tgz>`，或直接解压后按方式 A 装。

> `package.json` 里目前是 `"private": true`，这是为了防止误发到公共 npm。真要发布，把它改成 `false` 并先把 `name` 改成你自己的作用域。

---

## 快速开始

下面用 `node bin\wb.mjs` 写；如果你 `npm link` 过，换成 `wb` 即可。

```powershell
# 1. 自检：CLI / node / 凭证 / 专家 / 参数契约，哪一环断了会直接指出来
node bin\wb.mjs doctor --deep

# 2. 首次登录（或 token 过期后）。会打印一个链接，浏览器打开即可
node bin\wb.mjs login

# 3. 看本地有哪些专家
node bin\wb.mjs list

# 4. 派活
node bin\wb.mjs run --expert ai-short-drama --task "写一个 7 分钟短剧的分镜" --timeout 1800
```

跑完会打印：工作目录、`_handoff.md` 路径、新增/修改的产物清单、以及本次回收了多少临时文件。

---

## 命令参考

| 命令 | 作用 |
|---|---|
| `wb doctor [--deep] [--json]` | 完整自检。`--deep` 额外校验 CLI 参数契约是否还成立 |
| `wb list [--search <词>] [--json]` | 列出本地已安装专家 |
| `wb status [--json]` | 精简状态，适合脚本/工具调用 |
| `wb run --expert <名> --task "<任务>" [选项]` | 派活 |
| `wb clean [--dry]` | 清理派活留在系统临时目录里的文件 |
| `wb login` | 重新登录（设备码式，纯 HTTP） |
| `wb version` | 版本号 |

### `wb run` 选项

| 选项 | 说明 |
|---|---|
| `--cwd <目录>` | 工作目录。省略则自动建 `<state>/jobs/<时间戳>-<专家>/` |
| `--timeout <秒>` | 超时，见下节。省略则用 `defaultTimeoutSec`（900） |
| `--model <模型>` | `auto`（默认）/ `glm-5.1` / `deepseek-v3-2-volc` / `kimi-k2.5` / … |
| `--max-turns <n>` | 限制 agent 轮次 |
| `--effort <级别>` | `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `--handoff` / `--no-handoff` | 强制开关交接协议；都不传则听 `config.json` |
| `--json` | 机器可读输出 |

### 退出码

| 码 | 含义 | | 码 | 含义 |
|---|---|---|---|---|
| 0 | 成功 | | 5 | 找不到 CLI |
| 1 | 用法错误 | | 6 | 超时 |
| 2 | 没有凭证 | | 7 | 执行失败 |
| 3 | 凭证过期 | | 8 | 被中断 |
| 4 | 找不到专家 | | | |

---

## 超时：只有一条生死线

`timeout_sec` 是**唯一**决定任务何时被杀的参数，端到端生效。

这里有个坑值得说清楚，因为它曾经导致「活干完了，结果却回不来」：

> DSH 的工具超时策略会读工具定义上的 `timeoutMs`。若是固定数字，它就会成为一条**比 `timeout_sec` 更早**的死亡线。
> 本插件曾经写死 `timeoutMs: 1_200_000`（20 分钟），于是传 `timeout_sec: 1800` 时——CLI 本该在 30 分钟才收手——工具在第 20 分钟就被 DSH 判超时。实测中，任务在第 20 分 04 秒写完了 `_handoff.md`，工具在第 20 分 05 秒报 `Error: tool call timed out`：产物全在盘上，回传的结果一个都没拿到。

现在的做法是**不声明 `timeoutMs`**：DSH 读到该字段缺失就完全放行，不武装任何外层 deadline。真正的超时由 `lib/cli.mjs` 按 `timeout_sec` 武装：

```
到点 → SIGTERM → 5 秒 → SIGKILL
```

所以传 1800 就是 1800 秒，传 60 就是 60 秒，不会再被某个看不见的常量截断。

非法值会被归一化，不会变成「永不超时」：`0` / 负数 / `NaN` / 非数字 → 退回配置默认；超出 `[1, 86400]` 秒会被钳制。

---

## 临时目录卫生

专家常把中间产物丢进系统临时目录：无头浏览器 profile、抓取脚本、验收截图。这些文件既不在交付目录里，也不在任何人的视野里。一次重度派活实测在 `%TEMP%` 留下 **25.41 MB**（3 个 Chrome profile 目录占 24.7 MB）。

插件现在会自己回收：

1. 派活前对 `os.tmpdir()` 顶层拍一张快照（只 stat 顶层，不递归，成本可忽略）；
2. 派活结束后差分出**本次窗口内新增**的条目；
3. 按 `tmpCleanup` 决定处置。

三条自保原则（宁可少删，不可错删）：

- **只清「新增」，不碰「改动」**——改动的文件可能是别的程序正在写的；
- **只清 `tmpdir` 直属子项**，`realpath` 后必须仍在 `tmpdir` 内，越界一律拒绝；
- 跳过 `dsh*`、`vscode*`、`scoped_dir*`、`chrome_*`、`Crashpad*` 等前缀，不碰别人的东西。

删不掉的项目（被占用、权限不足）不会让派活失败，只会记进账本 `<state>/tmp-ledger.jsonl`，之后用：

```powershell
node bin\wb.mjs clean --dry    # 先看要删什么
node bin\wb.mjs clean          # 真删
```

配置 `tmpCleanup`：

| 值 | 行为 |
|---|---|
| `auto`（默认） | 派活结束自动删除本次新增项 |
| `report` | 只报告不删除，留给自己判断 |
| `off` | 完全不检查，连快照都不拍 |

---

## 交接协议

每次派活（`handoff` 为真）会自动在任务末尾追加：

```
【交接要求 · 必须遵守】
完成后，请在当前工作目录写入 _handoff.md，包含以下四节：
1. 做了什么
2. 关键决策与取舍 —— 每个选择为什么这么定，代价是什么
3. 产物文件清单 —— 文件名 + 一句话说明（含完整路径）
4. 遗留问题与后续建议

另外两条硬性要求（来自真实的返工教训，不是客套）：
- 文档里出现的任何日期，必须是执行当时的真实日期……不要凭印象写日期
- 凡是你给出的复现步骤、通关路线、验收结论，必须逐步自检每一步的前置条件是否真的成立

同时把主产物本身也写入文件，不要只把结果留在对话里。
若某项事实你没有实际核实过，必须明确标注「未核实」，不要编造。
```

后两条是补进去的。真实教训来自一次游戏开发派活：专家把日期写成了三个月前，又把「4 轮通关路线」写漏了一个前置依赖——按它字面走是走不通的。这两类错误会让整份交接文档的可信度归零，所以固化成协议条款。

这是整套方案能成立的关键：没有交接文档，主 agent 只能拿到一段对话文本，无法校验、无法返工。有它才能读决策、验事实、追产物。`examples/ppt-outline/` 里有一次真实产出的样子。

### 同一目录重复派活不会吃掉历史

专家会直接覆盖 `_handoff.md`。所以派活前，插件会先把上一轮的交接归档成 `_handoff.<时间戳>.md`：

- 本轮成功 → 旧交接留在归档里，新的写入 `_handoff.md`
- 本轮失败 / 超时 / 专家没写 → 归档自动恢复回 `_handoff.md`，**一次失败的派活不会让当前交接凭空消失**

插件不会指望专家自觉去备份——实测中它确实自己备份了一次，但那不可依赖。

---

## 配置

可选。复制 `config.example.json` 到 `~/.dsh/workbuddy-out/config.json`（Windows：`%USERPROFILE%\.dsh\workbuddy-out\config.json`）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `cliPath` | `null` | WorkBuddy CLI 绝对路径；`null` 则自动探测 |
| `defaultTimeoutSec` | `900` | 派活默认超时（秒） |
| `defaultModel` | `null` | 默认模型；`null` = CLI 的 `auto` |
| `handoff` | `true` | 是否默认附加交接协议 |
| `tmpCleanup` | `"auto"` | 临时目录处置：`auto` / `report` / `off` |

### 环境变量

| 变量 | 作用 |
|---|---|
| `WORKBUDDY_CLI` | 覆盖 CLI 脚本路径 |
| `WORKBUDDY_NODE` | 覆盖 `node.exe` 路径（Electron 环境下必需时才用） |
| `WORKBUDDY_HOME` | 覆盖 WorkBuddy 用户数据目录（默认 `~/.workbuddy`） |
| `WORKBUDDY_OUT_STATE` | 覆盖状态目录（多账号 / 测试用） |
| `WORKBUDDY_OUT_TIMEOUT` | 覆盖默认超时 |

---

## 目录结构

```
dsh-workbuddy-out/
├── package.json
├── cordis.patch.yml        # DSH bundle 补丁（插件化）
├── index.mjs               # DSH 插件入口：注册 workbuddy_* 工具
├── bin/wb.mjs              # 命令行入口（doctor/list/status/run/clean/login）
├── lib/
│   ├── config.mjs          # 运行时配置 + 超时归一化
│   ├── paths.mjs           # 所有「东西在哪」的解析（CLI 定位、node 定位）
│   ├── cli.mjs             # ★ CLI 调用契约：唯一允许拼命令行的地方
│   ├── token.mjs           # 凭证读取与有效期判断
│   ├── auth.mjs            # OAuth 设备码登录
│   ├── experts.mjs         # 专家包发现与解析
│   ├── run.mjs             # 派活 + 交接协议 + 产物增量 + 临时目录结算
│   └── tmp-guard.mjs       # 临时目录快照/差分/安全清理
├── test/
│   ├── plugin-smoke.mjs        # 工具注册与 schema 冒烟
│   └── timeout-and-tmp.mjs     # 超时跟随 + 临时目录卫生
├── examples/ppt-outline/   # 一次真实跑通的产物示例
├── config.example.json
├── LICENSE
└── README.md
```

**运行时状态不在仓库里**，在 `~/.dsh/workbuddy-out/`：

```
token.json       # OAuth 凭证（约 28 天有效期）
config.json      # 可选配置
runs.jsonl       # 每次派活的记录（时间、专家、耗时、产物、超时、临时目录结算）
tmp-ledger.jsonl # 待清理的临时文件账本
jobs/            # 没指定 --cwd 时的任务目录
logs/
```

分开放的理由：源码目录要能安全进 git / 被快照，`token.json` 混进去极易误提交。

---

## 开发

```powershell
npm test     # 冒烟 + 超时/临时目录，共 20 条
```

`test/timeout-and-tmp.mjs` 覆盖的是两次真实的线上故障，不是凑数的：归一化不许退化成「永不超时」、工具定义不许再出现 `timeoutMs`、清理逻辑不许越界、不许动「改动」的文件。

---

## 故障排查

先跑 `wb doctor --deep`，它会直接指出坏在哪。

| 现象 | 原因 / 处理 |
|---|---|
| `Cannot find module '../dist/codebuddy'` | 缺 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`。本插件默认已设置；出现说明有别的调用路径绕过了 `lib/cli.mjs` |
| `Authentication required. Please use /login command` | `CODEBUDDY_AUTH_TOKEN` 没传或已失效 → `wb login` |
| token 已过期或即将过期 | `wb login`，链接 10 分钟内有效 |
| 找不到 WorkBuddy CLI | 位置变了 → `WORKBUDDY_CLI` 指过去，或写进 `config.json` 的 `cliPath` |
| Electron 不能当 node 用 | 装 Node.js，或 `WORKBUDDY_NODE` 指到 `node.exe` |
| 工具报 `tool call timed out` 但产物都在 | 旧版本的 `timeoutMs` 问题。升级到 0.2.0+；确认工具定义里没有 `timeoutMs` |
| `%TEMP%` 越跑越大 | 跑 `wb clean`；或把 `tmpCleanup` 设成 `auto` |

### WorkBuddy 升级后

1. 先跑 `wb doctor --deep`；参数契约那一行会显示是否还认得 `--plugin-dir` / `--agent` / `-p` / `--output-format`。
2. 若只是路径变了：`doctor` 会自动重新探测，通常无需操作。
3. 若参数没了：只需改 `lib/cli.mjs` 的 `OPTION_SPECS` 与 `REQUIRED_FLAGS`。
4. 若 `dist` 文件名变了：改 `lib/paths.mjs` 的 `CLI_REL` 和 `lib/probe.mjs` 的 `REQUIRED_FILES`。

---

## 已知限制

- **专家包要在本地有缓存。** 官方市场有数百个专家，本地只有已经下过的那几个。`wb list` 只列本地缓存。
- **一次一个进程。** 每次派活起一个 CLI 进程，加载一个专家。并发派活要自己起多个进程。
- **凭证约 28 天**，没有自动刷新 refreshToken 的实现，过期即 `wb login`。
- **专家产出不保证正确。** 交接文档里的「未核实」标注要当真；主 agent 应自行校验事实。实测中专家会写出错误的日期、写不通的通关路线、以及「27 个床位」实际是 17 个这样的细节偏差。
- **临时目录清理是启发式的。** 它只能看见 `os.tmpdir()` 的顶层，且只清派活窗口内新增的项。专家若把文件写进某个深层的子目录并在窗口外创建，可能漏掉。
- **不能调 WorkBuddy 的 GUI 交互能力**（比如「编辑器里选中文本」），那是桌面层的东西。

---

## 验证状态

在本机（Windows + DSH 桌面端）实测过：

**内容产出**
- 一次完整的 20 分钟重度派活：66 KB 单文件游戏 + 9.6 KB 设计文档 + 8.1 KB 交接文档。四个结局在真实浏览器里全部点到手；刷新后进度保留、清档真删 key、375 宽不溢出、零控制台报错。

**超时跟随**（0.2.0 修复的核心）
| 设定 | 实际 | 结果 |
|---|---|---|
| 300 秒 | 159.9 秒 | 正常完成，未被打断 |
| 240 秒 | 240.7 秒 | 准点 SIGTERM，`⏰ 超时被终止（跑了 240s）` |
| 30 秒 | 30 秒 | 准点终止 |

三次都精确落在 `timeout_sec` 上，没有任何看不见的常量提前截断——旧版本那个 20 分钟硬编码再也管不着了。

**临时目录回收**
- 受控实验：让专家在 `%TEMP%` 建 `wbout-tmp-probe`（4.7 KB）与 `wbout-tmp-probe2`，两次都被自动回收，报告 `临时目录: 回收 1 项 / 3.1 KB`，事后复查两个目录均不存在。
- 历史垃圾：一次重度派活留下的 25.41 MB（3 个 Chrome profile 占 24.7 MB）已清理。

**交接文档归档**
- 同目录重复派活：上一轮 `_handoff.md` 自动归档为 `_handoff.20261026-002728.md`，新交接正常写入。
- 失败场景：故意用 30 秒超时让它失败，归档被恢复回 `_handoff.md`（7804 字节原样），历史没有被一次失败的派活毁掉。

**交接协议约束**
- 补进「真实日期」「路线自检」两条后实测生效：专家主动执行 `Get-Date` 并在文档里注明返回值（`2026-10-26 00:21:12 周一`），且逐条回读了字数、标点数、文件存在性。

**单元测试**：`npm test` 共 20 条，覆盖超时归一化（不许退化成「永不超时」）、工具定义不得出现 `timeoutMs`、清理逻辑不得越界、不得动「改动」的文件。

未核实：macOS / Linux 下的 WorkBuddy 桌面端行为（本插件按 Windows 路径与注册表探测编写，其他平台需要改 `lib/paths.mjs`）。
