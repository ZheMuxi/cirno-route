# CirnoRoute · 本地模型分类与 Pi 自动路由

CirnoRoute 使用本地 Gemma 4 E4B 分析任务与候选模型资料，再结合用户明确选择的价格偏好，为 Pi 选择回答模型。也可以单独使用 CLI、Python 接口或本地 HTTP API，只获取分类结果。

当前版本为 **v0.5.0**。可以指定哪些文件只能交给本地或可信模型，并在查询模型能力时同步官方 API 参考价。分类器继续使用 Gemma 4 E4B、0–4 分制和 V2.1 评分标准，默认由插件内置的 `node-llama-cpp` 运行。功能与升级说明见 [v0.5.0 版本说明](releases/v0.5.0.md)。

## 主要功能

- **本地分类**：保留任务、能力依据和全部候选，使用紧凑协议分批评分；资料不足的候选保留未知状态。
- **能力与价格查询**：分类前查询并缓存候选模型的公开能力及价格资料；支持更换研究模型和手动刷新。有效价格在同轮推荐中使用，本地推理的 API 费用按 0 计算。
- **价格偏好**：希望便宜、均衡、接受昂贵。Gemma 接收独立的紧凑价格表，能力仍按 0–4 分评估；程序结合能力分和价格偏好完成选模。
- **Pi 自动路由**：开启后根据能力与价格选模回答；普通对话隐藏评分，显示实际回答模型。
- **独立分类**：`/classify` 只显示评分与推荐，不切换模型，也不执行任务。
- **后台管理**：Pi 扩展按需准备模型与 llama.cpp，并管理自己启动的后台进程。
- **习惯路由**：手动选择及 Gemma 路由成功使用累计到默认 5 次后，允许 E5 匹配同类任务直接复用模型；命中不再强化，可随时关闭。
- **文件保护**：指定文件或目录后，按本地规则限制可用模型；没有许可模型时拦截，价格与习惯不能解除限制。
- **路由可靠性改进**：缺少任务材料时暂停自动回答，失败通道短暂冷却；已学习的多语言代表样本保留更久，相同输入可跳过 E5 编码。详见 [自动路由](docs/automatic-routing.md)和[习惯路由](docs/task-habits.md)。
- **首次跨语言复用**：E5 找到近邻但未达直接匹配门槛时，可用现有 Gemma 简短核验类型、难度和全部要求；通过后跳过全候选评分，进程内缓存支持同一输入再次直接复用。工具与严格 JSON 要求改为逐项判断。

## 环境要求

| 组件 | 要求 |
| --- | --- |
| Python | 3.12 或更高版本 |
| Python 依赖管理 | uv |
| Node.js | 22.19.0 或更高版本，附带 npm |
| Git | 用于克隆与切换版本 |
| Pi | 安装脚本按锁文件安装 1.2.0 |
| 本地推理 | 默认使用锁定的 node-llama-cpp 原生包与 Gemma GGUF，保留 llama-server 后端 |
| 执行模型 | 用户自行提供可用的 API 服务、模型配置和凭据 |
| 联网研究 | 默认使用 DeepSeek 搜索与研究接口，需要相应凭据和网络连接 |

目前 llama.cpp 自动下载清单提供 **macOS arm64 / x64** 安装包，真实本地推理主要在 Apple Silicon 上验证。其他平台需要自行准备匹配的运行时，尚未完整验证；下面的启动脚本使用 POSIX shell。

默认权重为 `HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive:Q4_K_M`，约 5.34 GB。这是 Gemma 的衍生权重，不是 Google 官方原始 checkpoint。下载版本与 SHA-256 固定在 [运行时清单](src/cirno_route/resources/local-runtime-v1.json)，另需预留运行时、缓存及推理内存。

## 安装

选择任意有写权限的工作目录。当前 Pi 启动入口依赖以下相邻目录结构，请保留源码目录名 `cirno-route`：

```text
workspace/
├── cirno-route/    # 本仓库
└── Pi/            # 安装脚本创建，保存 Pi 及本机配置
```

```bash
mkdir -p workspace
cd workspace
git clone https://github.com/ZheMuxi/cirno-route.git
cd cirno-route
uv sync --frozen --python 3.12
./scripts/install-pi.sh
.venv/bin/cirno-route init
```

`install-pi.sh` 将 Pi 安装到 `../Pi`，并按锁文件安装插件内的原生推理依赖；已有配置和会话会保留。首次安装会复制不含密钥的模型配置模板，其中只提供本地 HTTP 模型入口，执行模型需自行配置。`init` 只生成本地服务令牌，不下载模型、不生成供应商 API 密钥。

## 配置自己的模型服务

仓库不包含供应商账户，也不要求额外部署模型网关。请将有权调用的执行模型及其认证配置到 Pi；分类器从 Pi 可用目录获取候选。

| 配置文件 | 需要配置的内容 |
| --- | --- |
| `../Pi/.state/models.json` | Pi 执行模型的 provider、模型 ID、API 类型、服务地址及凭据引用；模板见 [models.example.json](tooling/pi/models.example.json) |
| `config/pi-classifier.json` | 候选来源、分批上限、价格文件路径及本地零价模型绑定；默认 `candidate_source: "pi"`、`candidates: []` |
| `config.json` | 本地分类设置、研究模型、搜索接口及凭据来源 |
| `config/model-prices.json` | 手动价格基础表；按完整 `provider/model` 配置价格、来源和有效期，自动查询不覆盖此文件 |
| `.runtime/model-prices.researched.json` | 联网查询后自动保存的价格资料，不进入 Git |

### 执行模型

在 Pi 中配置实际执行模型的 provider、模型 ID、API 类型、地址及凭据引用。默认分类配置不含网关地址、网关密钥或备用候选卡；`pi` 模式直接读取 Pi 的可用模型目录。

安装模板只保留 `cirno-local/cirno-gemma-e4b` 的本地 HTTP 入口。该入口需要对应的本地 HTTP 服务，内置 `node-llama-cpp` 分类后台不会为它提供对话接口。若使用云端模型回答，应先在 Pi 中配置相应供应商与认证。

启动脚本沿用 Pi 已保存的默认模型，不再强制指定网关模型。首次配置后可通过 Pi 的 `/model` 选择执行模型，也可在启动时明确指定：

```bash
./scripts/start-pi.sh --model your-provider/your-model
```

认证使用 Pi 支持的环境变量或本地凭据引用，不要把真实密钥写进受 Git 跟踪的 JSON 或脚本。

如需兼容旧 `cirno-gateway` 服务，可自行添加该 provider，并在分类配置中同时填写 `gateway_url` 和 `gateway_token_file`；该 provider 的候选会与网关 `/models` 求交集。地址需与 Pi 的 `baseUrl` 一致，目录查询仅支持字面回环 HTTP 地址（`127.0.0.1` 或 `[::1]`）。网关属于可选高级配置，启动脚本不会读取或注入其密钥，Pi 的执行认证需另行配置。

### 联网能力研究

默认研究模型 ID 为 `deepseek-flash`。模型整理与搜索分别配置，可调整 `config.json` 中的 `capability_research`，详见 [能力资料查询](docs/capability-research.md)。

能力查询同时查询价格，并分别检查证据；价格优先从已获取的官方表格按型号、表头和单位直接提取，不依赖研究模型改写后的引文。首次分类准备资料和 `/bakamodels refresh` 都会同步价格；`/bakamodels` 只读本地状态，不联网、不写文件。有效的 `source: "user"` 手动价格优先于查询结果；未查到或已过期的价格不当作免费。云模型统一按对应厂商的官方 API 参考价参与路由，OpenCode Go 也采用这一口径，不采用套餐额度或套餐折扣；明确登记的本地运行模型 API 费用为 0。参考价用于选模，不代表服务商实际账单。配置方式见 [模型价格](docs/model-pricing.md)。

本地零价需要在 `config/pi-classifier.json` 的 `local_price_models` 中明确绑定模型和回环地址，并与 Pi 当前执行模型地址一致；已在文件保护中登记为本地的模型也可提供此绑定。仅使用本机代理地址不代表本地推理，价格登记也不授予受保护文件访问权限。这里的 0 只表示 API token 费用，不包含硬件和电费。

默认配置从环境变量 `DEEPSEEK_API_KEY` 读取凭据，也可以从 `../Pi/.state/deepseek.token` 读取。更换研究模型时，应分别核对模型接口与搜索接口的凭据；执行模型的认证与研究模型的认证也需要各自配置。

建议通过不回显输入保存密钥，避免把值写入命令历史。以下示例供首次配置时手动运行，会写入对应本机文件：

```bash
.venv/bin/python - <<'PYKEYS'
import getpass
from pathlib import Path

for label, filename in [
    ("DeepSeek research/search API key: ", "../Pi/.state/deepseek.token"),
]:
    key = getpass.getpass(label).strip()
    if not key:
        raise SystemExit("Empty key; configuration stopped.")
    path = Path(filename)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    path.write_text(key + "\n")
PYKEYS
```

不使用联网研究且需要旧的固定候选流程时，可关闭 `capability_research.enabled`，将 `candidate_source` 改为 `configured`。该兼容模式要求自行填写 1–8 张候选卡及其证据，并同时配置完整的 `gateway_url`、`gateway_token_file` 和对应 Pi 模型；不能只切换标志而保留空候选。此模式只使用配置中的候选，不会研究完整 Pi 模型目录。

## 启动与使用

完成配置后，在仓库根目录启动：

```bash
./scripts/start-pi.sh
```

保持上述目录结构时，也可使用 `../Pi/pi-classifier`。首次有效分类会检测并准备 Gemma 和 llama.cpp；**使用 Pi 插件时，不需要另开终端启动本地分类服务**。后续分类复用后台进程，退出或重载 Pi 时回收插件自己启动的进程。

| Pi 命令 | 行为 |
| --- | --- |
| `/classify 任务内容` | 只分类，查看全部候选的评分和推荐 |
| `/bakamodels` | 只读查看能力缓存与价格状态，不联网、不写文件 |
| `/bakamodels refresh` | 主动重新联网查询模型能力与价格，更新本地资料 |
| `/bakaprice 希望便宜` | 在能力达标的候选中优先低价 |
| `/bakaprice 均衡` | 能力差距较小且节省明显时选择便宜模型 |
| `/bakaprice 接受昂贵` | 优先能力，同分选择已知价格更高的模型 |
| `/bakaprice status` | 查看当前价格偏好 |
| `/bakarouter` | 开启普通输入的自动选模与回答 |
| `/bakarouter off` | 关闭自动路由，保留当前模型 |
| `/bakarouter status` | 查看自动路由状态和暂时冷却的模型 |
| `/bakahabits status` | 查看习惯学习、默认 5 次门槛及记录数量 |
| `/bakahabits off` / `on` | 关闭或开启习惯学习与语义匹配 |
| `/bakahabits threshold 5` / `clear` | 调整门槛或清空习惯记录 |
| `/bakaprivacy add <路径>` / `remove <路径>` | 添加或移除文件、目录保护规则 |
| `/bakaprivacy local provider/model` / `trust provider/model` | 登记本地或可信执行模型，绑定当前端点 |
| `/bakaprivacy revoke provider/model` / `status` | 撤销模型许可或查看保护状态 |

自动路由每次启动默认关闭，价格偏好跨重启保留。每轮用户输入只选一次模型，工具续传沿用该模型。关闭自动路由后可用 Pi 的 `/model` 手动更换模型。修改扩展后重启 Pi 或 `/reload`，然后按需再次开启路由。

升级到能力与价格联合查询后，建议重启 Pi，再执行 `/bakamodels refresh`。研究提示词变化会使旧缓存自然失效，首次可能需要重新查询较多型号；之后继续复用有效缓存。仅更新价格核对日期、来源或备注不会重置习惯；只有当前候选的有效价格、计费状态等影响选模的数据变化，才切换习惯适用范围。

文件保护独立于自动路由开关。初始没有保护路径或可信执行模型；应先配置路径和许可模型，再读取敏感文件。本机地址可能是云模型代理，不会被自动视为本地推理，插件内置的 Gemma 分类器也不会自动成为回答模型。会话涉及受保护文件后，后续内容仍受相同限制；存在规则时，不可信模型的 shell、目录遍历及未知工具会被保守拦截。完整命令、会话范围和适配限制见 [文件保护说明](docs/file-privacy.md)。

默认后端的原生依赖安装在插件目录内，直接加载同一份 Gemma GGUF，不启动 `llama-server` 或监听推理端口。已有安装升级时可单独补装：

```bash
./scripts/install-native-runtime.sh
./scripts/install-semantic-runtime.sh
./scripts/start-pi.sh
```

`start-pi.sh` 默认使用原生后端，`start-pi-native.sh` 保留为明确选择原生后端的入口。切回插件管理的 `llama-server` 时，退出 Pi 后运行 `./scripts/start-pi-llama.sh`。新后端保留 Python 分类校验与能力研究，不自动迁移用户配置；依赖、限制及验证见 [插件内置原生后端](docs/native-runtime.md)。

## 独立 CLI 与本地 HTTP API

无需 Pi 即可先运行规则基线，检查输入输出格式；此命令不启动模型：

```bash
.venv/bin/cirno-route classify examples/coding.json --rules
```

若要独立使用真实 Gemma 分类，需要先准备与 [运行时清单](src/cirno_route/resources/local-runtime-v1.json) 匹配的 `llama-server` 和权重缓存。下面的手动启动脚本使用 `--offline`，不会负责首次下载：

```bash
# 终端 1：在仓库根目录启动 llama.cpp
./scripts/start-llama.sh
```

```bash
# 终端 2：同样在仓库根目录；首次使用或更新运行时后重新锁定
.venv/bin/cirno-route lock-model
.venv/bin/cirno-route classify examples/coding.json
# 可选：启动本地 HTTP 分类 API
./scripts/start-api.sh
```

默认 llama.cpp 地址为 `127.0.0.1:18080`，HTTP 分类 API 为 `127.0.0.1:18081`。已存在兼容服务时不要重复占用同一端口。

API 的所有路径均需要 `Authorization: Bearer <token>`，分类 API 令牌由 `init` 保存在 `.runtime/api.token`，llama.cpp 使用独立的 `.runtime/llama.token`。`POST /v1/classify` 接受与 CLI 相同的 JSON 输入；`GET /health` 仅表示进程存活。这个 API 只分类，不执行任务。

## 输入、输出与限制

输入示例见 [examples/coding.json](examples/coding.json)，结构定义见 [contracts/](contracts/)。示例中的 `demo_*` 候选是合成资料，不是已配置的真实执行模型。

- `task.text` 是当前任务，`requirements` 是本轮明确要求。
- `eligible_candidates` 提供候选标识、能力及证据；候选 ID 和证据引用会经过校验。
- `relevant_preferences` 默认空；用户习惯由 Pi 扩展在本地独立管理，不注入候选能力评分或联网研究。
- 输出包含候选质量等级、证据引用、不确定性类别及弃权状态。质量等级 0–4 不是任务成功概率。
- 独立请求最多 8 个候选；Pi 目录按批次处理，实际 token 预算不足时继续拆分，不静默删候选或截断资料。
- 价格按固定工作量比较，并区分官方价、网关参考价、未知及过期价格；不估算整轮实际账单。

本版在同一次分类生成中先检查任务材料；判为缺失或目标不明时，所有候选保留未知分并暂停自动回答。材料判断仍由 Gemma 完成，不能保证识别所有省略输入或语义错误；跨批次及不同运行时的评分也尚未校准。联网资料可能整理错误。首次联网准备、模型加载、分类和远端回答均会增加等待时间，不保证固定延迟。

## 数据与凭据

- 用户任务在本地 Gemma 中分类；能力研究只发送模型标识，不发送任务正文或会话。
- 开启实际路由后，Pi 会把执行任务及相应会话上下文发送给选中的回答模型。
- 文件保护规则限制相关请求只能发送给允许的模型；规则和会话保护标记保存在本机 `.runtime/file-privacy.json`，不保存文件正文或密钥。
- `.runtime/` 保存本地令牌、模型锁、下载缓存、研究资料和运行日志；Pi 私有配置与会话位于仓库外的 `../Pi/.state/`。
- 密钥、权重、会话及运行日志不应提交。仓库通过 `.gitignore` 排除 `.runtime/`、`*.token`、`*.gguf` 等本机文件；受版本管理的配置仅使用凭据引用。

## 开发与验证

安装依赖后，在仓库根目录运行：

```bash
.venv/bin/pytest -q
node --test packages/pi-extension/*.test.mjs
.venv/bin/ruff check .
.venv/bin/ruff format --check .
```

自动化测试不下载模型，GitHub CI 运行上述检查。真实模型评测与 Pi 集成脚本需要额外的本机运行时和服务凭据；结果仅用于检验对应场景，不能当作普遍的质量或成本保证。

## 文档与版本

- [模型能力查询](docs/capability-research.md)
- [分类提速与上下文压缩](docs/classifier-speed.md)
- [模型价格与三档偏好](docs/model-pricing.md)
- [Pi 自动路由与失败处理](docs/automatic-routing.md)
- [本地模型自动准备及生命周期](docs/pi-managed-runtime.md)
- [本地语义匹配与习惯路由](docs/task-habits.md)
- [受保护文件与可信模型](docs/file-privacy.md)
- [v0.5.0 版本说明](releases/v0.5.0.md)
- [v0.4.0 历史版本说明](releases/v0.4.0.md)
- [v0.3.0 历史版本说明](releases/v0.3.0.md)
- [v0.2.0 历史版本说明](releases/v0.2.0.md)
- [变更记录](CHANGELOG.md)
- [版本管理与回退](docs/versioning.md)

仓库：[ZheMuxi/cirno-route](https://github.com/ZheMuxi/cirno-route)。项目版本与提示词版本独立编号；固定发布标签保留源码、提示词和依赖版本，可用于回退。部分专题文档记录早期环境下的实测过程，新安装请以本页的通用流程为准。
