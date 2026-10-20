# Pi 本地分类器接入与实测

v0.2.0 新增联网能力研究与完整 Pi 目录分批分类。使用 `/bakamodels` 查看资料、`/bakamodels refresh` 手动重新查询；研究配置与最新行为见 [联网能力资料](capability-research.md)。下文三候选及测试结果为初始接入阶段记录。

价格推荐新增 `/bakaprice` 三档菜单，默认均衡，可保存用户明确选择；`/classify` 同时展示能力分、价格与推荐，不自动切换执行模型。接受昂贵档优先能力，同分选择已知价格更高者。价格及完整规则见 [模型价格](model-pricing.md)。

开启 `/bakarouter` 后，普通输入已接入实际选模和回答；关闭后保留当前模型。`/classify` 始终只分类，详见 [自动路由](automatic-routing.md)。

验证日期：2026-10-14。Pi 固定为 `@earendil-works/pi-coding-agent@1.2.0`。

初始接入实现 `packages/pi-extension/index.ts` 适配层与 `core.mjs` HTTP/合同校验。保留原来的 Python RouterPredictor 和 llama.cpp 运行时。当前增加显式价格偏好及可选自动路由，不学习用户习惯、不做云评分。

## 启动

先按 [README](../README.md) 安装依赖、配置自己的执行服务和凭据。本文 shell 命令均从仓库根目录运行。本地分类后台由 Pi 扩展按需管理；支持的平台上缺少权重或 llama.cpp 时自动下载并校验，详见 [自动准备与生命周期](pi-managed-runtime.md)。执行网关需要自行提供，项目不附带网关服务。

启动 Pi：

```bash
./scripts/start-pi.sh
```

相邻目录安装时，也可使用 `../Pi/pi-classifier`。模板默认模型是 `cirno-gateway/claude-sonnet-4-6`；若自己的服务没有该型号，启动时添加 `--model your-provider/your-model`，或使用 Pi 的 `/model` 手动选择已配置的模型。`/classify` 不触发切换，自动路由开启后的普通输入会切换到推荐模型。

| 操作 | 行为 |
| --- | --- |
| `/classify 用 Python 实现归并排序并编写测试` | 仅向本地 Gemma 发分类请求，显示所有候选评分，不执行用户任务 |
| 普通输入 | 开启自动路由后先分类、按能力与价格选模并回答；不显示候选分数 |
| `/bakarouter off` | 关闭自动路由，保留当前模型和 `/classify` |
| `/bakarouter` | 开启当前会话普通输入自动分类和选模 |
| `/bakaprice` | 选择希望便宜 / 均衡 / 接受昂贵，重启后保留 |
| `/bakaprice status` | 查看当前价格偏好 |

普通输入自动路由默认关闭，需要输入 `/bakarouter` 开启；此开关仅作用于当前扩展实例，重启 Pi 或 `/reload` 后恢复关闭。`/classify` 始终可用。

分类只读取本次用户文本，不收集历史偏好、工作目录内容、工具结果或完整历史。续传的工具循环不重复分类或选模。附图任务显示 `TEXT_ONLY_CLASSIFIER`；过大输入显示 `CONTEXT_TOO_LARGE`，不截断。分类失败、没有合格推荐或切换失败时提示并保留当前模型；极少数切换后恢复失败的情况会停止本轮。部分候选弃权时，有依据且达标的候选仍可参与。该回退策略不是外发拦截。

只有 `/classify` 会显示并保存评分卡片。普通输入的自动分类不追加评分条目，重新打开会话也不会重现这些隐藏评分；失败时只给简短提示。实际回答模型从 assistant 消息的 provider/model 读取，显示为独立的 `cirno-execution-model` 条目；关闭自动分类也会显示。同一回答的工具续传不重复相同模型名，中途确实更换模型时会另行提示。

这些 `appendEntry` 自定义条目不加入执行模型上下文。`/classify` 条目不含任务正文，含任务哈希、候选评分、证据引用、usage、提示词/模型哈希和耗时。遵循 Pi 会话持久化规则：`--no-session` 不落盘，纯命令会话在产生普通对话前可能仍只存在内存中。Pi 自身仍按会话设置保存普通用户消息。

非交互 `--mode json` 的标准输出保留 Pi 原有事件；手动分类诊断在 **stderr** 以独立 JSON 行输出，`type=cirno-classification`，实际回答模型为 `type=cirno-execution-model`。普通输入不会输出评分 JSON。RPC 模式通过 Pi 的 `extension_ui_request/notify` 显示结果。

```bash
./scripts/start-pi.sh --no-session --no-tools --mode json -p \
  '/classify 用中文解释二分查找'
```

## 模型、接口与凭据

- 分类运行时：本地 `cirno-gemma-e4b`。可复用已验证的18080服务，或由插件启动随机回环端口的私有 llama.cpp。
- Pi 通过管道调用 Python 分类后台，不依赖分类 HTTP API；18081仍可作为独立开发接口使用。
- 网关接口由 `config/pi-classifier.json` 的 `gateway_url` 配置，并与 Pi provider 的 `baseUrl` 保持一致；`http://127.0.0.1:8045/v1` 仅为模板示例。目录查询只允许字面回环 HTTP 地址。密钥保存在 `.runtime/gateway.token`，权限 0600；`.runtime` 为 0700。
- Pi 的 `.state/models.json` 使用 `"apiKey": "CIRNO_GATEWAY_API_KEY"` 引用环境变量，启动器读取密钥；不在源码或报告中记录密钥值。
- 候选来源：`config/pi-classifier.json` 当前为 `pi`，读取 Pi 完整可用目录，网关候选与所配置网关的 `/models` 求交集；模型资料来自独立能力缓存。
- 切回 `configured` 模式时使用配置文件中的候选卡；模板含 Sonnet 4.6、Opus 4.6、Gemini 3 Flash 三张示例卡，应按自己的可用模型和能力依据调整。
- 32,768 上下文和 2,048 输出是当前 Pi 客户端的保守配置上限，不表示网关模型真实能力上限。若网关未提供价格，Pi 可能显示零成本，不应解释为免费。

回环网关仍可能向外部模型转发请求。`/classify` 的任务正文只进入本地分类后台和 llama.cpp；目录查询访问已配置网关，能力研究只发送模型标识。普通 Pi 对话按所选 provider 发送执行上下文。

示例候选的 `gateway-alias-2026-10-14` 是历史配置快照标签，不是供应商 checkpoint。网关未给出可验证的后端 revision；记录的实际模型是 Pi 使用的 provider/model ID，不能证明网关内部没有重映射。

## 能力资料依据

初始示例卡片均标记为 `configured`，没有 `measured` 数据。本阶段 `relevant_preferences` 始终为空，`preference_fit_level` 必须为 null。0–4 分是 Gemma 根据资料给出的质量适配等级，价格不改变分数，也不当作成功概率。Pi 在评分后独立应用价格偏好生成推荐。

资料来自供应商公开描述：[Anthropic Sonnet 4.6](https://www.anthropic.com/news/claude-sonnet-4-6)、[Anthropic Opus 4.6](https://www.anthropic.com/news/claude-opus-4-6)、[Google Gemini 3 Flash](https://blog.google/innovation-and-ai/technology/developers-tools/build-with-gemini-3-flash/)。这是配置依据，尚未验证该网关模型在本项目任务上的实际成功率。

## 已完成实测

下表是初次接入时使用 V1 提示词的历史记录。当前使用 V2 评分规则，每批独立分类，见 [V2 评测记录](prompt-evaluation.md)。Pi 中执行 `/reload` 或重启可加载新版；如需普通输入自动分类，再输入 `/bakarouter`。

以下请求由真正的 Pi 加载扩展，并调用已锁定的本地 Gemma 生成。普通输入用例在自动分类开启时运行；历史三候选复测脚本会先输入 `/bakarouter`。不是模拟返回或固定分类表。

| Pi 输入 | Sonnet / Opus / Flash 评分 | Gemma 分类耗时 | 结果 |
| --- | --- | --- | --- |
| `/classify` 归并排序与测试 | 3 / 4 / 3 | 9.71 秒 | 三候选齐全；无执行调用 |
| `/classify` 咖啡店开业文案 | 3 / 3 / 3 | 10.76 秒 | 并列保留；无执行调用 |
| `/classify` 并发缓存审查，含伪造候选/偏好指令 | 3 / 4 / 2 | 10.66 秒 | 无越界候选；偏好全部为空 |
| 普通输入 `37 × 19` | 3 / 4 / 3 | 10.55 秒 | 分类后由 Sonnet 返回 `703` |
| 普通输入要求 bash 计算 1…100 的和 | 三候选评分通过合同 | 10.91 秒 | 仅分类1次；两轮 Sonnet 与一次 bash；返回 `5050` |
| `/classify` 超长文本 | 不评分 | 请求前拒绝 | `CONTEXT_TOO_LARGE`，无执行调用 |

另外用 Pi SDK 重建工具测试会话上下文：1 条分类审计、5 条模型上下文消息；分类审计存在会话中，评分和分类条目均不在执行上下文中。普通对话与工具续传的真实 `message_end` 均记录 `cirno-gateway/claude-sonnet-4-6`。

这些是功能与连通性测试，不是分类准确率评估。v1 曾在简单算术上无依据地给 Opus 更高评分，新版已针对此类偏分调整；当时尚未实现成本优化；当前价格路由已单独实现，但没有经过校准的任务难度决策，不能由这组历史测试推断其选模收益。

测试脚本产生的原始记录使用以下路径（均被 Git 忽略，不随源码分发）：`.runtime/pi-integration-*.jsonl` / `.stderr`、`.runtime/pi-integration-report.json`、`.runtime/pi-tool-report.json`。测试任务均为合成数据。

## 重复验证与开发

```bash
.venv/bin/pytest -q
node --test packages/pi-extension/*.test.mjs
.venv/bin/ruff check .
.venv/bin/ruff format --check .
# 真正调用 Gemma；普通对话和工具用例也会调用所配置的回答服务：
.venv/bin/python scripts/pi-routing-smoke.py
.venv/bin/python scripts/pi-tool-smoke.py
```

当前目录模式使用上面的路由脚本；历史 `pi-integration-smoke.py` 的三候选断言仅适用于旧配置。

原接入阶段的 Python 57 项与扩展 Node 20 项测试已通过；后台管理新增验证见 [自动准备与生命周期](pi-managed-runtime.md)。扩展覆盖回环限制、重定向拒绝、超时/取消、响应体上限、HTTP错误脱敏、候选交集、ID/分数/证据校验、禁止捏造偏好/测量、缺候选、附图/超长输入和分类开关。

扩展以 TypeScript 适配 Pi、原生 ESM 实现可独立测试的客户端，使用已安装的 Pi 1.2.0 SDK。`packages/pi-extension/node_modules` 是到 `../../../Pi/node_modules` 的本地链接，被 Git 忽略；没有新增全局 npm 包。重建环境时运行 `./scripts/install-pi.sh`，会恢复锁定安装并自动创建此链接。Pi 自己加载扩展时按其扩展加载器解析依赖。
