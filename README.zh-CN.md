# dsh-insights-plugin

> GitHub: <https://github.com/ice5kysl/dsh-insights-plugin> ｜ MIT License ｜ 目标 dsh：`@deepseek-ai/dsh` ≥ 0.1.1-rc.2 ｜ [English](./README.md) · 简体中文

一个按官方约定编写的 **dsh（DeepSeek Harness）插件**（bundle 形态）——它是 **[dsh-insights.com](https://dsh-insights.com)**（dsh 插件生态观察站：全量插件健康分 S–D、场景推荐、生态动态，数据以开放 JSON 发布）在 dsh 内的瘦客户端。它解决一个痛点：

> 装插件前想知道它健不健康，但今天要离开 dsh、打开浏览器、手动去网站上找。

这个插件把答案**搬进会话里**，成为会话标题栏的新 tab——对话 | 轨迹 | 生态：

- **查验**——输入 `owner/repo` **或直接粘贴 GitHub URL**；得到健康卡：大等级徽章（S 紫 / A 绿 / B 蓝 / C 橙 / D 红）、0–100 分数、四维子分条（工程/文档/可发现/维护）、带严重级别的扣分明细，以及「在 dsh-insights.com 查看完整页 ↗」链接。未收录的仓库会明确提示**「不在权威集」**，而不是编造分数。
- **场景**——按使用场景浏览推荐插件（名称/等级/一句话理由）；点任意插件直接跳到「查验」并加载它的健康卡。
- **动态**——dsh 官方 release 列表（含 **BREAKING** 标记）+ 平台仓库动态（DeepSeek-V3/R1 等：星数、最新 release、最近 push）。
- **中英双语 UI**：按浏览器语言自动判断（zh → 中文，其余 → 英文）；顶栏「中 / EN」按钮随时切换并记住偏好。

## 为什么需要 host 面路由（设计说明）

浏览器面从不直连 dsh-insights.com。所有数据走官方 **`ctx.webServer.register`** 路由缝（`dsh-host-webserver`），让 dsh web server 的回环信任边界成为唯一的网络边界：

| 端点（GET） | 说明 |
|---|---|
| `/dsh-insights/plugin?full_name=owner/repo` | 单插件健康卡（修剪字段：`full_name/stars/grade/score/dimScores/drops/npm/version/description/url`）；上游扣分码补全为 `{code, sev, label}`；未收录返回 404 `not-in-corpus` |
| `/dsh-insights/search?q=&limit=20` | `full_name` + `description` 子串匹配（大小写不敏感），按 stars 排序；紧凑行（不含 `dimScores`/`drops`） |
| `/dsh-insights/scenarios` | `scenarios.json` 透传 |
| `/dsh-insights/dynamics` | `dynamics.json` 透传 |
| `/dsh-insights/health` | 探活 + 各文档缓存年龄 |

- **上游**：`https://dsh-insights.com/data/{insights,dynamics}.json`，另加公开仓库 raw 文件提供的 `scenarios.json`（它不在站点 `/data/` 下发布）——首次请求时懒加载，内存缓存 **TTL 6 小时**；拉取失败返回 **502 + JSON error**，且不污染缓存。
- **只读**，无写端点；每个请求都过一道与官方 `/api` 一致的主机信任门（回环 Host 直接信任，其余需要同源 Origin 标记）。**这不是认证层**——与官方 web server 同一姿态（默认绑定 127.0.0.1）。
- 路由经 `ctx.effect(() => ctx.webServer.register(...))` 注册，插件 fiber 卸载时自动释放。

完整架构说明见 [docs/DESIGN.md](./docs/DESIGN.md)。

## 快速安装（本机个人 dsh）

从 npm 安装（发布后）：

```bash
dsh plugin --profile web add dsh-insights-plugin
```

手动安装（clone 后）：

```bash
git clone https://github.com/ice5kysl/dsh-insights-plugin.git
cd dsh-insights-plugin
npm install && npm run build
bash scripts/install-personal.sh   # 等价于 dsh plugin --profile web add <本目录>
```

然后重启 `dsh web` 并刷新浏览器（http://127.0.0.1:3080），会话标题栏即出现「生态」tab。

## 截图

| 查验 | 场景 | 动态 |
|---|---|---|
| _（截图占位）_ | _（截图占位）_ | _（截图占位）_ |

## 数据来源与许可

- **数据**：[dsh-insights.com](https://dsh-insights.com) 开放数据集（`/data/*.json`）。健康分是**客观启发式信号，非安全审计**；评分规则（health-v5）见该站 `docs/SCHEMA.md`。数据许可遵循该站 DATA-LICENSE。
- **代码**：MIT © ice5kysl。

## 开发

```bash
npm install
npm run build        # esbuild 双面构建 → lib/index.js + lib/client.js
npm run typecheck    # tsc --noEmit（strict）
npm test             # host 面 smoke 测试（本地 fixture，不依赖真实上游）
```

CI 在每次 push 时执行 install → typecheck → build → smoke → `npm pack --dry-run`（见 `.github/workflows/ci.yml`）。
