# Pi 本地模型测试

> 本文记录 Gemma 直接作为 Pi 执行模型的早期测试。当前分类扩展接入与命令见 [pi-classifier.md](pi-classifier.md)。

2026-10-14（Asia/Shanghai），Pi 1.2.0 通过本机兼容接口连接现有 Gemma 4 E4B Q4_K_M，推理地址为 `http://127.0.0.1:18080/v1`，关闭 thinking。

| 检查 | 结果 |
| --- | --- |
| 模型注册 | `cirno-local/cirno-gemma-e4b` 可选择，上下文 8192、最大输出 1536 |
| 文本对话 | 37 × 19 返回 703 |
| read 工具 | 实际读取 config.json，正确提取 model、runtime_url、context_tokens |
| bash 工具 | 实际执行 Python 求 1–100 之和，返回 5050 |
| 交互式 PTY | 成功进入 Pi 终端界面，模型回复 PI_LOCAL_READY |

模型、工具名、工具参数、执行成功状态及最终结果通过 Pi JSONL 事件核验。测试日志在 `.runtime/pi-test-read.jsonl`、`.runtime/pi-test-bash.jsonl`，摘要在 `.runtime/pi-test-summary.json`。

此次为 **Pi 直连本地 Gemma 的基础功能测试**；不表示 CirnoRoute 自动路由扩展已经接入。

## 启动

本次测试后本地 llama.cpp 服务保持运行。在自己的终端执行：

```bash
cd /Users/zhemuxi/CirnoRoute/cirno-route
/Users/zhemuxi/CirnoRoute/Pi/pi-local
```

若以后重启电脑或模型服务已停止，先在另一个终端运行项目的 `./scripts/start-llama.sh`。

`pi-local` 读取现有本机令牌到环境变量，不把密钥写入模型配置或命令参数；使用离线启动模式。模型和小上下文压缩设置保存在 Pi 目录的 `.state/models.json`、`.state/settings.json`。已使用 Pi 自带安装器将 fd 和 ripgrep 补齐到 `.state/bin/`，避免依赖 Codex 的临时 PATH。
