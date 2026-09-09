# dsh-insights-kit
[![DSH Insights health](https://dsh-insights.com/badge/ice5kysl/dsh-insights-kit.svg)](https://dsh-insights.com/p/ice5kysl/dsh-insights-kit/)

> GitHub: <https://github.com/ice5kysl/dsh-insights-kit> ｜ MIT License ｜ 目标 dsh：`@deepseek-ai/dsh` ≥ 0.1.1-rc.2 ｜ [English](./README.md) · 简体中文

一个按官方约定编写的 **dsh（DeepSeek Harness）插件**（bundle 形态）——它是 **[dsh-insights.com](https://dsh-insights.com)**（dsh 插件生态观察站：全量插件健康分 S–D、场景推荐、生态动态，数据以开放 JSON 发布）在 dsh 内的瘦客户端。它解决一个痛点：

> 装插件前想知道它健不健康，但今天要离开 dsh、打开浏览器、手动去网站上找。

这个插件把答案**搬进 dsh Web**：侧栏底部常驻一个 ✦ 按钮，点击打开「生态」面板（覆盖在应用之上的右侧抽屉），内含三个能力页签：

- **体检**——直接读取当前 profile 的清单（host 侧读 `~/.dsh/profiles/<profile>/package.json`，与 `dsh plugin add` 同一个数据源，任何构建都可用）**枚举你已安装的插件**并批量体检：每个插件显示等级徽章 + 分数，顶部 S/A/B/C/D 汇总条，**npm 版本漂移提醒**（npm latest ≠ 仓库版本），**每行 dsh 兼容信号**（compat.json 的 `engines.dsh` 或 cordis peer range，可判定时对照当前 dsh 版本给出保守的 ✓/⚠ 结论），低分（C/D）行附「同类更优替代 ↗」链接——另有**当前 vs 最新 dsh 版本行**（落后时提示升级）、**BREAKING 变更预警卡**，以及 **shell 模块表预检**：逐个比对已装插件界面包的外部 require 与磁盘上 shell 的可解析集合（即下次 `dsh web` 启动所装载的），会在当前/下一 dsh 构建上加载失败的插件直接打红色「无法加载」标——当磁盘上的 dsh 已新于运行中的版本时，顶部另出黄色提示（待重启窗口期，先看预检再重启）。清单即时渲染（含已装版本号）；健康卡按 `包名@版本` **缓存 24 小时**，版本未变的插件不重复体检。若本地读取失败，则优雅降级为**版本与兼容性提醒**页（dist-tags、标红 BREAKING 的最近 releases、建议动作）。
- **查验**——输入 `owner/repo` **或直接粘贴 GitHub URL**；得到健康卡：大等级徽章（S 紫 / A 绿 / B 蓝 / C 橙 / D 红）、0–100 分数、四维子分条（工程/文档/可发现/维护）、带严重级别的扣分明细、**安装/卸载操作区**（**一键按钮**：直接对本机 profile 执行 `pnpm add/remove` + 编辑装载清单——**支持热挂载的宿主即时生效（刷新页面即可）**，其余宿主下次 `dsh web` 重启生效；已在 inventory 里的插件显示「已安装」并换成卸载；旧版 host 或无 pnpm 的机器上退化为一键复制 `dsh plugin` 命令；未发布 npm 的插件提示从源码安装并附 GitHub 链接）、**相似推荐**（同类目按分数取前 5），以及「在 dsh-insights.com 查看完整页 ↗」链接。**输入不含 `/` 的关键词则直接搜索权威集**（防抖子串匹配，按 stars 排序；点结果行即加载健康卡）。未收录的仓库会明确提示**「不在权威集」**，并附按仓库名自动搜出的**相似插件**列表，而不是编造分数。
- **场景**——按使用场景浏览推荐插件（名称/等级/一句话理由，已装的插件带**「已安装」标记**）；点任意插件直接跳到「查验」并加载它的健康卡。
- **一键安装/卸载**——场景与体检行尾提供**安装/卸载按钮**，直接操作本机 profile（pnpm + `dsh.profile.bundles` 装载清单）。**支持热挂载的宿主上免重启**：新装的插件通过 vendored include 子树即时挂载进运行中的组合树（dsh-market 同款方案），卸载则即时停用对应的 Loader 条目——刷新页面即可生效；不支持热挂载的宿主上，清单状态也已持久化，下次 `dsh web` 重启自动生效。多重防护：仅 POST + host-trust 门禁、必须携带自定义头、严格 npm 包名校验、安装仅限权威集收录的插件包、pnpm 走参数数组（无 shell 拼接）、`DSH_INSIGHTS_NO_MUTATE=1` 可整体关闭。旧版 host 或无 pnpm 时按钮退化为**复制命令**。
- **中英双语 UI**：按浏览器语言自动判断（zh → 中文，其余 → 英文）；面板顶栏「中 / EN」按钮随时切换并记住偏好。

### 作者自检（CLI）

面向插件作者，health-v5 规则书同时以 CLI 形态检查**本机插件目录**（[dsh-plugin-health](https://github.com/ice5kysl/dsh-plugin-health) CLI 的 `--dir` 能力）：

```bash
npx dsh-insights-kit selfcheck /abs/path/to/your-plugin [--json] [--lang zh|en]
```

输出分数 + 等级、**逐条带「怎么修」指引**的分类扣分明细、**只读面安全扫描**摘要（fs 写 / 子进程 / HTTP 写动词 / 消毒引用）、**npm 一致性**（是否发布 / latest 与本地 version 是否脱节 / 发布是否陈旧；registry 可用 `DSH_INSIGHTS_NPM_REGISTRY` 覆盖），以及 **shell seed 漂移守卫**：当本机能定位 dsh 安装树时（自动探测全局安装，或用 `DSH_INSIGHTS_DSH_ROOT` 指定），校验构建产物 client bundle 的外部 require 是否都能被当前 dsh shell 的模块表解析——陈旧 require（加载即失败的那类事故）记为 major 扣分 `compat.missing-seed`。**存在 fail 档扣分时退出码为 1**，否则 0——可直接作为 CI 的发布前门禁；用法/路径错误退出码为 2。全程只读，不修改目录。

报告中还可能带**零权重提示**（不计分、不影响退出码）——`manifest.no-engines-dsh`：插件未声明 `"engines": {"dsh": "^x.y.z"}` 兼容范围时给出（该声明正是体检面板与 `compat.json` 展示的 dsh 兼容信号）；`compat.seed-unchecked`：client bundle 有外部 require 但本机未找到 dsh 安装树、无法执行 seed 漂移校验时给出。

## 为什么需要 host 面路由（设计说明）

浏览器面从不直连 dsh-insights.com。所有数据走官方 **`ctx.webServer.register`** 路由缝（`dsh-host-webserver`），让 dsh web server 的回环信任边界成为唯一的网络边界：

| 端点（GET） | 说明 |
|---|---|
| `/dsh-insights/plugin?full_name=owner/repo` | 单插件健康卡（修剪字段：`full_name/stars/grade/score/dimScores/drops/npm/version/description/url`）；上游扣分码补全为 `{code, sev, label}`；另附 `similar`：enrich.json 同类目前 5 名（无类目时为空数组）；未收录返回 404 `not-in-corpus` |
| `/dsh-insights/search?q=&limit=20` | `full_name` + `description` 子串匹配（大小写不敏感），按 stars 排序；紧凑行（不含 `dimScores`/`drops`） |
| `/dsh-insights/audit?npm=a,b,c` | 按 npm 包名批量查健康卡（「体检」页用）：每个名字 → 修剪卡或 null（未收录）；命中行附 `compat` 切片（`engines.dsh` + 前 3 个 dsh peer，join 自 `compat.json`） |
| `/dsh-insights/scenarios` | `scenarios.json`，并按 `full_name` 从权威集为每个推荐注解 npm `pkgName`（查不到则省略），供复制安装/卸载命令使用 |
| `/dsh-insights/dynamics` | `dynamics.json` 透传 |
| `/dsh-insights/runtime` | 当前运行的 dsh 版本（host 端从 `@deepseek-ai/dsh-web-app` / `dsh-base` 的 package.json 解析；解析不到为 `null`） |
| `/dsh-insights/installed` | 当前 profile 的已装插件清单，直读 profile manifest（`~/.dsh/profiles/<profile>`；可用 `DSH_INSIGHTS_PROFILE_DIR` / `DSH_INSIGHTS_PROFILE` 覆盖）：`{profile, baseline, plugins: [{name, spec, version, plugin, enabled}]}`——官方 in-box `@deepseek-ai/*` 基线计入 `baseline` 不列出；纯本地文件读取，不拉上游 |
| `/dsh-insights/compat` | client bundle × shell 模块表预检：逐插件比对其外部 require 与磁盘上 shell 的可解析集合（`dsh-web-frontend` shell 资产内焙的 seed 词 + 有 client 面的图行包；shell 定位顺序 `DSH_INSIGHTS_DSH_ROOT` → 进程内解析 → dsh CLI 自身路径）。返回 `{shell: {version, seedWords} | null, rows: [{name, status, requires, missing}]}`，`status` ∈ ok / broken / unknown / no-client；纯本地 |
| `POST /dsh-insights/install` | 一键安装到当前 profile（`pnpm add` + 追加 `dsh.profile.bundles`，宿主支持时即时热挂载进运行中的组合树）；body `{name}`；仅限权威集收录的插件包；需携带 `x-dsh-insights-kit: mutate` 头；返回带 `hot`（已即时生效）/ `restartRequired` |
| `POST /dsh-insights/uninstall` | 即时停用 Loader 条目（或销毁热挂载）+ 移出装载清单 + `pnpm remove`；body `{name}`；仅限已安装的包；**当其他已装包声明依赖它时拒绝（409 `has-dependents` + `dependents` 列表）**；同样要求自定义头 |
| `/dsh-insights/health` | 探活 + 各文档缓存年龄 + 能力标记：`mutations`（`DSH_INSIGHTS_NO_MUTATE=1` 开关 + pnpm 探测）与 `hotMount`（vendored include 插件可导入） |

- **上游**：`https://dsh-insights.com/data/{insights,scenarios,dynamics,compat,enrich}.json`——首次请求时懒加载，内存缓存 **TTL 6 小时**；拉取失败返回 **502 + JSON error**，且不污染缓存。
- **只读**，无写端点；每个请求都过一道与官方 `/api` 一致的主机信任门（回环 Host 直接信任，其余需要同源 Origin 标记）。**这不是认证层**——与官方 web server 同一姿态（默认绑定 127.0.0.1）。
- 路由经 `ctx.effect(() => ctx.webServer.register(...))` 注册，插件 fiber 卸载时自动释放。

完整架构说明见 [docs/DESIGN.md](./docs/DESIGN.md)。

## 快速安装（本机个人 dsh）

从 npm 安装（发布后）：

```bash
dsh plugin --profile web add dsh-insights-kit
```

手动安装（clone 后）：

```bash
git clone https://github.com/ice5kysl/dsh-insights-kit.git
cd dsh-insights-kit
npm install && npm run build
bash scripts/install-personal.sh   # 等价于 dsh plugin --profile web add <本目录>
```

然后重启 `dsh web` 并刷新浏览器（http://127.0.0.1:3080），侧栏底部出现 ✦ 生态按钮，点击即打开面板。

## 截图

| 体检 | 查验 | 场景 |
|---|---|---|
| _（截图占位）_ | _（截图占位）_ | _（截图占位）_ |

## 数据来源与许可

- **数据**：[dsh-insights.com](https://dsh-insights.com) 开放数据集（`/data/*.json`）。健康分是**客观启发式信号，非安全审计**；评分规则（health-v5）见该站 `docs/SCHEMA.md`。数据许可遵循该站 DATA-LICENSE。
- **代码**：MIT © ice5kysl。

## 开发

```bash
npm install
npm run build        # esbuild 三入口构建 → lib/{index,client,cli}.js
npm run typecheck    # tsc --noEmit（strict）
npm test             # host 面 + CLI smoke 测试（本地 fixture，不依赖真实上游）
```

CI 在每次 push 时执行 install → typecheck → build → smoke → `npm pack --dry-run`（见 `.github/workflows/ci.yml`）。
