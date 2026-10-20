# CirnoRoute · 本地模型分类器

当前只实现设计文档中的 **RouterPredictor**：本地 Gemma 根据任务和候选资料，输出每个候选的质量适配等级、可选表达偏好适配等级、证据引用和弃权状态。提供独立 CLI、Python 接口、带令牌的本地 HTTP API，以及 Pi 1.2.0 分类扩展。

分类器本身不执行用户任务，不调用候选模型。Pi 扩展提供 `/classify` 和普通输入前的评分显示；普通对话由 Pi 当前选择的执行模型完成。自动模型切换、PolicyEngine、费用预算、偏好存储/提取、Jev、微调和实验平台不在本阶段范围内。`fallback_candidate_id` 只是冻结优先级产生的建议，**不是执行许可或最终选模结果**。

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

V3 对缺少 evidence 的候选给出未知分数并整体弃权，同时保留其他候选有依据的分数；V1/V2 对照流程仍在任一候选缺少 evidence 时返回 `UNSUPPORTED_BY_ROUTER`。不凭模型名编造分数。当前输入上限 10,000 UTF-8 字节、最多 8 个候选；实际发送前通过 llama.cpp 渲染模板并计算 token，超出上下文预算则阻断，不静默截断。

当前默认使用 V3：先检查任务输入，再逐个候选检查能力证据、评分，推理前规范排序。质量提示词在 [`router-system-v3.txt`](src/cirno_route/resources/router-system-v3.txt)，输入、证据与否定复核提示词在同一目录。缺少必要输入时直接弃权；部分候选资料不足时保留其他有依据的分数。完整文件位置、实测与延迟代价见 [V3 验证记录](docs/prompt-evaluation-v3.md)。V1/V2 提示词保留用于对照。修改后在 Pi 中执行 `/reload` 或重启 Pi；自动分类需要重新输入 `/bakarouter` 开启。独立 CLI 下次启动生效，已运行的 HTTP 分类服务需要重启。

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

在 Pi 中输入 `/classify 用 Python 实现归并排序并编写测试`，即可只分类。普通输入自动分类默认关闭；输入 `/bakarouter` 开启，输入 `/bakarouter off` 关闭。开启后，普通输入先显示本地评分，再由 Pi 的 `cirno-gateway/claude-sonnet-4-6` 执行。

候选资料在 `config/pi-classifier.json`，当前配置 Sonnet 4.6、Opus 4.6、Gemini 3 Flash。每次与8045模型目录求交集；资料属于配置声明，尚无本地成功率校准。分类本身的任务正文始终发送到本地 Gemma，普通 Pi 对话则会通过8045执行。

Pi 独立安装在 `../Pi`，固定官方包 `@earendil-works/pi-coding-agent@1.2.0`，依赖由该目录 `package-lock.json` 锁定。配置和会话在 `Pi/.state/`；网关密钥保存在本项目 `.runtime/gateway.token`，启动时以环境变量提供。

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

本机受信单用户、受信 llama.cpp 进程。执行 lock-model 时计算完整权重哈希，调用前后比较文件大小/mtime、模型 ID、模板哈希与 build；这不是防御同权限恶意进程篡改文件的沙箱。模型的语义判断仍可能出错，合法 JSON 也不保证判断正确。服务不允许联网地址、代理继承或重定向；它没有提供整个 Pi/工具进程的网络隔离保证。

运行数据和密钥都在项目 `.runtime/`，与 iCloud 笔记目录分开。`.gitignore` 排除环境、令牌、日志、缓存和本地运行报告。模型复用原缓存，不复制到源码。

官方接口参考：[Pi 安装](https://pi.dev/docs/latest/quickstart)、[llama.cpp 服务](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)、[Gemma 4 提示词格式](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4)。
