import argparse
import asyncio
import json
import os
import secrets
import sys
from pathlib import Path

import uvicorn

from .api import create_app
from .classifier import Classifier
from .config import load_settings
from .contracts import ClassifyRequest
from .errors import ClassifierError
from .runtime import LlamaRuntime, read_token
from .validation import strict_json


def private_write(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(text)
    temporary.chmod(0o600)
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description="CirnoRoute 本地候选模型分类器")
    parser.add_argument("--config", type=Path, default=Path("config.json"))
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init", help="生成本机令牌，不下载模型")
    commands.add_parser("lock-model", help="校验模板并锁定现有权重、运行时")
    classify = commands.add_parser("classify", help="从 JSON 文件或 stdin 分类")
    classify.add_argument("input", help="JSON 文件路径；- 表示标准输入")
    classify.add_argument("--rules", action="store_true", help="显式运行规则基线，不调用模型")
    serve = commands.add_parser("serve", help="启动本机 API")
    serve.add_argument("--port", type=int, default=18081)
    args = parser.parse_args()
    try:
        settings = load_settings(args.config)
        if args.command == "init":
            for filename in (settings.runtime_token_file, settings.api_token_file):
                if not Path(filename).exists():
                    private_write(Path(filename), secrets.token_urlsafe(32) + "\n")
            print(json.dumps({"status": "initialized"}))
            return
        if args.command == "serve":
            if not 1 <= args.port <= 65535:
                raise ValueError("invalid port")
            runtime = LlamaRuntime(settings)
            app = create_app(Classifier(settings, runtime), read_token(settings.api_token_file))
            uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False)
            return

        async def run():
            if args.command == "lock-model":
                runtime = LlamaRuntime(settings)
                try:
                    lock = await runtime.lock_model()
                    private_write(Path(settings.lock_file), lock.model_dump_json(indent=2) + "\n")
                    return {"status": "locked", "runtime": lock.model_dump()}
                finally:
                    await runtime.close()

            def read_input():
                if args.input == "-":
                    return sys.stdin.buffer.read(65537)
                with Path(args.input).open("rb") as stream:
                    return stream.read(65537)

            raw = await asyncio.to_thread(read_input)
            if len(raw) > 65536:
                raise ClassifierError("REQUEST_TOO_LARGE")
            request = ClassifyRequest.model_validate(strict_json(raw.decode()))
            runtime = None if args.rules else LlamaRuntime(settings)
            try:
                return (
                    await Classifier(settings, runtime).classify(request, rules_only=args.rules)
                ).model_dump()
            finally:
                if runtime:
                    await runtime.close()

        result = asyncio.run(run())
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if result.get("status") == "blocked":
            raise SystemExit(2)
    except (ValueError, OSError, ClassifierError) as exc:
        code = exc.code if isinstance(exc, ClassifierError) else "INVALID_INPUT_OR_CONFIGURATION"
        print(json.dumps({"error": code}), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
