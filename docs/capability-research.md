# 联网能力资料与本地分类

本功能随 v0.2.0 发布，能力资料与评分校准仍处于试验阶段。分类模型继续使用原来的 Gemma 4 E4B Q4_K_M 和 V2 提示词。联网资料支持分类与价格推荐，开启 `/bakarouter` 后用于 [实际路由](automatic-routing.md)。不实现用户习惯自适应。

## 使用

重启 Pi，或在 Pi 中执行 `/reload`：

```bash
/Users/zhemuxi/CirnoRoute/Pi/pi-classifier
```

| 命令 | 行为 |
| --- | --- |
| `/classify 用 Python 实现归并排序并写测试` | 准备缺失/过期能力资料，再由本地 Gemma 分批评分；不执行这项编程任务 |
| `/bakarouter` | 开启普通输入前分类、按能力与价格选模并回答 |
| `/bakarouter off` | 关闭自动路由，保留当前模型 |
| `/bakamodels` | 查看当前可用候选的有效缓存数量、未知数量和目录，不调用研究模型或搜索接口 |
| `/bakamodels refresh` | 用户主动重新查询全部当前候选，忽略有效缓存；保留旧资料快照 |

首次查询覆盖 Pi `modelRegistry.getAvailable()` 提供的候选；同一 provider/model 去重并使用稳定 ID。`cirno-gateway` 的候选另与 8045 的 `/models` 求交集。其他 provider 的“可用”表示 Pi 有相应认证配置，不代表本功能逐个付费调用执行模型、检查余额或验证网关真实后端。

默认最多接受 128 个目录条目，worker 请求体上限为 60,000 UTF-8 字节，不静默截掉超出的模型。项目配置每次本地请求最多 8 个候选、30,000 UTF-8 字节。Pi 默认每批最多 8 个，先按 28,000 字节预算拆分；紧凑传输后由 llama.cpp 检查实际 token 数，超出 8K 上下文预算的批次继续二分。任务和单张卡片不截断。每批只发送当前任务和这一批资料，没有聊天历史，Gemma 进程保持加载。排序和分组固定，减少目录顺序变化的影响，但不保证跨批评分一致性或消除 V2 的语义问题。压缩方式、回退开关与实测见 [分类提速](classifier-speed.md)。

## 流程与数据

1. 读取候选的 provider、model ID、展示名称。目录中的密钥、服务 URL、其他字段不会交给研究模型。
2. 查找有效缓存。新候选、过期、研究模型/端点/提示词改变时重新研究；默认有效期 7 天，未确认型号的查询结果保留 1 小时。
3. 对每个需更新的型号调用 DeepSeek Search，优先在可识别厂商的站点搜索，获取带内容的结果。每个型号默认最多 3 个搜索结果、1 次搜索、1 次整理调用，并发 2；没有可用来源时不调用整理模型。
4. `deepseek-flash` 整理编程、推理、数学、写作、翻译、结构提取、长文理解、视觉、工具调用九个维度，记录等级、依据、限制和来源引用。
5. 确认来源引用属于实际搜索结果，并检查 JSON、维度、型号状态和等级。无法确认别名或找不到资料的候选保留未知，程序直接不给适配分。
6. 将有依据的卡片压缩成 Gemma 候选证据。全文、网址和详细记录保留在缓存，避免全部放入 8K 上下文。联网整理仍标为 `configured`，不会冒充本地 `measured` 成功率。

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

候选执行价格单独保存在 `config/model-prices.json`，在 Gemma 评分后参与推荐；`/bakaprice` 可选择三档价格偏好，规则见 [模型价格](model-pricing.md)。能力刷新不会更新价格，也不会因为改价格或价格偏好而重查能力缓存。

`config/pi-classifier.json` 的 `research_names` 可为 `provider/model` 指定明确的查询名称。本机 Gemma 已指定完整 HauhauCS Aggressive checkpoint，避免查询时误当成 Google 官方原版；这只是查询标识，仍需来源支持才能使用。未知网关后缀必须有包含该别名的资料，不能继承基础模型的分数。

## 失败、缓存与追溯

缓存目录默认 `.runtime/model-capabilities/`，记录：

- 候选标识、研究模型、响应型号、查询时间、失效时间、研究提示词哈希；
- 各维度能力、引用 ID、来源 URL、来源日期及实际提供给模型的资料摘录；
- 模型报告的 token usage；不保存 API 密钥、分类任务或用户偏好。

当前记录按查询配置哈希索引；`snapshots/<record_sha256>.json` 保留不可覆盖的内容快照。`/classify` 条目保存 `record_sha256` 和来源 URL，可以追溯具体采用哪版资料。普通对话不保存或显示评分条目，但资料缓存仍然复用。目录为 0700，文件为 0600，原子替换；`.runtime/` 被 Git 忽略。

未知型号显示弃权，同时保留其他有依据候选的评分。网络或格式失败不伪造资料、不写成功缓存；手动刷新失败时继续保留尚未过期的旧记录，并报告失败。已过期记录不参与评分。401/403/429 会阻止本轮尚未开始的请求继续外发。刷新与分类不能在同一 Pi 扩展里重叠；取消或退出 Pi 会终止该扩展拥有的 worker。

没有有效旧资料时，失败码会单独保存在 `failures/`，默认 300 秒内不重复请求（可配置 `failure_retry_seconds`）。这不是成功资料缓存，对应候选仍为未知；`/bakamodels refresh` 始终绕过该等待时间。研究模型声明型号未确认时，程序丢弃其余推测字段，缓存为统一的未知卡片。

从代码退回原配置流程：将 `config/pi-classifier.json` 的 `candidate_source` 改成 `configured`；此时只使用其中已有三个候选。独立 CLI 和 `/v1/classify` 继续使用调用方传入的候选，不会隐式联网。

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
- 本地详细报告：`.runtime/pi-research-20261020T163227Z-report.json`。文件名使用 UTC；以上日期按 Asia/Shanghai。

接口依据：[DeepSeek Search](https://api-docs.deepseek.com/api/search/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[模型 API ID](https://api-docs.deepseek.com/)。
