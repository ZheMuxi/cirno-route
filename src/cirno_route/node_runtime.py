"""Default native llama.cpp binding over private pipes; keeps the existing classifier contract."""

import asyncio
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

from .errors import ClassifierError
from .runtime import LlamaRuntime
from .validation import strict_json


class NodeRuntime(LlamaRuntime):
    def __init__(self, settings):
        # Reuse the verified-model lock/probe logic, but never create an HTTP client.
        self.settings = settings
        self.process = None
        self.info = None
        self._request_lock = asyncio.Lock()

    async def start(self, model_path):
        root = await asyncio.to_thread(Path(__file__).resolve)
        worker = root.parents[2] / "packages/pi-extension/native-runtime"
        if not await asyncio.to_thread(
            (worker / "node_modules/node-llama-cpp/package.json").is_file
        ):
            raise ClassifierError("NATIVE_DEPENDENCY_MISSING")
        try:
            self.process = await asyncio.create_subprocess_exec(
                os.environ.get("CIRNO_NODE_BIN", "node"),
                str(worker / "runtime.mjs"),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=sys.stderr,
                limit=2_000_001,
            )
            async with asyncio.timeout(90):
                self.info = await self.rpc(
                    "init",
                    {"modelPath": str(model_path), "contextTokens": self.settings.context_tokens},
                )
        except BaseException:
            await self.close()
            raise

    async def rpc(self, method, body=None):
        async with self._request_lock:
            if self.process is None or self.process.returncode is not None:
                raise ClassifierError("MODEL_UNAVAILABLE")
            request_id = str(uuid4())
            packet = json.dumps({"id": request_id, "method": method, "body": body}).encode() + b"\n"
            if len(packet) > 2_000_000:
                raise ClassifierError("CONTEXT_TOO_LARGE")
            try:
                self.process.stdin.write(packet)
                await self.process.stdin.drain()
                line = await self.process.stdout.readline()
                value = strict_json(line.decode())
                if not isinstance(value, dict) or value.get("id") != request_id:
                    raise ValueError("invalid packet")
                if "error" in value:
                    code = value["error"]
                    if not isinstance(code, str) or not code.isupper() or len(code) > 80:
                        raise ValueError("invalid error")
                    raise ClassifierError(code)
                if not isinstance(value.get("result"), dict):
                    raise ValueError("invalid result")
                return value["result"]
            except (ValueError, UnicodeError, RecursionError) as exc:
                raise ClassifierError("RUNTIME_INVALID_RESPONSE") from exc
            except (BrokenPipeError, ConnectionError) as exc:
                raise ClassifierError("MODEL_UNAVAILABLE") from exc
            except asyncio.CancelledError:
                # A timed-out reply must never be consumed as the next request's response.
                await self.close()
                raise

    async def snapshot(self):
        return await self.rpc("snapshot")

    async def request(self, method, path, body=None):
        if method == "POST" and path == "/apply-template":
            return await self.rpc("render", {"messages": body["messages"]})
        raise ClassifierError("NATIVE_METHOD_UNSUPPORTED")

    async def complete(self, messages, schema):
        result = await self.rpc(
            "complete",
            {"messages": messages, "schema": schema, "maxTokens": self.settings.max_output_tokens},
        )
        if not isinstance(result.get("text"), str) or not isinstance(result.get("usage"), dict):
            raise ClassifierError("RUNTIME_INVALID_RESPONSE")
        usage = {
            key: value if type(value := result["usage"].get(key)) is int and value >= 0 else None
            for key in ("prompt_tokens", "completion_tokens")
        }
        return result["text"], usage

    async def close(self):
        process, self.process = self.process, None
        if process is None:
            return
        if process.returncode is None:
            if process.stdin:
                process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), 3)
            except TimeoutError:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                await process.wait()
