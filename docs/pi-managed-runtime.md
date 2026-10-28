# Pi 内置管理的本地模型后台

v0.3.0 默认使用 [node-llama-cpp 原生后端](native-runtime.md)，直接通过库推理、不监听 HTTP 端口。本文保留 `llama-server` 后端的操作和历史验证，使用明确的旧后端入口启动。

实现日期：2026-10-14。已在 macOS Apple Silicon 与 Pi 1.2.0 上验证；自动下载的平台范围见下文。

## 使用

先完成 [README](../README.md) 中的环境安装和凭据配置，再从仓库根目录启动 Pi：

```bash
./scripts/start-pi-llama.sh
```

已打开的 Pi 输入 `/reload` 加载更新。

- `/bakarouter`：开启普通输入自动分类，第一次分类时准备模型。
- `/bakarouter off`：关闭普通输入自动分类。
- `/classify 任务文本`：随时单独分类。

不必手动启动 llama-server 或分类 HTTP API，不需要为它们另开终端。普通输入自动分类仍默认关闭。

插件按需启动一个 Python 分类后台，通过进程管道调用既有 RouterPredictor；后台按需启动本地 llama.cpp。模型没有被复制进 TypeScript 文件，运行与依赖准备由插件管理。代码、权重和运行日志分开保存。

## 首次使用与自动下载

依赖准备在首次有效分类时进行，状态栏显示加载、校验或下载百分比。

1. 若已有符合模型锁的本地 llama.cpp 服务，直接复用。
2. 否则查找模型锁指定的权重、Hugging Face 缓存和项目自己的模型目录。匹配的文件直接复用。
3. 缺少权重时，从固定 Hugging Face revision 下载项目清单固定的 Q4_K_M 权重，约 5.34 GB。支持断点续传；校验完整 SHA-256 后才发布为可用文件。
4. 检查现有 llama-server 的 build/commit；不存在或版本不兼容时，在项目内安装固定版本的官方预编译包。macOS arm64 安装包约 10.6 MB，下载包先验证 SHA-256，再安全解压并检查版本。不使用 Homebrew，不修改全局安装。
5. 在随机回环端口启动私有 llama.cpp，使用配置的 8192 上下文、GPU 卸载、关闭 thinking 等参数。新模型路径需要通过模板与结构化输出验证才生成运行锁。

固定下载源、版本与哈希见 `src/cirno_route/resources/local-runtime-v1.json`：

- 模型：`HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive`，revision `45b6a334b4bcd1d7f37179df58b3b1d66a184e5d`，`Q4_K_M`。
- 模型 SHA-256：`d0027dd3a9128d9323e9f282c8bf010a8526c46477584535991dc1a869b56e96`。
- llama.cpp：`b10516-b95502ba9`；[官方固定版本发布包](https://github.com/ggml-org/llama.cpp/releases/tag/b10516)。
- 自动安装目前提供 macOS arm64 / x64 的固定包，已验证 arm64。其他平台需自行提供兼容的 `llama-server`；若未找到兼容程序且没有该平台下载包，会返回 `AUTO_INSTALL_PLATFORM_UNSUPPORTED`，尚未验证这些平台。

项目内下载位置：

```text
.runtime/models/                         缺失时下载的 GGUF
.runtime/llama.cpp/b10516-b95502ba9/       项目内 llama.cpp
.runtime/downloads/                      校验过的安装包及下载中的 .part
.runtime/managed-model-lock.json          插件后台的模型锁
.runtime/pi-local-backend.log             后台启动与推理运行日志
```

不把用户任务或网关 API 密钥附带到下载请求。下载使用固定 HTTPS 来源；网络中断留下 `.part` 供下次续传，错误哈希文件不会投入使用。多个 Pi 依赖准备由文件锁串行保护。权重和安装包保留在磁盘上供下次使用。

Python 虚拟环境、Node.js 和 Pi 必须先按 README 安装；自动准备范围仅包含模型权重与 llama.cpp。

## 生命周期

模型加载后保留到当前 Pi 退出、重载扩展或取消正在进行的分类。`/bakarouter off` 只关闭自动分类，不卸载模型，之后 `/classify` 仍可快速使用。

- 正常退出 / `/reload`：关闭管道并回收插件自己启动的模型进程。
- Pi 意外终止：后台检测管道 EOF，同样回收自己启动的进程。
- 手动启动的既有服务：仅复用，不由插件终止。
- 不同 Pi 若各自需要私有后台，会各自加载模型，占用各自的内存；不共享未知归属的私有进程。
- 首次冷启动额外包含模型加载时间。后续分类复用同一进程。

`CIRNO_RUNTIME_REUSE=0` 可用于验证完全由插件启动的私有服务，不复用独立启动的默认 18080 服务。例如：

```bash
CIRNO_RUNTIME_REUSE=0 ./scripts/start-pi-llama.sh
```

已配置网关用于读取对应 provider 的候选目录，并处理选择该 provider 时的正常回答。`http://127.0.0.1:8045/v1` 是模板示例，需替换为自己提供的回环服务，并同步 Pi provider 配置。项目不附带网关程序。

## 历史验证（2026-10-14）

- 真实 Pi 强制冷启动私有 llama.cpp，Gemma 返回合法分类；Pi 退出后该模型 PID 已退出。分类推理本身约12.94秒，不包含模型加载时间。
- 模拟未找到系统 llama.cpp，生产下载器取得约10.6MB官方包，校验 SHA-256，实际解压到项目目录，执行 `--version` 核实 build/commit。
- 已验证固定模型 URL 实际返回 `206` 和 `bytes 0-31/5335285728`，文件头为 GGUF，仅下载32字节检查地址与Range支持。
- 已验证约 5.34 GB 权重缓存复用，此轮未重复下载整个文件；缺权重自动触发下载、断点续传、服务忽略Range时重下、校验失败保护、错误Range保护均有模拟传输测试。
- 两次真实分类复用同一私有模型 PID；模拟父进程被强制终止后，后台检测EOF并回收该模型。
- 复用既有18080服务的真实分类通过；插件不负责终止该外部服务。
- Python共69项、Node共23项测试通过；额外覆盖压缩包路径越界、符号链接越界、缓存复用、完整临时包恢复、416恢复、后台取消、并发拒绝和关闭后重启。

复测命令：

```bash
.venv/bin/pytest -q
node --test packages/pi-extension/*.test.mjs
.venv/bin/ruff check .
.venv/bin/ruff format --check .
# 真实模型测试（需要自己的执行服务和凭据）：
CIRNO_LOCAL_BACKEND=llama-server CIRNO_RUNTIME_REUSE=0 .venv/bin/python scripts/pi-routing-smoke.py
CIRNO_LOCAL_BACKEND=llama-server .venv/bin/python scripts/pi-managed-lifecycle-smoke.py
```

冷启动与进程清理记录在 `.runtime/pi-managed-report.json`；热复用与父进程异常退出记录在 `.runtime/pi-managed-lifecycle-report.json`。报告由复测脚本生成，均被 Git 忽略且不随源码分发。这些是功能验证，不是分类准确率评估。
