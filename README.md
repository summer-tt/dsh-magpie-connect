# dsh-magpie-connect

把 Magpie 网关上的模型接进 DeepSeek Harness（DSH）的模型选择器。

装好之后，你就能在 DSH 里直接选用网关提供的模型，不需要额外跑进程，也不用配代理。

<p align="center">
  <img src="docs/image/screenshot-settings.png" alt="Magpie 网关设置页" width="50%">
</p>

## 功能

- **模型自动同步** — 网关列出的模型全部进入 DSH 模型选择器，想显示哪些由你决定。
- **图片识别** — 网关声明支持图片的模型可以直接发图。
- **思考档位** — 网关支持的思考档位（含 `none`、`ultra`）原样出现在选择器里。
- **网页搜索切换** — 注册为 DSH 的独立搜索提供方（复用已保存的网关地址与 API Key），在设置页一键切换 DSH 的 `web_search` 到 Magpie；默认沿用 Magpie 自身的代搜模型或 Search API 配置（无需在资源库开启 MCP 路由），也支持指定 Magpie 模型（Messages API）并随时在页面切换，无需手改 `cordis.patch.yml`。
- **MCP 服务接入（可选，默认关闭）** — 在设置页勾选后，把 Magpie 的 MCP Hub（`/mcp/magpie/hub`：网页搜索、浏览器、图像等工具，以及资源库中勾选的服务）接入 DSH，作为 `mcp__magpie__<tool>` 原生工具供模型调用。**默认不启动**：只有勾选并保存后才会建立连接，复用上方已保存的地址与 Key，取消勾选即时注销；卡片与网页搜索、界面增强一样可收缩/展开。
- **路由浮窗** — 输入框右侧的 Magpie 图标，桌面悬停（手机端点按）即显示网关路由的压缩视图：当前会话最近一次请求走了哪条路由、命中/避开了哪些账号/模型及耗时；无会话时回退显示整份 trace 里最新的一条路由。数据由插件在 Host 侧用已保存的 Key 读取（`/api/magpie-trace`，聚合网关的 `/v1/magpie/quotas`、`/v1/magpie/concurrency`、`/v1/magpie/route` 与 Web 的 `/api/gateway/trace`），浏览器不接触 Key；账号持有人只以首字符形式出现在页面上。
- **完整路由组详情（可选）** — 在设置页填入 Magpie Web Key 后，浮窗会从 Magpie Web 的完整 trace 读取当前会话的路由组、嵌套子路由组（如 `Hy4 auto/hy4free`、`GPT-6 Luna auto/gpt-6-luna`）、候选账号、逐次尝试、限流/失效原因与恢复时间，并通过 Host 同源代理显示供应商图标；Web Key 仅保存在 Host 的 `settings.json`（文件权限 `0600`），设置页不回显。未配置或 Web Key 失效时自动回退到简化视图。

## T3 会话速度与上下文窗口

配合支持会话滑杆的 T3 Model Picker，可在 Magpie 的 `codex/gpt-6.2-sol`、`codex/gpt-6.2-astra` 和对应的 `group/` 路由上调整速度与上下文窗口。两类路由都提供 272K、500K、872K 三个本地窗口。基础路由首次使用时默认为 Fast 和 500K。带窗口和速度后缀的 Group 路由从其名称所示的档位开始，例如 `group/gpt-6.2-sol-500k-ultrafast` 初始为 Ultrafast 和 500K。只带窗口后缀的 Group 路由初始显示 Standard。

新会话沿用同一 provider 和完整模型 ID 最近一次手动选择，现有会话恢复自己的设置。同一 provider 和模型的子 Agent（含 `subagent_fork`）在创建时复制一次父 Agent 的设置，之后可独立运行。Group 仍由网关按该组的配置路由，实际服务速度也受组成员配置和上游能力影响。

在插件的 Cordis `config` 中可以独立关闭两项功能。例如以下配置仅关闭速度控制：

```yaml
sessionSpeedEnabled: false
sessionContextWindowEnabled: true
```

两个开关默认都为 `true`。关闭速度控制后，普通请求沿用网关默认策略。开启时，Standard 省略 `service_tier`，Fast 请求 `priority`，Ultrafast 请求 `ultrafast`。关闭上下文控制后，DSH 恢复使用网关模型目录的窗口和相应的默认输出上限。滑杆上的 872K 是 DSH 的本地预算，上游实际接受的长度取决于路由。两项设置均不改变请求模型 ID。

配合 T3 Model Picker `1.1.3-session-controls.3`，收起菜单时一并提交修改过的推理等级、速度和窗口，按 Escape 放弃本次编辑。支持运行中编辑的会话会在后续模型请求采用新设置，已发出的请求及其普通重试沿用原 step 的设置。关闭速度或窗口功能后，T3 会隐藏相应的滑杆和输入框状态。旧版 T3 仍在会话空闲时保存设置。

运行中缩小窗口时，当前窗口保持生效，直到 Host 确认下一次模型请求的输入和输出预算适合新窗口。DSH 可以先尝试自动压缩。如果无法确认预算或新窗口装不下请求，T3 显示 DSH 通知，Host 保留原窗口并应用同批提交的速度和推理等级。若原窗口也装不下请求，Host 会在发送前终止该请求。通过检查的新窗口只更新当前会话，新会话仍沿用最近一次直接保存的窗口。

Host 的 `/api/magpie-session-controls` 仅供 owner 使用。支持运行中编辑时，GET 和保存回执提供 `runningEdits: true`，提交批次时需传 `allowRunning: true` 和最新的 `expectedRevision`。`contextWindow.value` 始终表示已生效的窗口。`pendingWindow` 提供候选的 `id` 和 `target`，`windowWarning` 提供被拒候选的 `id`、`target`、`retained` 和 `reason`。警告原因包括 `unavailable`、`measurement-failed` 和 `over-budget`。

`sessionControlRoutes` 可替换内置路由清单。每项按完整 `provider` 和 `model` 匹配。自定义路由示例：

```yaml
sessionControlRoutes:
  - provider: magpie
    model: codex/gpt-6.2-sol
    speed: { options: [standard, fast, ultrafast], default: fast }
    contextWindow: { options: [272000, 500000, 872000], default: 500000 }
    efforts: [low, medium, high]
```

如要同时启用 Astra，请在数组中为 `codex/gpt-6.2-astra` 增加一项。省略 `efforts` 时使用目录公布的推理档位。

## 安装

```sh
dsh plugin --profile web add git+https://github.com/summer-tt/dsh-magpie-connect.git
```

安装后重启 `dsh web`。

该 Git URL 默认使用 `session-controls` 分支，Host 和客户端构建产物随源码提交。要固定版本，可在 URL 末尾加 `#` 和完整 commit SHA。

全新 profile 使用 pnpm 12 时，如果提示 `ERR_PNPM_IGNORED_BUILDS` 并列出 `@google/genai` 和 `protobufjs`，可在该 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 中把这两项设为 `false` 后重新安装，明确跳过这两个间接依赖的构建脚本。已有配置按 profile 原有策略处理。

**需要**：DSH 的 web profile、Node.js ≥ 20、能访问网关。

## 使用

### 第一步：填网关地址和 Key

打开 **设置 → Magpie 网关**，确认两项：

- **API 地址** — 网关地址，**要带版本号**。默认已填好 `http://127.0.0.1:3425/v1`，网关不在本机时改成实际地址。
- **API Key** — 网关凭据，必填。

> Key 保存后**不会再回显**到页面；输入框留空表示沿用已保存的 Key，只有填入新值才会替换。
> 「测试连接」和「获取可用模型」同样复用已保存的 Key。设置文件里仍然是原来的 JSON 结构
> （`baseUrl` / `apiKey` / `enabledModels`），所以降级回旧版本也能直接读取。
> 插件自有状态目录在 POSIX 系统上为 `0700`、`settings.json` 为 `0600`；旧版本留下的宽权限
> 会在下次读取时自动收紧（只读文件系统或非 POSIX 平台会跳过，不影响设置读取）。

点「保存」后，可以点「测试连接」确认通不通（会告诉你网关上有多少模型）。两项都齐了才会生效——
地址有默认值，Key 没有，所以没填 Key 之前模型选择器是空的。

> **地址一定要带版本段**（如 `/v1`）。插件只在你填的地址后面接资源名，不会自己补
> 版本号——所以网关以后升级到 `/v2`、`/v3`，你只要改这一个字符串。

### 第二步：选择要显示的模型

点 **获取可用模型**，会弹出网关当前的模型列表：勾选你想要的，再点「应用选择」。
弹窗里可以搜索、全选、取消全选。

模型选择器、已选模型列表和弹窗统一显示 **`<组名>/<模型名>`**：模型名直接取 API 的
`display_name`；组名优先取 `magpie_label` 最后一个 ` · ` 右边的部分。若 `magpie_label`
缺失或没有可解析的组名，则取 id 第一个 `/` 前的部分，并仅将首字母大写（例如
`workbuddy-ai/hy4free` → `Workbuddy-ai/Hy4`）。`auto/` 和 `group/` 是特例：组名始终从 id 前缀
生成（`Auto`、`Group`），不使用 `magpie_label` 中的通用组名。
原始路由 id 只在鼠标悬停时显示，请求、会话历史和白名单里始终是 id，所以改显示名
不会影响已保存的选择或历史会话。搜索可以同时按显示名和 id 匹配，列表按显示名排序。

> 如果 API 没有返回 `display_name`，显示名回落到原始 id。旧版本留下的本地模型缓存
> 暂时以 id 显示，等下一次成功读取网关目录后自动换成新标签。

模型列表是**白名单**，和 DSH 自带的「模型」设置语义一致：列表里有什么，选择器就提供
什么。不想要的点该行末尾的「删除」，它就从列表和选择器里一起消失；想加回来，点
「获取可用模型」，在弹窗里勾上它再「应用选择」。

**新增的模型不会自己出现**：网关新上架的模型要你在弹窗里勾选并应用后才会进入列表。
这是白名单的代价，也是它的好处——网关某条 lane 抖动（临时掉线又恢复）不会把你删掉的
模型偷偷放回来。

**「恢复默认模型」**：清掉自定义列表，回到「直接使用网关的完整目录」。列表为空
（`[]`）和继承网关目录是两种不同状态：前者一个模型都不提供，后者全提供。

**「获取可用模型」会同步本地目录**：弹窗拿到的就是网关此刻的完整目录，读取成功后本地
目录整体替换成它，所以网关已下架的模型会同时从弹窗和列表消失；读取失败（地址错、
Key 无效、网关不通）不会清空本地目录，避免把选择器误清成空。

> 行末的 `内置快照` 标签说明这条来自插件的兜底快照（网关暂时不可达时），不是网关当前列表。

> 弹窗查的是**你当前填的地址和 Key**（哪怕还没保存），所以换网关是一趟的事。
> 连不上也不会卡住——失败原因会显示在列表下方，已列出的行仍然可以操作。

### 第三步：切换网页搜索到 Magpie（可选）

插件会通过 DSH 的 `ctx.web.registerSearchProvider` 注册一个独立的 Magpie 搜索提供方（复用上方已保存的 API 地址与 Key，不覆盖 DSH 内置的 `web-search-deepseek` 配置）。

在 **设置 → Magpie 网关 → 网页搜索** 中可以：

- 勾选 **将 DSH 网页搜索切换到 Magpie** — 实时更新 DSH 的 `web.searchProvider`，无需手动编辑 `cordis.patch.yml`（取消勾选即可恢复 DSH 自动选择；与 DSH 内置「插件 → 内置插件配置 → 网页搜索与获取」双向同步）。
- 选择 **搜索方式**：
  - **跟随 Magpie 网关搜索设置（默认）** — 通过网关内置 `{gatewayBase}/mcp/magpie/web-search` 直接沿用 Magpie 自身的代搜模型或 Search API 配置，无需在 Magpie 资源库开启 MCP 路由，也无需额外指定模型。
  - **指定 Magpie 模型（Messages API）** — 请求 `{baseUrl}/messages` 并附带 `web_search_20250305` 工具，可直接从网关模型列表中随时切换搜索模型，或手动填写自定义模型 ID。
- 点击 **测试搜索** — 立即验证当前搜索方式与模型是否可用。

### 第四步：接入 Magpie MCP 服务（可选）

Magpie 网关把它资源库里的 MCP 服务聚合成一个 MCP 服务器。在 **设置 → Magpie 网关 → MCP 服务** 中勾选 **在 DSH 中启用 Magpie MCP Hub** 并保存，插件就会通过 DSH 的 `ctx.tools` 把这些工具接进来。

- **默认不启动**：不勾选就不会对网关发起任何 MCP 连接，启动 DSH 时始终保持关闭。只有勾选并「保存」后才建立连接；取消勾选即时注销。
- **优先按需加载**：插件先请求 agent 地址 `/mcp/magpie/hub/dsh`。Magpie 新版（v0.1.4808 起，含非本地部署）会在这里直接返回按需工具集（`find_tools` / `call_tool` / `run_code`），插件原样透传——服务目录由 Magpie 写在 `find_tools` 说明里。工具 ≤10 个时则返回全量工具，逐个注册。
- **兼容旧版 / 未勾选**：若 agent 地址列出 0 个工具（旧版 Magpie 不认这个 agent，或资源库没给该 agent 勾选服务），自动改用全应用地址 `/mcp/magpie/hub`；此时若工具 >10 个，由插件自己按需加载（只注册查找/运行两个工具，其余 schema 不进每轮请求）。
- **想强制走全应用地址**：把 `mcpAgent` 设为 `all`。
- **复用同一份凭据**：使用上方已保存的 API 地址与 Key（`Authorization: Bearer`）；改了地址或 Key 会按新值自动重刷工具集，无需重启。
- **测试 MCP**：点「测试 MCP」会探测**与正式注册相同的地址**（agent 优先、空了回退全应用），不保存、也不注册任何工具。
- 卡片标题右侧显示状态，正文显示当前方式（直连 N 个工具 / 插件按需 / Magpie 按需）。

| Magpie 版本 / 场景 | 实际用的地址 | 谁做按需加载 |
| --- | --- | --- |
| v0.1.4808 及以后（本地或远程） | `/mcp/magpie/hub/dsh` | **Magpie**（原样透传） |
| 更早的版本，或该 agent 没勾选任何服务 | 回退到 `/mcp/magpie/hub` | **插件**（>10 个工具时） |
| `mcpAgent: all` | `/mcp/magpie/hub` | **插件**（>10 个工具时） |

> 设置页卡片顺序：连接 → 界面增强 → 网页搜索 → MCP 服务 → 模型列表。

**如何确认 MCP 已生效**

1. 勾选并保存后，本卡片标题右侧变为 **已开启**，正文显示 **已连接 · 已注册 N 个工具**（≤10）或 **已连接 · 按需加载（Hub 共 M 个工具）**（>10）。
2. ≤10 个工具时逐个是 `mcp__magpie__<server>__<tool>`；>10 个时为 `mcp__magpie__find_tools` / `mcp__magpie__call_tool`（先 `find_tools` 查，再 `call_tool` 跑）。让模型调用其一，或查看 DSH 的工具列表即可。
3. 想先不保存就验证连通性，点 **测试 MCP** 即可。

### 什么时候需要保存

- **地址和 Key**：点「保存」才生效。
- **网页搜索**：开关即时生效，切换搜索方式或模型后点「保存搜索设置」即可生效。
- **MCP 服务**：勾选/取消即时生效，保存后 Hub 才启动或注销。
- **模型增删**：**自动保存**，不用点任何按钮。

## 常见问题

**模型选择器是空的？**

先确认地址和 Key 都填了并且已经保存，再点「测试连接」。最常见的原因是地址缺了版本段
（比如填成 `http://127.0.0.1:3425`，而应该是 `http://127.0.0.1:3425/v1`）。

**删掉的模型怎么加回来？**

点「获取可用模型」，在弹窗里勾上它再「应用选择」。弹窗列出的是网关当前提供的全部
模型，勾选会**替换**整份列表——只想保留某几个，就只勾那几个。

**网关新加了模型，为什么列表里没有？**

白名单语义：新模型需要你在「获取可用模型」里勾选并应用后才会出现。

**从旧版本升级，我原来的删除记录还在吗？**

在。首次启动会自动把旧的 `hiddenModels`（黑名单）换算成 `enabledModels`（白名单），
只执行一次。若升级时网关不可达、算不出旧列表，则退回「继承网关目录」，不会误删你能用的模型。

> 配置文件位置：从 0.5.0 起写在 `$DSH_HOME/storages/magpie-connect/settings.json`
>（默认 `~/.dsh/storages/magpie-connect/settings.json`）。老版本的
> `~/.dsh-magpie-connect/settings.json` **不迁移、不删除**，只做只读兼容——升级后不改任何文件；
> 你第一次在设置页保存（或删除模型触发自动保存）时，新配置才会写入新位置，同时清掉旧文件。

**为什么我删掉的模型又出现了？**

不应该再出现：删除记录会原样保存（网关某轮没列出它也不会被忘掉），而「获取可用模型」
只改动它这次列出的模型。如果你在**旧版本**上删过模型，那份删除记录可能已被旧逻辑丢掉，
升级后重新删一次即可。

**网关下架了某个模型，列表里为什么还显示？**

现在不会了：点一次「获取可用模型」，本地目录就会同步成网关当前目录，下架的模型随之消失。
如果它仍显示，说明本地目录还停在旧快照上——看列表下方是否报了网关错误。

**改了网关地址，模型列表没变？**

保存后列表会重新拉取。如果新网关暂时不通，会先用本地缓存。

**页面提示「未配置」？**

地址和 Key 缺任意一项都会这样——此时选择器是空的，调用也会直接失败并给出提示。

**发图失败？**

只有网关声明支持图片的模型才能收图。如果给纯文本模型发图，会直接报错而不是静默丢弃。
另外，图片需要通过 harness 的附件服务读取，在没有该服务的组合里也会失败。

## 进阶用法

### 用配置文件代替设置页

除了设置页，也可以在 profile 的 `cordis.patch.yml` 里配置：

```yaml
- id: dsh-magpie-connect
  name: 'dsh-magpie-connect'
  config:
    providerId: dsh-magpie-connect
    displayName: Magpie
    baseUrl: http://127.0.0.1:3425/v1   # 带版本号的完整地址
    apiKey: not-needed           # 网关通常不校验，但必须非空
    refreshSeconds: 300
    maxRetries: 2
    timeoutMs: 300000
    firstEventTimeoutMs: 90000
    idleTimeoutMs: 60000
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `providerId` | `dsh-magpie-connect` | 注册到 DSH 的 provider 名称。 |
| `displayName` | `Magpie` | 模型选择器里的分组名。 |
| `baseUrl` | `http://127.0.0.1:3425/v1` | 带版本号的 API 地址。 |
| `apiKey` | `''`（未配置） | 网关凭据。必填，即使网关不校验——地址有默认值，Key 没有。 |
| `dataDir` | `$DSH_HOME/storages/magpie-connect` | 状态目录（状态快照、设置文件、模型缓存）。默认 `~/.dsh/storages/magpie-connect`；显式指定后不会读写旧目录。 |
| `refreshSeconds` | `300` | 模型目录刷新间隔（秒）。 |
| `maxRetries` | `2` | 遇到 429/5xx 时的连接重试次数。 |
| `timeoutMs` | `300000` | 单次请求的总超时（毫秒）。 |
| `firstEventTimeoutMs` | `90000` | 等待首个上游事件的超时（毫秒）。 |
| `idleTimeoutMs` | `60000` | 上游事件之间的静默超时（毫秒）。 |
| `searchMode` | `'mcp'` | 网页搜索方式：`'mcp'` 沿用 Magpie 自身的代搜模型或 Search API（内置 `/mcp/magpie/web-search`，无需开启资源库 MCP 路由），`'model'` 通过 `/messages` 调用指定模型搜索。 |
| `searchModel` | `''` | `'model'` 搜索模式下使用的 Magpie 模型 ID。 |
| `searchMaxUses` | `5` | `'model'` 搜索模式下单次请求最大 `web_search` 使用次数（1–20）。 |
| `searchTimeoutMs` | `120000` | 单次网页搜索请求的总超时（毫秒）。 |
| `mcpToolCallTimeoutMs` | `120000` | 接入 DSH 的 Magpie MCP Hub 的单次工具调用超时（毫秒）。 |
| `mcpAgent` | `''` | Hub URL 里的 agent 段。**本地网关**下默认用 `dsh`（Magpie 内置的 DSH agent，资源库显示为 DeepSeek Harness），从而由 Magpie 自己按需加载；填其它 id 可改用别的 agent。**远程网关**下忽略此项，固定走全应用地址。 |

优先级：设置页 > `cordis.patch.yml` > 默认值。设置页只覆盖你保存过的字段。

### 工作原理

```
DSH 会话
   │  harness 数据块（block-start / text-delta / usage / finish …）
   ▼
MagpieAdapter（注册为 DSH 的 LlmAdapter）
   │  pi-ai openai-completions 流（默认）/
   │      openai-responses 流（目录选定走 responses 的模型）
   ▼
http://127.0.0.1:3425/v1  ← 按目录的 native_endpoints 与 magpie_prefers 选 chat/completions 或 responses
```

- **模型目录** — 全量接入网关 `GET {baseUrl}/models`，不做付费过滤；磁盘缓存加编译期
  静态快照兜底，网关宕机时选择器仍可用。暴露集合一旦变化（隐藏/显示、换网关地址、
  刷新后模型增删、某个模型换了协议），会发出 `llm/adapters-updated` 让浏览器重读缓存——否则选择器会
  一直显示旧列表直到下次重启。
- **请求协议** — 插件只会说 Chat Completions 和 Responses 两种协议，按目录为每个模型
  选定一种，模型 ID 保持原样、tier 不受影响。网关只公布一种插件支持的 `native_endpoints`
  时直接用它；公布多种时，采用 `magpie_prefers` 指定的那一种，前提是它既是插件支持的、
  也在 `native_endpoints` 之中，否则保持 Chat Completions 优先。`native_endpoints` 为空
  或缺失时，`magpie_prefers` 可以是任一插件支持的协议，缺失或无法识别则回落 Chat
  Completions。若 `native_endpoints` 非空但没有插件支持的协议（例如只有 Anthropic
  Messages），不采用列表之外的偏好，沿用原有的兼容翻译。读取目录时不发送
  `X-Magpie-Drawers`。同一个请求的出站协议与 assistant 历史消息的协议标记一致。
- **思考档位** — 有档位阶梯的模型进入选择器；没有阶梯但可思考的模型保持可思考
  （显式档位直通网关）；`none` 关闭思考，`ultra` 直通网关，不在本地截断。
- **图片** — 带图的请求经 harness 附件服务取字节后上行；文本模型收到图片会直接
  失败（harness 已按模型声明的输入类型做过门控）。
- **输出预算** — 模型目录保留网关声明的最大输出能力；每次请求的默认输出预算沿用
  Magpie 的 DSH 策略，为上下文和压缩保留空间。例如 500,000 上下文、393,216 最大
  输出的模型默认预留 184,464 输出。显式设置的请求输出预算保持原值，读图能力不变。
- **容错** — 启动即注册，目录在后台预热；静默挂起会被看门狗快速判为超时；
  上游截断如实上报，不做自动续写。

运行状态快照写在 `<dataDir>/adapter-status.json`（默认 `~/.dsh/storages/magpie-connect/adapter-status.json`），设置与缓存在同一目录。

## 开发

```sh
pnpm install
pnpm run check          # 类型检查 + 测试 + 构建
pnpm run deploy:local   # 构建并同步到 web profile
```

`lib/` 是提交进仓库的构建产物，所以 profile 安装时不需要现场构建。

发布由 `.github/workflows/release.yml` 负责：把 `package.json` 和
`dsh.plugin.json` 的版本号改成一致后提交推送，流水线会打 tag、建 GitHub Release
并发布到 npm。版本号带 `-`（如 `0.3.0-rc.1`）时自动标记为预发布。

## 许可证

[MIT](./LICENSE)
