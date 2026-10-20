# 版本管理与回退

仓库：https://github.com/ZheMuxi/cirno-route （私有）。

## 当前版本

- `v0.1.1`：当前 V2 单次分类实现。提示词 `router-system-v2.txt`，SHA-256 为 `6fed39a057ef5e90be1f0be0a213ec900c6b8a698c2d520c8773613b3895d266`。
- `v0.1.0-v3-baseline`：切换前的 V3 完整源码快照，保留用于回退和比较。
- Python 项目、模块与 Pi 插件共同使用项目版本；提示词 V2/V3 独立编号。发布标签固定，后续修复另发新版本。
- 实际机器上的密钥、会话、模型缓存与日志保留在 `.runtime/`、`../Pi/.state/`、已有模型缓存中，不进入 Git，也不随代码版本回退。
- `releases/v0.1.1.json` 记录当前发布的文件哈希、运行时锁定信息及验证结果。实际 GGUF 和 llama.cpp 下载由 `resources/local-runtime-v1.json` 固定并校验。

## 2026-10-20 恢复验证

- Python 71 项、Pi 扩展 24 项测试通过；Ruff 检查及格式检查通过，`uv sync --frozen` 安装成功。
- 真实 Pi 两次分类均为 V2 且来自 Gemma：简单乘法 Sonnet/Opus/Flash 为 4/4/4，复杂缓存设计为 3/4/2；未调用执行模型，偏好分为空。
- 原有 17 项固定语义回归通过 14 项，与历史 V2 结果一致。失败为 `dev-unsupported`、`validation-unknown`（资料缺失未弃权）与 `validation-order`（换序评分波动），没有把这些失败改为通过。
- 平均分类时间约 10.31 秒，无格式重试。完整脱敏摘要及文件哈希见 `releases/v0.1.1.json`；原始本机报告留在 `.runtime/`。

## 开发与发布

1. 从 `main` 创建短期功能分支，小步提交；不要直接移动历史标签。
2. GitHub Pull Request 运行 Checks，通过后合入 `main`。当前没有配置强制分支保护，流程需要主动遵守。
3. 修改分类流程或评分规则时，另外在本机运行真实 Gemma 固定评测和 Pi smoke。GitHub CI 不包含模型权重，不声称验证了真实模型分类质量。
4. 更新 `pyproject.toml`、`src/cirno_route/__init__.py`、Pi 插件 `package.json` 和 `uv.lock` 的项目版本，记录 CHANGELOG 与评测结果，然后建立注释标签。
5. 提示词、分类代码、候选卡和依赖作为一个版本发布。更新 Pi 时先修改 `tooling/pi/` 的清单与锁文件，关闭 Pi，再执行 `scripts/install-pi.sh`。

本机检查：

```bash
uv sync --frozen --python 3.12
.venv/bin/ruff check .
.venv/bin/ruff format --check .
.venv/bin/pytest -q
node --test packages/pi-extension/*.test.mjs
.venv/bin/python scripts/pi-prompt-smoke.py
.venv/bin/python scripts/evaluate-prompts.py --versions v2 --split all --output .runtime/v2-new-evaluation.json
```

评测输出文件必须是新路径。语义失败会写入报告；不能只看脚本退出码判断质量。V2 的已知缺资料/顺序问题如实记录，不能通过删除失败用例获得“全部通过”。

## 本机回退

这是源码及锁定依赖的人工回退流程，尚未实现自动发布目录切换。开始前退出 Pi，并停止自己启动的独立分类 HTTP 服务；不要终止其他应用的 llama.cpp 服务。

1. 在项目目录运行 `git status --short`，必须没有未提交文件。有开发改动时先保存到自己的分支并提交，勿用 `reset --hard` 或 `clean` 丢弃。
2. 执行以下命令选择需要的完整版本，例如切换前的 V3：

```bash
cd /Users/zhemuxi/CirnoRoute/cirno-route
git fetch origin --tags
git switch --detach v0.1.0-v3-baseline
uv sync --frozen --python 3.12
```

3. 这两个已保存版本的 Pi 依赖清单相同，现有 `../Pi` 可直接复用。以后切到不同 Pi 依赖版本时，用该版本的安装脚本同步；V3 基线没有安装脚本，可用 `tooling/pi/package*.json` 配合 `npm ci --prefix ../Pi` 恢复。
4. 从 `/Users/zhemuxi/CirnoRoute/Pi/pi-classifier` 重新启动，使用 `/classify` 实际验证。普通输入自动分类需重新输入 `/bakarouter`。不要沿用切换前仍存活的 Python worker。
5. 回到当前已发布 V2 版本：

```bash
git switch --detach v0.1.1
uv sync --frozen --python 3.12
```

回到日常开发分支用 `git switch main`；同步远端时用 `git pull --ff-only`。源码撤销使用 `git revert` 留下记录；运行版本回退不改写 `main` 的共享历史。

初次克隆时，把仓库克隆为 `CirnoRoute/cirno-route`，执行 `uv sync --frozen --python 3.12`、`scripts/install-pi.sh` 和 `.venv/bin/cirno-route init`。网关密钥由用户在本机配置到 `.runtime/gateway.token`，权限 0600；绝不提交到 GitHub。模型会在首次分类时按已有自动准备机制检测或下载。

## 回退条件与保留政策

- 启动失败、输出协议损坏、持续超时或固定回归出现新的不可接受退化时，人工切回最近验证可用的标签。
- 合法弃权不是故障；不能因单次评分不理想就自动回退。
- 保留全部发布标签，至少保留最近三个可用版本需要的模型与运行时缓存；不要清理唯一可用的旧模型副本。
- 回退目标先执行自动化与真实分类 smoke，失败时返回先前可用标签。保留失败日志，不覆盖既有评测报告。
- 当前阶段只有分类功能，没有用户习惯库或数据库迁移。
