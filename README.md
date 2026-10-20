# CirnoRoute · 本地模型分类器

当前实现设计文档中的 **RouterPredictor** 和 Pi 可选的自动路由：本地 Gemma 根据任务和候选资料，输出每个候选的质量适配等级、可选表达偏好适配等级、证据引用和弃权状态。提供独立 CLI、Python 接口、带令牌的本地 HTTP API，以及 Pi 1.2.0 扩展。

分类器本身不执行用户任务，不调用候选模型。Pi 扩展仅在 `/classify` 显示各候选分数；开启 `/bakarouter` 后，普通对话按任务能力与价格偏好自动选择回答模型，每次回答显示实际使用的 provider/model。`/classify` 仍不切换模型或执行任务。完整 PolicyEngine、费用预算、习惯偏好提取、Jev、微调和实验平台不在本阶段范围内。`fallback_candidate_id` 不用于自动路由。开关及失败处理见 [自动路由](docs/automatic-routing.md)。

v0.2.0 新增：Pi 首次分类前使用可配置的研究模型（默认 DeepSeek-V4.1-Flash，API ID `deepseek-flash`）联网整理全部可用候选的能力资料，缓存后由本地 Gemma V2 分批评分。用户可通过 `/bakamodels refresh` 主动重新查询，通过 `/bakamodels` 查看缓存。研究阶段只发送模型标识，不发送分类任务。详见 [联网能力资料](docs/capability-research.md)。

价格偏好：使用 `/bakaprice` 菜单，或直接输入 `/bakaprice 希望便宜`、`/bakaprice 均衡`、`/bakaprice 接受昂贵`。默认均衡，设置跨重启保留。Gemma 完成能力评分后，本地程序结合价格推荐模型；接受昂贵档优先能力，同分取已知价格更高者。价格不增加 Gemma 上下文。初始填入 8 个模型的官方标准价/网关参考价，其他价格保持未知；配置及选择规则见 [模型价格](docs/model-pricing.md)。

## 本机部署

源码：`/Users/zhemuxi/CirnoRoute/cirno-route`。Pi 1.2.0 独立安装在 `/Users/zhemuxi/CirnoRoute/Pi`。

使用已有 llama.cpp `b10516-b95502ba9` 和现有缓存：

```text
HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive:Q4_K_M
```

这是用户指定的 Gemma 4 E4B 衍生权重，不标为 Google 官方原始 checkpoint。本阶段不改动权重。GGUF SHA-256、实际缓存路径、模板哈希、运行时 build 和上下文大小记录在 `.runtime/model-lock.json`。

## 快速开始

在项目目录运行，要求 Python 3.12+、uv 和已有 llama.cpp 缓存：

```bash
cd /Users/zhemuxi/CirnoRoute/cirno-route
uv sync --frozen --python 3.12
.venv/bin/cirno-route init
./scripts/start-llama.sh
```

上面终端保持运行；另开终端执行：

```bash
cd /Users/zhemuxi/CirnoRoute/cirno-route
# 首次运行或明确更新模型/运行时后执行；计算约 5.3 GB 权重哈希并验证模板和 JSON 约束。
.venv/bin/cirno-route lock-model
.venv/bin/cirno-route classify examples/coding.json
```

`start-llama.sh` 使用 `--offline`，不会下载模型，保持 `--no-mmproj --jinja -c 8192 -ngl all --reasoning off`，绑定 `127.0.0.1:18080`。不支持从未验证的远端 OpenAI 兼容接口调用模型。已有相同端口的服务时直接复用，不要重复启动；本项目不会自动终止其他服务。

模型输出示意：

```json
{
  "status": "ok",
  "source": "gemma",
  "prediction": {
    "schema_version": "1",
    "status": "ok",
    "candidates": [{
      "candidate_id": "demo_code",
      "quality_level": 4,
      "preference_fit_level": null,
      "uncertainty": "medium",
      "evidence_ids": ["code-config-v1"],
      "reason_codes": ["TASK_MATCH"]
    }]
  }
}
```

这里只节选一个候选；真实响应包含全部输入候选以及 metadata。0–4 是待验证的适配等级，不是成功率。`uncertainty` 是模型自述类别，不是校准置信度。

## 输入与候选资料

完整例子见 [`examples/coding.json`](examples/coding.json)，合同见 `contracts/`。示例的三个 `demo_*` 候选均为**合成演示资料**，没有对应真实执行配置和实测成功率。投入真实选模前，需要填入实际候选和独立获得的资料。

- `task.text`：待分析任务；`requirements`：本轮明确要求；`task_type` 可省略。
- `eligible_candidates`：由受信调用方预先过滤的候选集合。本模块不实现隐私、健康、认证、费用或工具能力过滤。
- 每个候选提供 `candidate_id/model/revision/capabilities/evidence`。资料 ID 必须唯一，`configured` 与 `measured` 分开；实测资料必须提供正整数 `sample_count`。
- `relevant_preferences` 默认空，仅接受调用方已经验证、与当前任务有关的表达要求；不读写用户档案，不实现偏好更新。
- 数据里的指令只作为待分析内容。固定 system 提示词与动态 user JSON 分离；生成 Schema 限定候选自己的证据、资料类型和空偏好字段；字段和引用仍会经过程序校验。

独立 V2 接口在任一候选完全缺少 evidence 时返回 `UNSUPPORTED_BY_ROUTER`，所有分数未知。不凭模型名编造分数。项目配置允许每次本地请求 30,000 UTF-8 字节、最多 8 个候选；实际发送前通过 llama.cpp 渲染模板并计算 token，超出上下文预算则阻断，不静默截断。Pi 目录流程保留全部候选，有依据候选分批，未知型号直接保留弃权；超出实际 token 预算的批次会继续二分。

当前启用紧凑传输：保留 V2 评分规则，缩短内部 ID、去除重复说明和冗长输出字段，恢复完整结果后仍执行原有校验。任务、能力依据及限制不截断。开关与本机对照结果见 [分类提速](docs/classifier-speed.md)。

当前默认使用 **V2 评分流程，每批独立分类**，提示词在 [`router-system-v2.txt`](src/cirno_route/resources/router-system-v2.txt)，V1 保留用于对照。V3 的四份提示词及多阶段分类代码已从当前版本删除，可通过 Git 标签 `v0.1.0-v3-baseline` 找回。V2 仍存在资料不足时未弃权、候选换序时评分波动的已知问题，详见 [V2 评测记录](docs/prompt-evaluation.md) 和 [紧凑格式复测](docs/classifier-speed.md)。修改后在 Pi 中执行 `/reload` 或重启 Pi；自动分类需要重新输入 `/bakarouter` 开启。独立 CLI 下次启动生效，已运行的 HTTP 分类服务需要重启。

## 版本管理

私有仓库：[ZheMuxi/cirno-route](https://github.com/ZheMuxi/cirno-route)。当前项目版本 `0.2.0`，分类提示词版本 V2，两者独立编号。本版新增能力研究、紧凑分类、三档价格偏好与 Pi 实际路由，详见 [v0.2.0 版本说明](releases/v0.2.0.md)。提交、发布及安全回退步骤见 [版本与回退政策](docs/versioning.md)，历次变更见 [CHANGELOG.md](CHANGELOG.md)。

Pi 的依赖锁文件、启动入口和不含密钥的模型配置模板在 `tooling/pi/`。新克隆或切换依赖版本后，执行 `./scripts/install-pi.sh`，安装到相邻的 `../Pi`。已有 Pi 配置与会话保留；密钥仍放本地 `.runtime/`，不会上传。

## 失败与规则基线

```bash
.venv/bin/cirno-route classify examples/coding.json --rules
cat examples/coding.json | .venv/bin/cirno-route classify -
```

`--rules` 不需要运行模型。回退采用 `config.json` 的 `fallback_order`，只取当前候选与该配置的交集中的第一个；没有交集则返回 null。规则路径不编造等级，统一 `status=abstain/source=rules`。

- 空候选集合返回 `blocked/NO_ELIGIBLE_MODEL`。
- 超时、离线、格式错误或模型/模板/build 不一致返回弃权及固定错误码。
- 格式/语义错误最多重试一次；网络错误不自动重试。整个分类调用有总时间限制。
- 未知 usage 为 null。只记录请求 ID、哈希、版本、耗时、尝试次数、实际报告的 token 数和错误码；默认不持久化任务正文或生成文本。
- CLI 正常预测或弃权退出码 0，阻断 2，输入/配置错误 1；自动化使用者应同时检查 JSON 状态和 source。

## 本地 API

```bash
./scripts/start-api.sh
```

绑定 `127.0.0.1:18081`。所有路径（包括健康检查和文档）都需要 `Authorization: Bearer <token>`；令牌由 init 生成，位于 `.runtime/api.token`，权限 0600。llama.cpp 使用独立 `.runtime/llama.token`。令牌不输出到日志。

可用以下 Python 示例调用，不把令牌写进 shell 历史：

```bash
.venv/bin/python - <<'PY'
from pathlib import Path
import httpx
headers = {'Authorization': 'Bearer ' + Path('.runtime/api.token').read_text().strip(),
           'Content-Type': 'application/json'}
with httpx.Client(trust_env=False, timeout=100) as client:
    response = client.post('http://127.0.0.1:18081/v1/classify', headers=headers,
                           content=Path('examples/coding.json').read_bytes())
    print(response.status_code, response.json())
PY
```

`GET /health` 是进程存活检查，不代表模型已就绪；每次分类都会校验实际运行时。`POST /v1/classify` 返回 200（预测/弃权）、409（blocked）、401（无有效令牌）、413（请求过大）、415（非 JSON）、422（输入不合规）、429（分类器忙）。此阶段不提供设计文档中的 `/v1/route/decide`，以免混淆分类和执行授权。

## Pi

本地分类器已接入 Pi。启动、命令与真实测试结果见 [docs/pi-classifier.md](docs/pi-classifier.md)。本地模型由插件按需准备和启动，缺少 Gemma 权重或 llama.cpp 时自动下载；详见 [自动准备与生命周期](docs/pi-managed-runtime.md)。保持用户的8045网关可用，然后启动：

```bash
/Users/zhemuxi/CirnoRoute/Pi/pi-classifier
```

在 Pi 中输入 `/classify 用 Python 实现归并排序并编写测试`，即可只分类并查看所有候选分数。自动路由默认关闭；输入 `/bakarouter` 开启，输入 `/bakarouter off` 关闭。开启后，普通输入先分类并结合价格选模，再由选中模型回答，不显示各模型评分；无论开关状态，每次回答都会显示实际模型。关闭后保留当前模型，可用 `/model` 更换。新会话的启动默认模型仍为 `cirno-gateway/claude-sonnet-4-6`。

`config/pi-classifier.json` 当前使用 `candidate_source: "pi"`，读取 Pi 完整可用目录；网关候选每次与8045目录求交集。`config.json` 的 `capability_research` 控制搜索、研究模型及缓存。研究记录在 `.runtime/model-capabilities/`，尚无本地成功率校准。将候选来源改为 `configured` 可恢复文件内原有三个候选。分类任务正文只发送到本地 Gemma，普通 Pi 对话仍通过当前执行模型处理。

Pi 独立安装在 `../Pi`，固定官方包 `@earendil-works/pi-coding-agent@1.2.0`，依赖由源码中的 `tooling/pi/package-lock.json` 锁定，安装脚本将其同步到该目录。配置和会话在 `Pi/.state/`；网关密钥保存在本项目 `.runtime/gateway.token`，启动时以环境变量提供。

原来的 `/Users/zhemuxi/CirnoRoute/Pi/pi-local` 入口保留，用于直接把 Gemma 当执行模型。其早期测试见 [docs/pi-smoke.md](docs/pi-smoke.md)。

## 验证

本机结果见 [`docs/verification.md`](docs/verification.md)。

```bash
.venv/bin/pytest -q
node --test packages/pi-extension/*.test.mjs
.venv/bin/ruff check .
.venv/bin/ruff format --check .
# 明确调用本地模型的合成用例，报告写入被 Git 忽略的 .runtime/
.venv/bin/python scripts/smoke.py
```

自动化测试覆盖候选越界、证据伪造和跨候选引用、类型错误、无偏好时错误评分、缺资料弃权、空候选、重试上限、超时、模板和版本检查、输入过大、输出截断、HTTP 鉴权、重定向拒绝等。测试不下载模型。模型锁定还用冲突提示检查服务是否真正执行 JSON Schema，拒绝静默忽略约束的运行时。真实 smoke checks 只是连通性与基本行为检查，不证明路由准确率或成本收益。现有 GGUF 模板会触发 llama.cpp 的旧模板兼容提示，实际 system 渲染已在 lock-model 中检查；升级运行时后需重新验证和锁定。

## 实现范围与信任边界

代码结构：`contracts.py` 数据合同；`runtime.py` llama.cpp 适配；`validation.py` 严格解析和引用验证；`classifier.py` 分类/弃权流程；`cli.py`/`api.py` 入口；`resources/` 固定提示词。

本机受信单用户、受信 llama.cpp 进程。执行 lock-model 时计算完整权重哈希，调用前后比较文件大小/mtime、模型 ID、模板哈希与 build；这不是防御同权限恶意进程篡改文件的沙箱。模型的语义判断仍可能出错，合法 JSON 也不保证判断正确。本地推理适配器不允许联网地址、代理继承或重定向；新增的公开模型资料研究模块明确使用远程搜索和整理接口，不提供整个 Pi/工具进程的网络隔离保证。

运行数据和密钥都在项目 `.runtime/`，与 iCloud 笔记目录分开。`.gitignore` 排除环境、令牌、日志、缓存和本地运行报告。模型复用原缓存，不复制到源码。

官方接口参考：[Pi 安装](https://pi.dev/docs/latest/quickstart)、[llama.cpp 服务](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)、[Gemma 4 提示词格式](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4)。
