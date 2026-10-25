# 《DeepSeek Harness 插件开发入门》3 页 PPT 内容大纲

> 受众：第一次写 DSH 插件的开发者（有 Node/前端基础，没碰过 cordis / ACP）
> 场景：内部分享 / 上手引导，单页讲时长约 5-8 分钟
> 事实来源：某个已安装插件包（`@zmainer/dsh-wx-bridge` v1.1.7）的 package.json、cordis.patch.yml、README 变更史。**所有机制与报错文案均为实测/真实事故，非虚构示例。**

## 故事线（一句话）

**先建立"两半一清单"的心智模型 → 再给一条能当天跑通的安装链路 → 最后用别人的事故清单挡住上线前的坑。**

---

## 第 1 页 ｜ 一个 DSH 插件 = 一个 npm 包 + 一张 cordis 补丁 + 两半代码

**页面结论：插件不是"挂个脚本"，宿主半与客户端半是两个世界，靠路由和配置文件说话。**

- **清单即契约**：`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`、`dsh.client.platform: "web"`；`exports` 必须同时导出 `.`（宿主半 `lib/index.js`）与 `./client`（客户端半 `lib/client.js`）。**缺一半的后果是"后台在跑、设置页里没有你"**，或反过来有面板没能力。
- **双半分工要记死**：宿主半跑在 harness 进程内，负责注册独立前缀路由（如 `/wxbridge/*`）、托管子进程、读写配置；客户端半是 React 设置页面板，只通过 HTTP 拿状态（`/status`、`/log`、`/presets`）。**两边不共享内存**，唯一共享面是路由 + `$DSH_HOME/<pluginId>/config.json`。
- **补丁只干一件事**：在 cordis 插件树里 `insert` 一条 `{ id, name }`。**`id` 是内部标识，一旦发布就别动**——包名可以改（`@zmainer/wxbridge` → `@zmainer/dsh-wx-bridge`），但 cordis id、设置页面板 id、路由前缀、配置目录名一律不动，老用户的配置与数据才不丢。
- **依赖策略：零运行时依赖**。只用 Node 内建模块，不依赖任何 `@deepseek-ai/*`；需要的小库（如 qrcode 编码核心）**vendored 进 `lib/vendor/`**。原因有二：npm 打包默认忽略 `node_modules/`，且你永远不能假设用户 profile 里装了什么（真实事故：靠 `require.resolve('qrcode')` 找包，干净机器上渲染不出二维码）。

---

## 第 2 页 ｜ 从 0 到装上：最小骨架与一条不返工的安装链路

**页面结论：装不上和升级失败，八成不是代码问题，是"安装形态"和"文件放错位置"。**

- **最小骨架只有 4 个文件**：`package.json`（`type: module`、`engines.node >= 22.19`）＋ `cordis.patch.yml` ＋ `lib/index.js` ＋ `scripts/build-client.mjs`。**`files` 白名单要显式列出** `lib/ src/ scripts/ cordis.patch.yml README.md package.json`——漏了补丁或构建脚本，发布包在本地能跑、别人装上是残的。
- **只走链接式安装，并手工验收**：`dsh plugin --profile <profile> add <包名>` 之后，**必须确认 profile 的 `package.json` 里 `dsh.profile.bundles` 含你的包**。pnpm 因被忽略的构建脚本非零退出时会**静默跳过这一步**——插件"装上了"却没进 bundle，宿主根本不加载。
- **一个 profile 只用一个安装通道**（要么市场、要么 CLI），**绝不手工往 `node_modules` 复制文件**。链接式更新要求该位置是链接，手工复制的是普通目录，之后点「更新」直接报 `Cannot switch a non-link plugin directory` 并回滚（真实事故，且回滚还验证不了旧构建已恢复）。
- **配置与数据一律放 profile 之外**：配置写 `$DSH_HOME/<pluginId>/config.json`，数据目录做成可配的 `dataDir`（留空再回退到 `$DSH_HOME/<pluginId>`）。**放 profile 里 = 用户重装一次就全没了**；放外面则重装、换安装通道、换包名都不会丢。

---

## 第 3 页 ｜ 上线前五道坎：注入、进程、审批、可验证性

**页面结论：这五条每一条都对应一次已经发生过的线上事故，不是"最佳实践"。**

- **宿主能力必须先 `ctx.inject` 再用，缺失即降级**。直接访问 `ctx.workspaceRegistry` 会在**属性访问那一刻**抛 `cannot get property "workspaceRegistry" without inject`——你写的"未注入就跳过"兜底分支根本走不到（真实事故：手机会话永远不进 GUI 工作区列表）。同类坑：`dsh-host-webserver` 暴露的是**方法** `webServer.port()` 不是属性，写成属性会拿到 `port: 0`。
- **子进程入口：多级探测 + 空路径快速失败**。别硬编码也别盲 `spawn('dsh')`——空路径下 `node "" --profile acp` 会进入"读 stdin"模式：**不回应协议、也不退出**，只能干等满超时（真实事故：手机发消息 5 分钟后才报 ACP 超时）。正解是五级探测（显式参数/环境变量 → 宿主自证快照 → PATH/npm 全局 → 安装目录扫描 → 运行中进程嗅探），探测不到就**立刻报错并告诉用户该填什么**。超时也不等于失败：一轮超时应保留 pending，结果迟到就补发，别静默回落去重跑一遍。
- **安全默认一律 fail-closed**。准入默认 `strict`（未登记者**不执行**，但回一次可操作提示而非静默丢弃）；权限默认 `workspace-write`（越界的写与提权变成审批卡）；**审批超时、找不到归属人、回复无法解析 → 一律按拒绝**，绝不静默放权。子进程用**专用 `DSH_HOME`**，只带模型密钥、不带通道 token。
- **把线上契约写成可离线跑的断言**。给内核至少配一个 `--print-config`（只读打印实际生效的配置链：dataDir / 各 home / 契约 / 预设 / 审批策略 / 生成物路径，不启主循环、不抢锁、不发网络请求）和一组 `--selftest-*`。**它们在多 home 环境下的价值最高**——"我改的这份配置是不是它真在用的那份"，一条命令就能可辨。

---

## 讲述建议（可选补充）

| 页 | 建议视觉 | 备注 |
| --- | --- | --- |
| 1 | 左右分栏：宿主半 / 客户端半，中间画"HTTP 路由 + config.json"两个通道 | 别画成单体架构图，双半是最大认知差 |
| 2 | 竖向 4 步流程，第 3 步标红"手工复制 = 更新失败" | 报错文案 `Cannot switch a non-link plugin directory` 建议原样上屏 |
| 3 | 四宫格，每格"错误写法 → 真实后果" | 事故驱动，比讲原则有说服力 |

## 未纳入本版（如扩到 5-6 页可加）

- ACP 会话协议实操：`session/new` / `resume` / `prompt` / `request_permission` / `cancel` 的帧形状与叠加层（overlay yml）生成
- 预设（agent preset）机制与"预设必须每次 new/resume 后重新施加"这条协议事实
- 主动推送 outbox 模式（只写文件、不需要网络与鉴权）
