# 本机验证记录

日期：2026-10-14（Asia/Shanghai）。以下是实现验证，不是独立路由效果评估。

## 环境

- Apple M3 Pro，36 GiB 统一内存。
- Pi 1.2.0；Python 3.12.11；llama.cpp b10516-b95502ba9。
- 现有模型：`HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive:Q4_K_M`。
- 权重 SHA-256：`d0027dd3a9128d9323e9f282c8bf010a8526c46477584535991dc1a869b56e96`。
- 模板 SHA-256：`55572b8d3c8342044e25874c73fe5234b661fa0a57a57f6ef75b58e03d7d959a`。
- 8192 token 上下文，1536 token 输出上限，temperature=0，seed=42，关闭 reasoning。

## 结果

- 57 项自动化测试通过；Ruff 静态检查和格式检查通过。
- Pi 包装器返回 1.2.0；启动脚本权限和 shell 语法通过。
- 实际模板保留 system/user 角色；冲突提示探针确认 JSON Schema 约束确实生效。

| 合成用例 | 状态 | 来源 | 耗时（ms） |
| --- | --- | --- | ---: |
| coding | ok | gemma | 9811.66 |
| writing | ok | gemma | 9853.90 |
| injected-document | ok | gemma | 9676.43 |
| empty-candidates | blocked | rules | 0.17 |
| missing-evidence | abstain | rules | 0.31 |

完整 HTTP 调用返回 HTTP 200、source=gemma、status=ok，耗时 9671.03 ms。鉴权、健康检查、无候选阻断、非法输入不回显正文均通过。

三个实际推理用例分别验证编程任务、写作任务和文档角色诱导；每次均返回给定的三个候选，无偏好输入时偏好等级均为 null。空候选与缺资料由程序直接阻断或弃权，不调用模型。

## 复现与限制

执行 README 中的启动步骤，再运行 `.venv/bin/pytest -q` 和 `.venv/bin/python scripts/smoke.py`。原始合成测试记录保存在 `.runtime/smoke-report.json`、`.runtime/http-smoke.json`，不进入源码发布。测试结束后已停止本次启动的两个服务，使用启动脚本即可重启。

示例候选是合成配置，没有实测能力卡。以上只有三个生成样本，不能用于准确率、P50/P95、收益或安全保证的统计结论。合法输出仍可能存在语义判断错误。固定 seed 不代表跨硬件或运行时逐 token 可复现。

当前 llama.cpp 对 `response_format.type=json_schema` 需要嵌套 `json_schema.schema`；初始化探针和回归测试覆盖静默忽略约束的情形。现有 GGUF 的旧聊天模板由当前锁定 build 做兼容处理，升级后必须重验模板并重新锁定。
