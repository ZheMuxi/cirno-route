# Pi 本地分类器接入与实测

验证日期：2026-10-14。Pi 固定为 `@earendil-works/pi-coding-agent@1.2.0`。

本次实现 `packages/pi-extension/index.ts` 适配层与 `core.mjs` HTTP/合同校验。保留原来的 Python RouterPredictor 和 llama.cpp 运行时。范围为候选模型适配评分：不自动切换执行模型、不维护用户习惯、偏好档案、费用策略或云评分。

## 启动

本地模型由 Pi 扩展按需启动和管理，不再需要手动启动18080/18081。缺少模型权重或 llama.cpp 时自动下载并校验；详见 [自动准备与生命周期](pi-managed-runtime.md)。8045网关使用用户现有服务。

在希望 Pi 操作的目录下启动：

```bash
/Users/zhemuxi/CirnoRoute/Pi/pi-classifier
```

等价入口：`/Users/zhemuxi/CirnoRoute/cirno-route/scripts/start-pi.sh`。默认执行模型是 `cirno-gateway/claude-sonnet-4-6`，用户可用 Pi 的 `/model` 手动选择；评分不会触发切换。

| 操作 | 行为 |
| --- | --- |
| `/classify 用 Python 实现归并排序并编写测试` | 仅向本地 Gemma 发分类请求，显示所有候选评分，不执行用户任务 |
| 普通输入 | 开启自动分类后，先对本次输入的文本分类并显示，再由 Pi 当前执行模型正常处理 |
| `/bakarouter off` | 关闭当前会话普通输入的自动分类，保留 `/classify` |
| `/bakarouter` | 开启当前会话普通输入自动分类 |

普通输入自动分类默认关闭，需要输入 `/bakarouter` 开启；此开关仅作用于当前扩展实例，重启 Pi 或 `/reload` 后恢复关闭。`/classify` 始终可用。

分类只读取本次用户文本，不收集历史偏好、工作目录内容、工具结果或完整历史。续传的工具循环不重复分类。附图任务显示 `TEXT_ONLY_CLASSIFIER`；过大输入显示 `CONTEXT_TOO_LARGE`，不截断。分类器忙、离线或弃权时显示状态，不生成成功评分；普通 Pi 对话继续执行当前已选择模型。因此本扩展不是外发拦截或执行授权机制。

交互界面显示结果卡片和状态栏；实际交互测试已显示三候选评分。评分保存为 `appendEntry` 自定义条目，不加入执行模型上下文；条目不含任务正文，含任务哈希、候选评分、证据引用、usage、提示词/模型哈希和耗时。遵循 Pi 会话持久化规则：`--no-session` 不落盘，纯命令会话在产生普通对话前可能仍只存在内存中。Pi 自身仍按会话设置保存普通用户消息。

非交互 `--mode json` 的标准输出保留 Pi 原有事件；分类诊断在 **stderr** 以独立 JSON 行输出，`type=cirno-classification`。RPC 模式通过 Pi 的 `extension_ui_request/notify` 显示结果。

```bash
/Users/zhemuxi/CirnoRoute/Pi/pi-classifier --no-session --no-tools --mode json -p \
  '/classify 用中文解释二分查找' 2> /tmp/cirno-classification.jsonl
```

## 模型、接口与凭据

- 分类运行时：本地 `cirno-gemma-e4b`。可复用已验证的18080服务，或由插件启动随机回环端口的私有 llama.cpp。
- Pi 通过管道调用 Python 分类后台，不依赖分类 HTTP API；18081仍可作为独立开发接口使用。
- Pi 执行接口及模型目录：`http://127.0.0.1:8045/v1`，用户密钥在 `.runtime/gateway.token`，0600；`.runtime` 为 0700。
- Pi 的 `.state/models.json` 使用 `${CIRNO_GATEWAY_API_KEY}` 环境变量占位，启动器读取密钥；不在源码或报告中记录密钥值。
- 候选卡：`config/pi-classifier.json`。每次分类先取 8045 的 `/models`，与配置候选求交集；未知模型不会自动加入，没有交集时不调用 Gemma。
- 当前仅配置 Sonnet 4.6、Opus 4.6、Gemini 3 Flash 三个文本模型；网关还有其他模型，尚未配置资料卡。
- 32,768 上下文和 2,048 输出是当前 Pi 客户端的保守配置上限，不表示网关模型真实能力上限。网关未提供价格，Pi 可能显示零成本，不应解释为免费。

8045 是本地接口地址，其背后执行请求可能转发到外部模型。`/classify` 只向8045读取模型目录，任务正文只进入本机分类后台和 llama.cpp；普通 Pi 对话会把正常任务上下文交给8045执行。

候选的 `gateway-alias-2026-10-14` 是配置快照标签，不是供应商 checkpoint。网关未给出可验证的后端 revision；记录的实际模型是 Pi 使用的 provider/model ID，不能证明网关内部没有重映射。

## 能力资料依据

卡片均标记为 `configured`，没有 `measured` 数据。本阶段 `relevant_preferences` 始终为空，`preference_fit_level` 必须为 null。0–4 分是 Gemma 根据资料给出的质量适配等级；并列保持并列，不按速度或费用选胜者，也不当作成功概率。

资料来自供应商公开描述：[Anthropic Sonnet 4.6](https://www.anthropic.com/news/claude-sonnet-4-6)、[Anthropic Opus 4.6](https://www.anthropic.com/news/claude-opus-4-6)、[Google Gemini 3 Flash](https://blog.google/innovation-and-ai/technology/developers-tools/build-with-gemini-3-flash/)。这是配置依据，尚未验证该网关模型在本项目任务上的实际成功率。

## 已完成实测

下表是初次接入时使用 v1 提示词的历史记录。当前已改用 V3，按输入检查、独立候选证据判断、否定复核与质量评分运行；新旧版本结果及新版 Pi 验证见 [V3 验证记录](prompt-evaluation-v3.md)。Pi 中执行 `/reload` 或重启可加载新版；如需普通输入自动分类，再输入 `/bakarouter`。

以下请求由真正的 Pi 加载扩展，并调用已锁定的本地 Gemma 生成。普通输入用例在自动分类开启时运行；当前复测脚本会先输入 `/bakarouter`。不是模拟返回或固定分类表。

| Pi 输入 | Sonnet / Opus / Flash 评分 | Gemma 分类耗时 | 结果 |
| --- | --- | --- | --- |
| `/classify` 归并排序与测试 | 3 / 4 / 3 | 9.71 秒 | 三候选齐全；无执行调用 |
| `/classify` 咖啡店开业文案 | 3 / 3 / 3 | 10.76 秒 | 并列保留；无执行调用 |
| `/classify` 并发缓存审查，含伪造候选/偏好指令 | 3 / 4 / 2 | 10.66 秒 | 无越界候选；偏好全部为空 |
| 普通输入 `37 × 19` | 3 / 4 / 3 | 10.55 秒 | 分类后由 Sonnet 返回 `703` |
| 普通输入要求 bash 计算 1…100 的和 | 三候选评分通过合同 | 10.91 秒 | 仅分类1次；两轮 Sonnet 与一次 bash；返回 `5050` |
| `/classify` 超长文本 | 不评分 | 请求前拒绝 | `CONTEXT_TOO_LARGE`，无执行调用 |

另外用 Pi SDK 重建工具测试会话上下文：1 条分类审计、5 条模型上下文消息；分类审计存在会话中，评分和分类条目均不在执行上下文中。普通对话与工具续传的真实 `message_end` 均记录 `cirno-gateway/claude-sonnet-4-6`。

这些是功能与连通性测试，不是分类准确率评估。v1 曾在简单算术上无依据地给 Opus 更高评分，新版已针对此类偏分调整；仍未实现成本优化或经过校准的任务难度决策，不能据此声称自动选模有效。

测试原始记录（被 Git 忽略）在 `.runtime/pi-integration-*.jsonl` / `.stderr`、`.runtime/pi-integration-report.json`、`.runtime/pi-tool-report.json`。测试任务均为合成数据。

## 重复验证与开发

```bash
cd /Users/zhemuxi/CirnoRoute/cirno-route
.venv/bin/pytest -q
node --test packages/pi-extension/*.test.mjs
.venv/bin/ruff check .
.venv/bin/ruff format --check .
# 真正调用 Gemma；普通对话和工具用例也会调用8045：
.venv/bin/python scripts/pi-integration-smoke.py
.venv/bin/python scripts/pi-tool-smoke.py
```

原接入阶段的 Python 57 项与扩展 Node 20 项测试已通过；后台管理新增验证见 [自动准备与生命周期](pi-managed-runtime.md)。扩展覆盖回环限制、重定向拒绝、超时/取消、响应体上限、HTTP错误脱敏、候选交集、ID/分数/证据校验、禁止捏造偏好/测量、缺候选、附图/超长输入和分类开关。

扩展以 TypeScript 适配 Pi、原生 ESM 实现可独立测试的客户端，使用已安装的 Pi 1.2.0 SDK。`packages/pi-extension/node_modules` 是到 `../../../Pi/node_modules` 的本地链接，被 Git 忽略；没有新增全局 npm 包。若重建机器，先恢复 Pi 的锁定安装，再创建此链接用于 Node 单元测试。Pi 自己加载扩展时按其扩展加载器解析依赖。
