# 版本管理与回退

仓库：[ZheMuxi/cirno-route](https://github.com/ZheMuxi/cirno-route)。

## 提交授权

用户明确要求：**只有在用户要求提交本项目时，才整理版本记录、完成测试、提交并推送 GitHub，保留可回退版本。不要自行提交。**

普通开发请求不包含提交授权，之前的提交授权不自动延续到后续修改。未获授权时保留本地改动并汇报，不自动暂存、提交、推送、合并或发布。必要测试失败或无法完成时先报告并解决；接受已有基线失败也须由用户明确决定。以下提交与发布步骤均以本次获得用户明确授权为前提，完整约定见 `../AGENTS.md`。

## 当前版本

- `v0.2.0`：当前版本，包含能力研究、V2 紧凑分批分类、价格偏好与 Pi 实际路由。变更、验证及限制见 [版本说明](../releases/v0.2.0.md)。
- `docs-v0.2.0-portable-docs`：其余指南、历史评测说明和发布说明的通用化文档快照；功能版本仍为 0.2.0，提示词、运行时及依赖锁未变。
- `docs-v0.2.0-public-readme`：公开仓库的通用 README 文档快照，功能版本仍为 0.2.0；原功能发布标签保持不变。
- `v0.1.1`：前一版 V2 单次分类实现，是本次发布的回退目标。与当前版本共用提示词 `router-system-v2.txt`，SHA-256 为 `6fed39a057ef5e90be1f0be0a213ec900c6b8a698c2d520c8773613b3895d266`。
- `v0.1.0-v3-baseline`：切换前的 V3 完整源码快照，保留用于回退和比较。
- Python 项目、模块与 Pi 插件共同使用项目版本；提示词 V2/V3 独立编号。发布标签固定，后续修复另发新版本。
- 实际机器上的密钥、会话、模型缓存与日志保留在 `.runtime/`、`../Pi/.state/`、已有模型缓存中，不进入 Git，也不随代码版本回退。
- `releases/v0.2.0.md` 记录当前版本的功能、验证摘要和限制；`releases/v0.1.1.json` 保留前版发布记录。实际 GGUF 和 llama.cpp 下载由 `src/cirno_route/resources/local-runtime-v1.json` 固定并校验。

## 2026-10-20 恢复验证

- Python 71 项、Pi 扩展 24 项测试通过；Ruff 检查及格式检查通过，`uv sync --frozen` 安装成功。
- 真实 Pi 两次分类均为 V2 且来自 Gemma：简单乘法 Sonnet/Opus/Flash 为 4/4/4，复杂缓存设计为 3/4/2；未调用执行模型，偏好分为空。
- 原有 17 项固定语义回归通过 14 项，与历史 V2 结果一致。失败为 `dev-unsupported`、`validation-unknown`（资料缺失未弃权）与 `validation-order`（换序评分波动），没有把这些失败改为通过。
- 平均分类时间约 10.31 秒，无格式重试。完整脱敏摘要及文件哈希见 `releases/v0.1.1.json`；原始报告保存在被 Git 忽略的 `.runtime/`，不随源码分发。

## 开发与发布

1. 从 `main` 创建短期功能分支，在用户明确要求提交后整理提交；不要直接移动历史标签。
2. GitHub Pull Request 运行 Checks，通过后合入 `main`。当前没有配置强制分支保护，流程需要主动遵守。
3. 修改分类流程或评分规则时，另外在本地运行真实 Gemma 固定评测和 Pi smoke。GitHub CI 不包含模型权重，不声称验证了真实模型分类质量。
4. 功能发布时同步更新 `pyproject.toml`、`src/cirno_route/__init__.py`、Pi 插件 `package.json` 和 `uv.lock` 的项目版本。仅文档修改保留功能版本，记录 CHANGELOG 和文档验证结果。合并后确认 `main` 的 CI 通过，再建立新的注释标签，不覆盖旧标签。
5. 提示词、分类代码、候选卡和依赖作为一个版本发布。更新 Pi 时先修改 `tooling/pi/` 的清单与锁文件，关闭 Pi，再执行 `scripts/install-pi.sh`。

先按 [README](../README.md) 完成环境安装。下面是从仓库根目录执行的功能发布检查，真实 Pi 测试需要自己的服务与凭据，可能产生 API 费用。仅文档修改检查链接、示例语法、敏感信息与 diff，并等待 GitHub CI；无需重复付费模型调用。

```bash
uv sync --frozen --python 3.12
.venv/bin/ruff check .
.venv/bin/ruff format --check .
.venv/bin/pytest -q
node --test packages/pi-extension/*.test.mjs
.venv/bin/python scripts/pi-routing-smoke.py
.venv/bin/python scripts/benchmark-classifier.py --fixtures --modes compact --output .runtime/compact-new-evaluation.json
```

评测输出文件必须是新路径。语义失败会写入报告；不能只看脚本退出码判断质量。V2 的已知缺资料/顺序问题如实记录，不能通过删除失败用例获得“全部通过”。当前目录模式应使用 `pi-routing-smoke.py`；历史 `pi-prompt-smoke.py` 的三候选、单次推理断言仅适用于旧配置。若用户要求不留测试文件，将脚本所需工作目录和输出重定向到临时目录，结束后清理，只把验证摘要写入用户授权的版本说明。

## 本地回退

这是源码及锁定依赖的人工回退流程，尚未实现自动发布目录切换。开始前退出 Pi，并停止自己启动的独立分类 HTTP 服务；不要终止其他应用的 llama.cpp 服务。

1. 在项目目录运行 `git status --short`，必须没有未提交文件。有开发改动时先保留现场，明确保存方式；未经用户要求，不为回退自行创建提交，勿用 `reset --hard` 或 `clean` 丢弃改动。
2. 执行以下命令回到前一版 V2 分类实现：

```bash
# 从仓库根目录执行
git fetch origin --tags
git switch --detach v0.1.1
uv sync --frozen --python 3.12
```

3. `v0.2.0` 与 `v0.1.1` 的 Pi 依赖清单相同，现有 `../Pi` 可直接复用。以后切到不同 Pi 依赖版本时，用该版本的安装脚本同步；更早的 `v0.1.0-v3-baseline` 也保留，但没有安装脚本，可用 `tooling/pi/package*.json` 配合 `npm ci --prefix ../Pi` 恢复。
4. 从仓库根目录运行 `./scripts/start-pi.sh` 重新启动，使用 `/classify` 实际验证。`v0.1.1` 的 `/bakarouter` 只分类，不自动切换回答模型；`v0.2.0` 才会实际路由。开关每次需重新开启。不要沿用切换前仍存活的 Python worker；价格偏好和能力缓存保留在本机，回退不删除。
5. 回到当前已发布 V2 版本：

```bash
git switch --detach v0.2.0
uv sync --frozen --python 3.12
```

回到日常开发分支用 `git switch main`；同步远端时用 `git pull --ff-only`。源码撤销使用 `git revert` 留下记录；运行版本回退不改写 `main` 的共享历史。

初次克隆可选择任意工作目录，保持仓库目录名为 `cirno-route`，由安装脚本在同级创建 `Pi`；完整步骤见 [README](../README.md)。网关密钥由用户在本机配置到 `.runtime/gateway.token`，权限 0600；绝不提交到 GitHub。模型会在首次分类时按已有自动准备机制检测或下载。

本轮文档通用化覆盖当前分支与 GitHub v0.2.0 发布页；旧提交和固定标签保持原样，可能仍包含历史路径说明。回退旧版本时请按实际安装位置调整路径。密钥不应存在于任何版本；发现泄漏时须单独处理凭据失效与历史清理。

## 回退条件与保留政策

- 启动失败、输出协议损坏、持续超时或固定回归出现新的不可接受退化时，人工切回最近验证可用的标签。
- 合法弃权不是故障；不能因单次评分不理想就自动回退。
- 保留全部发布标签，至少保留最近三个可用版本需要的模型与运行时缓存；不要清理唯一可用的旧模型副本。
- 回退目标先执行自动化与真实分类 smoke，失败时返回先前可用标签。保留失败日志，不覆盖既有评测报告。
- 当前阶段包含分类、能力资料缓存及显式价格偏好驱动的实际路由，没有用户习惯库或数据库迁移。
