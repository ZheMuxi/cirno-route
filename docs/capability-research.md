# 联网能力资料与本地分类

Pi 从 v0.6.0 起使用自动榜单并按缺项补查。下文记录四分制能力卡与研究服务的配置方式。[当前榜单评分与命令](benchmark-routing.md)

本功能随 v0.2.0 发布，能力资料与评分校准仍处于试验阶段。v0.4.0 继续使用 Gemma 4 E4B Q4_K_M、V2.1 评分标准、0–4 分与每批一次推理。当前工作区支持在能力研究时同步查询价格，开启 `/bakarouter` 后用于 [实际路由](automatic-routing.md)。能力查询不学习习惯；独立的本地扩展见 [习惯路由](task-habits.md)。

## 四分制能力卡的使用方式（旧版）

先按 [README](../README.md) 安装依赖并配置执行服务、研究服务及凭据。以下 shell 命令从仓库根目录运行。启动 Pi，或在已打开的 Pi 中执行 `/reload`：

```bash
./scripts/start-pi.sh
```

| 命令 | 行为 |
| --- | --- |
| `/classify 用 Python 实现归并排序并写测试` | 准备缺失/过期的能力与价格资料，再由本地 Gemma 分批评分，同轮使用有效新价格推荐；不执行这项编程任务 |
| `/bakarouter` | 开启普通输入前分类、按能力与价格选模并回答 |
| `/bakarouter off` | 关闭自动路由，保留当前模型 |
| `/bakamodels` | 只读查看当前候选的能力缓存、目录及价格状态，不联网、不写文件 |
| `/bakamodels refresh` | 用户主动重新查询全部当前候选的能力与价格，忽略有效缓存；保留旧资料快照 |

首次查询覆盖 Pi `modelRegistry.getAvailable()` 提供的候选；同一 provider/model 去重并使用稳定 ID。默认 `candidate_source: "pi"`、`candidates: []`，无需网关配置。当前目录已删除 `cirno-gateway`；只有用户另行接入该兼容 provider 时，才需配置 `gateway_url`、`gateway_token_file`，并将其候选与对应 `/models` 求交集。Pi 目录中的“可用”表示有相应认证配置，不代表本功能逐个付费调用执行模型、检查余额或验证服务真实后端。

默认最多接受 128 个目录条目，worker 请求体上限为 60,000 UTF-8 字节，不静默截掉超出的模型。项目配置每次本地请求最多 8 个候选、30,000 UTF-8 字节。Pi 默认每批最多 8 个，先按 28,000 字节预算拆分；紧凑传输后由 llama.cpp 检查实际 token 数，超出 8K 上下文预算的批次继续二分。任务和单张卡片不截断。每批只发送当前任务和这一批资料，没有聊天历史，Gemma 进程保持加载。排序和分组固定，减少目录顺序变化的影响，但不保证跨批评分一致性或消除 V2 的语义问题。压缩方式、回退开关与实测见 [分类提速](classifier-speed.md)。

## 流程与数据

1. 读取候选的 provider、model ID、展示名称。目录中的密钥、服务 URL、其他字段不会交给研究模型。
2. 查找有效缓存。新候选、过期、研究模型/端点/提示词改变时重新研究；默认有效期 7 天，未确认型号的查询结果保留 1 小时。价格缺失或过期时可单独重查价格，保留仍有效的能力资料。
3. 对每个需更新的型号调用 DeepSeek Search，优先在可识别厂商的官方站点搜索。OpenCode Go 使用明确的型号映射查找模型厂商 API 定价，不查询套餐额度来代替单价。完整研究时能力与价格各搜索 1 次，并行进行，每次默认最多 3 个结果，随后共同整理 1 次；型号研究并发为 2。未识别的渠道或型号仍可查能力，价格保留未知或使用手动配置、本地绑定。没有可用来源时不调用整理模型。
4. `deepseek-flash` 整理编程、推理、数学、写作、翻译、结构提取、长文理解、视觉、工具调用九个维度，同时单独整理价格及计费方式，分别记录来源引用。
5. 检查 JSON、维度、型号状态和等级，确认能力及价格引用都属于实际获取的来源。价格优先按准确型号、表头、单位和计价档位直接从官方表格提取；研究模型改写引文时仍先核对原始表格，冲突或不明确的价格保持未知。能力和价格分别校验，价格不明不丢弃有效能力卡片；无法确认型号能力的候选仍保留未知，不给适配分。
6. Pi 将有效价格原子同步到 `.runtime/model-prices.researched.json`，与手动价格及明确登记的本地零价合并。将有依据的能力卡片压缩成 Gemma 候选证据，同时附带独立的紧凑价格表，只包含候选 ID、USD 每百万 token 单价、状态与计价依据。价格不作为能力证据；全文、网址和详细记录保留在缓存。联网整理仍标为 `configured`，不会冒充本地 `measured` 成功率。
7. Gemma 仍按任务能力评分，程序再按本轮评分和价格偏好推荐。`/classify` 不需要第二次运行才能使用刚查到的价格；每批的价格表与能力资料共用一次推理，并计入上下文预算，超限继续拆批。

研究等级 0–4 描述来源材料支持的能力范围，未知为 null；本地 Gemma 的适配分另针对当前任务生成，两者不是同一个分数。网页和模型整理结果仍可能出错，存在有效引用不等于引用必然支持全部语义结论。

模型能力查询不会接收分类任务正文、历史会话、仓库文件或用户习惯。普通 Pi 对话由当前执行模型运行；开启自动路由后，扩展会在回答前更换为本轮选中模型，Pi 按原有会话与工具流程发送执行上下文。

## 自定义研究模型

编辑项目根目录 `config.json` 中的 `capability_research`，然后重启 Pi：

```json
{
  "enabled": true,
  "model": "deepseek-flash",
  "base_url": "https://api.deepseek.com/v1",
  "api_key_env": "DEEPSEEK_API_KEY",
  "api_key_file": "../Pi/.state/deepseek.token",
  "search_base_url": "https://api.deepseek.com/v1/tools",
  "search_api_key_env": "DEEPSEEK_API_KEY",
  "search_api_key_file": "../Pi/.state/deepseek.token",
  "cache_dir": ".runtime/model-capabilities",
  "ttl_hours": 168,
  "unknown_ttl_hours": 1,
  "concurrency": 2,
  "search_count": 3,
  "timeout_seconds": 60.0
}
```

`deepseek-flash` 是官方提供 DeepSeek-V4.1-Flash 的 API ID；官方可能更新该别名对应的版本，缓存同时记录响应中的型号。研究模型可以换成支持 Chat Completions 和 JSON object 输出的兼容服务。`base_url` 应包含该服务的 API 前缀，例如 `/v1`；不追加 `/chat/completions`。

搜索当前使用 DeepSeek Search 协议，独立于整理模型。更换整理模型时，只改 `model/base_url/api_key_*`，保留 DeepSeek 的 `search_*` 凭据；不会自动将另一个服务的密钥转发给 DeepSeek。环境变量非空时优先于密钥文件；密钥只存本地文件/环境变量，不写入配置或 Git。路径相对于 `config.json` 解析。远程服务要求 HTTPS，本地兼容服务允许字面回环 HTTP；不继承代理或跟随重定向。

此模型的调用费用、搜索费用由用户的服务账户承担。每次 `/bakamodels refresh` 会重新调用，不承诺固定价格。能力卡片不包含速度/价格带来的任务质量加减分。

仅补查价格时使用 1 次价格搜索和最多 1 次价格整理，不重新生成能力卡片。未查到可核实价格默认等待 1 小时后再尝试；网络或格式错误按失败重试间隔等待，默认 300 秒。`/bakamodels refresh` 可主动绕过等待，`/bakamodels` 不触发这些请求。

候选执行价格分为手动基础表 `config/model-prices.json` 和自动表 `.runtime/model-prices.researched.json`；路径分别由 `config/pi-classifier.json` 的 `pricing_file`、`researched_pricing_file` 配置。自动查询不覆盖手动表，有效的 `source: "user"` 优先。首次准备资料及 `/bakamodels refresh` 同步价格，单独修改价格或价格偏好不要求重查能力缓存。`/bakaprice` 可选择三档价格偏好，规则见 [模型价格](model-pricing.md)。

本机运行模型通过 `local_price_models` 或文件保护中的本地模型登记，绑定当前 Pi 模型与回环端点后，API token 费用为 0；回环云代理不自动算本地。OpenCode Go 与其他云模型统一按对应厂商的官方 API 参考价参与路由，不采用套餐额度或折扣。参考价保存基准厂商、型号和官方来源，用于选模比较，不代表实际账单；未能核实的价格保留未知。

`config/pi-classifier.json` 的 `research_names` 可为 `provider/model` 指定明确的查询名称。模板为本地 Gemma 指定完整 HauhauCS Aggressive checkpoint，避免查询时误当成 Google 官方原版；这只是查询标识，仍需来源支持才能使用。未知网关后缀必须有包含该别名的资料，不能继承基础模型的分数。

## 失败、缓存与追溯

缓存目录默认 `.runtime/model-capabilities/`，记录：

- 候选标识、研究模型、响应型号、查询时间、失效时间、研究提示词哈希；
- 各维度能力、独立的价格资料、引用 ID、来源 URL、来源日期及实际提供给模型的资料摘录；
- 模型报告的 token usage；不保存 API 密钥、分类任务或用户偏好。

当前记录按查询配置哈希索引；`snapshots/<record_sha256>.json` 保留不可覆盖的内容快照。`/classify` 条目保存 `record_sha256` 和来源 URL，可以追溯具体采用哪版资料。普通对话不保存或显示评分条目，但资料缓存仍然复用。目录为 0700，文件为 0600，原子替换；`.runtime/` 被 Git 忽略。

本次改为官方 API 参考价时，尽量迁移仍有效的能力缓存，只重查不符合新口径的价格；旧套餐参考价不会直接参与比较。建议重启 Pi，再执行 `/bakamodels refresh` 主动更新全部资料；日常首次分类也会补齐需要更新的价格。价格资料有独立证据和有效期；查询失败会保留仍有效、符合当前口径的旧价，不延长其有效期，过期或无效价格不参与比较。仅更新日期、来源或备注不会重置习惯；当前候选的有效价格、计费状态等影响选模的数据变化才切换习惯适用范围。价格始终不进入 Gemma 的能力证据。

未知型号显示弃权，同时保留其他有依据候选的评分。网络或格式失败不伪造资料、不写成功缓存；手动刷新失败时继续保留尚未过期的旧记录，并报告失败。已过期记录不参与评分。401/403/429 会阻止本轮尚未开始的请求继续外发。刷新与分类不能在同一 Pi 扩展里重叠；取消或退出 Pi 会终止该扩展拥有的 worker。

没有有效旧资料时，失败码会单独保存在 `failures/`，默认 300 秒内不重复请求（可配置 `failure_retry_seconds`）。这不是成功资料缓存，对应候选仍为未知；`/bakamodels refresh` 始终绕过该等待时间。研究模型声明型号未确认时，程序丢弃其余推测字段，缓存为统一的未知卡片。

使用旧的固定候选兼容流程时，将 `config/pi-classifier.json` 的 `candidate_source` 改成 `configured`，并自行填写 1–8 张候选卡及其证据、完整的 `gateway_url` 和 `gateway_token_file`，同时在 Pi 中配置对应执行模型。当前模板的候选列表为空，不再提供网关示例卡，不能只切换模式。此模式只使用配置卡片；独立 CLI 和 `/v1/classify` 继续使用调用方传入的候选，不会隐式联网。

## 验证

```bash
.venv/bin/pytest -q
node --test packages/pi-extension/*.test.mjs
.venv/bin/ruff check .
.venv/bin/ruff format --check .
# 显式使用 DeepSeek 搜索/整理和本地 Gemma，可能产生 API 费用：
.venv/bin/python scripts/pi-research-smoke.py
# 同时验证用户主动重查，重新调用全部候选的搜索/整理接口：
.venv/bin/python scripts/pi-research-smoke.py --refresh
```

离线测试覆盖缓存命中/过期/型号与研究配置变化、源引用伪造、未确认型号、错误脱敏、手动刷新/旧快照保留、取消、目录字段隔离、超过 8 个候选分批、字节限制与未知候选的确定性弃权。真实 smoke 连续分类两次并检查第二次全部复用能力记录或失败冷却记录、没有执行模型调用，最后运行 `/bakamodels` 查看缓存。

### 2026-10-21 初始功能验证（提速前）

- Python 95 项、Node 扩展 33 项通过；Ruff 检查和格式检查通过。
- 实际 Pi `/bakamodels refresh` 查询 39 个候选，12 个获得可用资料，27 个保留未知；无搜索/整理接口错误。未知包括未确认的网关别名与缺乏该具体版本证据的情况。
- 随后同一合成编程任务连续分类两次，均为 Gemma V2、4 批、39 行结果、39/39 资料缓存命中；12 个候选有分数，其他保持 null。两次评分一致。
- 第一次分类约 66.8 秒，第二次约 48.4 秒，不含此前手动查询耗时。多候选本地推理仍有明显延迟，此验证不代表分类准确率评测。
- 用户任务执行模型调用为 0。最后 `/bakamodels` 成功显示有效缓存；旧能力快照保留为 0600 文件。
- 复测脚本生成 `.runtime/pi-research-*-report.json`，文件名使用 UTC；以上日期按 Asia/Shanghai。原始报告和资料快照均被 Git 忽略，不随源码分发。

接口依据：[DeepSeek Search](https://api-docs.deepseek.com/api/search/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[模型 API ID](https://api-docs.deepseek.com/)。
