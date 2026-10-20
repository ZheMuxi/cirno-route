"""Pi-owned JSONL worker. stdin EOF (including parent death) releases owned inference processes."""

import argparse
import asyncio
import json
import os
import signal
import socket
import sys
import time
from pathlib import Path

import httpx

from .classifier import Classifier
from .cli import private_write
from .config import Settings, load_settings
from .contracts import ClassifyRequest, RuntimeLock
from .errors import ClassifierError
from .provision import MANIFEST, ensure_binary, ensure_model, provision_lock
from .research import CapabilityResearch, ResearchRequest
from .runtime import LlamaRuntime, read_token
from .validation import strict_json


class ManagedClassifier:
    def __init__(self, settings, directory, *, reuse_existing=True):
        self.original = settings
        self.settings = settings.model_copy(deep=True)
        self.directory = directory
        self.reuse_existing = reuse_existing
        self.process = None
        self.runtime = None
        self.classifier = None
        self.mode = None

    async def ensure(self, progress):
        if self.classifier is not None:
            if self.process is not None and self.process.returncode is not None:
                await self.close()
            else:
                return
        if self.original.checkpoint != Settings().checkpoint:
            raise ClassifierError("AUTO_INSTALL_CHECKPOINT_UNSUPPORTED")
        self.settings = self.original.model_copy(deep=True)
        if self.reuse_existing:
            try:
                lock = RuntimeLock.model_validate_json(
                    await asyncio.to_thread(Path(self.original.lock_file).read_text)
                )
                candidate = LlamaRuntime(self.settings)
                try:
                    async with asyncio.timeout(3):
                        await candidate.verify(lock)
                    self.runtime = candidate
                    self.classifier = Classifier(self.settings, candidate)
                    self.mode = "reused"
                    progress("ready", mode=self.mode)
                    return
                finally:
                    if self.runtime is not candidate:
                        await candidate.close()
            except (OSError, ValueError, ClassifierError, TimeoutError):
                pass
        async with provision_lock(self.directory, progress):
            model = await ensure_model(self.settings, self.directory, progress)
            binary = await ensure_binary(self.directory, progress)
            progress("starting-model")
            with socket.socket() as reserve:
                reserve.bind(("127.0.0.1", 0))
                port = reserve.getsockname()[1]
            self.settings.runtime_url = f"http://127.0.0.1:{port}"
            self.settings.lock_file = str(self.directory / "managed-model-lock.json")
            self.process = await asyncio.create_subprocess_exec(
                str(binary),
                "--offline",
                "-m",
                str(model),
                "--no-mmproj",
                "--jinja",
                "-c",
                str(self.settings.context_tokens),
                "-ngl",
                "all",
                "--reasoning",
                "off",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--alias",
                self.settings.model,
                "--parallel",
                "1",
                "--no-webui",
                "--api-key-file",
                self.settings.runtime_token_file,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=sys.stderr,
                stderr=sys.stderr,
            )
            self.runtime = LlamaRuntime(self.settings)
            deadline = time.monotonic() + 90
            async with httpx.AsyncClient(trust_env=False, timeout=2) as health:
                while True:
                    if self.process.returncode is not None:
                        raise ClassifierError("LOCAL_MODEL_START_FAILED")
                    try:
                        response = await health.get(
                            self.settings.runtime_url + "/health",
                            headers={
                                "Authorization": "Bearer "
                                + read_token(self.settings.runtime_token_file)
                            },
                        )
                        if response.status_code == 200 and response.json().get("status") == "ok":
                            break
                    except (httpx.HTTPError, ValueError):
                        pass
                    if time.monotonic() >= deadline:
                        raise ClassifierError("LOCAL_MODEL_START_TIMEOUT")
                    await asyncio.sleep(0.25)
            progress("checking-model")
            verified = None
            for path in (self.settings.lock_file, self.original.lock_file):
                try:
                    lock = RuntimeLock.model_validate_json(
                        await asyncio.to_thread(Path(path).read_text)
                    )
                    await self.runtime.verify(lock)
                    verified = lock
                    break
                except (OSError, ValueError, ClassifierError):
                    continue
            if verified is None:
                # A newly downloaded/moved model is locked only after template/schema probes.
                verified = await self.runtime.lock_model()
            if (
                verified.model_digest != MANIFEST["model"]["sha256"]
                or verified.runtime_version != MANIFEST["runtime"]["version"]
            ):
                raise ClassifierError("DOWNLOADED_RUNTIME_INVALID")
            private_write(Path(self.settings.lock_file), verified.model_dump_json(indent=2) + "\n")
            self.classifier = Classifier(self.settings, self.runtime)
            self.mode = "managed"
            progress("ready", mode=self.mode)

    async def classify(self, request, progress):
        try:
            async with asyncio.timeout(7200):
                await self.ensure(progress)
            result = await self.classifier.classify(request)
            result.metadata["local_backend"] = {
                "mode": self.mode,
                "pid": self.process.pid if self.process else None,
                "runtime_url": self.settings.runtime_url,
            }
            if result.source == "rules" and "MODEL_UNAVAILABLE" in result.reason_codes:
                await self.close()  # The next request can rebuild a disappeared backend.
            return result.model_dump()
        except BaseException:
            await self.close()
            raise

    async def close(self):
        if self.runtime:
            await self.runtime.close()
        self.runtime = self.classifier = None
        if self.process is not None:
            if self.process.returncode is None:
                try:
                    self.process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(self.process.wait(), 3)
                except TimeoutError:
                    self.process.kill()
                    await self.process.wait()
            self.process = None


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


async def serve(settings, directory, *, reuse_existing=True):
    backend = ManagedClassifier(settings, directory, reuse_existing=reuse_existing)
    research = CapabilityResearch(settings.capability_research)
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    reader = asyncio.StreamReader(limit=65536)
    transport, _ = await loop.connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin
    )
    active = None
    read_task = None
    stop_task = asyncio.create_task(stop.wait())

    async def handle(packet):
        request_id = packet["id"]
        try:
            progress = lambda stage, **details: emit(  # noqa: E731
                {"type": "progress", "id": request_id, "stage": stage, **details}
            )
            if packet.get("method") == "research":
                result = await research.run(
                    ResearchRequest.model_validate(packet["body"]), progress
                )
                emit({"type": "result", "id": request_id, "result": result})
                return
            if packet.get("method", "classify") != "classify":
                raise ClassifierError("UNKNOWN_METHOD")
            request = ClassifyRequest.model_validate(packet["body"])
            if len(request.model_dump_json().encode()) > settings.max_input_bytes:
                raise ClassifierError("CONTEXT_TOO_LARGE")
            result = await backend.classify(
                request,
                progress,
            )
            emit({"type": "result", "id": request_id, "result": result})
        except Exception as exc:
            code = exc.code if isinstance(exc, ClassifierError) else "LOCAL_BACKEND_ERROR"
            emit({"type": "error", "id": request_id, "code": code})

    try:
        while not stop.is_set():
            read_task = asyncio.create_task(reader.readline())
            done, _ = await asyncio.wait(
                [read_task, stop_task], return_when=asyncio.FIRST_COMPLETED
            )
            if stop_task in done:
                break
            line = read_task.result()
            if not line:
                break
            packet = strict_json(line.decode())
            if (
                not isinstance(packet, dict)
                or not isinstance(packet.get("id"), str)
                or len(packet["id"]) > 64
            ):
                break
            if active and not active.done():
                emit({"type": "error", "id": packet["id"], "code": "CLASSIFIER_BUSY"})
                continue
            active = asyncio.create_task(handle(packet))
    finally:
        for task in (active, read_task, stop_task):
            if task:
                task.cancel()
        await asyncio.gather(
            *(t for t in (active, read_task, stop_task) if t), return_exceptions=True
        )
        transport.close()
        await backend.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--no-reuse", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        settings = load_settings(args.config)
        asyncio.run(
            serve(
                settings,
                args.config.resolve().parent / ".runtime",
                reuse_existing=not args.no_reuse,
            )
        )
    except Exception:
        # Diagnostics never echo a task, credentials, download redirect URLs or provider bodies.
        print("LOCAL_BACKEND_START_FAILED", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
