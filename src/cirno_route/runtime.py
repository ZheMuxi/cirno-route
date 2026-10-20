"""One verified backend: the user's existing local llama.cpp server."""

import asyncio
import hashlib
from pathlib import Path

import httpx

from .config import Settings
from .contracts import RuntimeLock
from .errors import ClassifierError


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def read_token(path: str) -> str:
    try:
        token = Path(path).read_text().strip()
    except OSError as exc:
        raise ClassifierError("TOKEN_MISSING") from exc
    if len(token) < 32:
        raise ClassifierError("TOKEN_INVALID")
    return token


class LlamaRuntime:
    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None):
        self.settings = settings
        self.client = client or httpx.AsyncClient(
            base_url=settings.runtime_url,
            headers={"Authorization": f"Bearer {read_token(settings.runtime_token_file)}"},
            timeout=settings.timeout_seconds,
            trust_env=False,
            follow_redirects=False,
        )

    async def close(self):
        await self.client.aclose()

    async def request(self, method: str, path: str, body=None):
        try:
            async with self.client.stream(method, path, json=body) as response:
                if response.status_code != 200:
                    raise ClassifierError("RUNTIME_HTTP_ERROR")
                chunks = bytearray()
                async for chunk in response.aiter_bytes():
                    chunks.extend(chunk)
                    if len(chunks) > 2_000_000:
                        raise ClassifierError("RUNTIME_RESPONSE_TOO_LARGE")
                from .validation import strict_json

                value = strict_json(chunks.decode())
                if not isinstance(value, dict):
                    raise ValueError("expected object")
                return value
        except httpx.TimeoutException as exc:
            raise ClassifierError("ROUTER_TIMEOUT") from exc
        except httpx.RequestError as exc:
            raise ClassifierError("MODEL_UNAVAILABLE") from exc
        except (ValueError, RecursionError) as exc:
            raise ClassifierError("RUNTIME_INVALID_RESPONSE") from exc

    async def snapshot(self):
        props = await self.request("GET", "/props")
        models = await self.request("GET", "/v1/models")
        try:
            if self.settings.model not in {m["id"] for m in models["data"]}:
                raise ClassifierError("MODEL_VERSION_MISMATCH")
            snapshot = {
                "model_path": str(await asyncio.to_thread(Path(props["model_path"]).resolve)),
                "template_sha256": sha256(props["chat_template"]),
                "runtime_version": props["build_info"],
                "context_tokens": props["default_generation_settings"]["n_ctx"],
            }
            if not props["chat_template"] or snapshot["context_tokens"] < (
                self.settings.context_tokens
            ):
                raise ClassifierError("RUNTIME_CONFIGURATION_MISMATCH")
            return snapshot
        except (KeyError, TypeError) as exc:
            raise ClassifierError("RUNTIME_INVALID_RESPONSE") from exc

    async def lock_model(self) -> RuntimeLock:
        snapshot = await self.snapshot()
        model_path = Path(snapshot["model_path"])
        before = await asyncio.to_thread(model_path.stat)

        def digest_file():
            with model_path.open("rb") as stream:
                return hashlib.file_digest(stream, "sha256").hexdigest()

        digest = await asyncio.to_thread(digest_file)
        after = await asyncio.to_thread(model_path.stat)
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ClassifierError("MODEL_CHANGED_DURING_LOCK")
        # Check actual chat rendering, not just acceptance of a system field.
        rendered = await self.request(
            "POST",
            "/apply-template",
            {
                "model": self.settings.model,
                "messages": [
                    {"role": "system", "content": "CIRNO_SYSTEM_SENTINEL"},
                    {"role": "user", "content": "CIRNO_USER_SENTINEL"},
                ],
                "chat_template_kwargs": {"enable_thinking": False},
            },
        )
        prompt = rendered.get("prompt", "")
        if (
            "<|turn>system\nCIRNO_SYSTEM_SENTINEL" not in prompt
            or "<|turn>user\nCIRNO_USER_SENTINEL" not in prompt
            or "<|think|>" in prompt
        ):
            raise ClassifierError("CHAT_TEMPLATE_UNVERIFIED")
        # Some llama.cpp builds accept but silently ignore a wrongly nested response_format.
        # Prove the grammar wins over a conflicting prompt before freezing this runtime.
        raw, _ = await self.complete(
            [{"role": "user", "content": 'Return exactly {"answer":"NOT_ENFORCED"}'}],
            {
                "type": "object",
                "properties": {"answer": {"type": "string", "const": "SCHEMA_ENFORCED"}},
                "required": ["answer"],
                "additionalProperties": False,
            },
        )
        from .validation import strict_json

        try:
            if strict_json(raw) != {"answer": "SCHEMA_ENFORCED"}:
                raise ValueError("grammar not enforced")
        except ValueError as exc:
            raise ClassifierError("STRUCTURED_OUTPUT_UNVERIFIED") from exc
        return RuntimeLock(
            model=self.settings.model,
            checkpoint=self.settings.checkpoint,
            model_digest=digest,
            model_size=after.st_size,
            model_mtime_ns=after.st_mtime_ns,
            **snapshot,
        )

    async def verify(self, lock: RuntimeLock):
        snapshot = await self.snapshot()
        try:
            stat = await asyncio.to_thread(Path(lock.model_path).stat)
        except OSError as exc:
            raise ClassifierError("MODEL_UNAVAILABLE") from exc
        if (
            lock.model != self.settings.model
            or lock.checkpoint != self.settings.checkpoint
            or any(getattr(lock, k) != v for k, v in snapshot.items())
            or (stat.st_size, stat.st_mtime_ns) != (lock.model_size, lock.model_mtime_ns)
        ):
            raise ClassifierError("MODEL_VERSION_MISMATCH")

    async def complete(self, messages: list[dict], schema: dict):
        # Get the actual template token count to prevent silent context truncation.
        template = await self.request(
            "POST",
            "/apply-template",
            {
                "model": self.settings.model,
                "messages": messages,
                "chat_template_kwargs": {"enable_thinking": False},
            },
        )
        if not isinstance(template.get("prompt"), str):
            raise ClassifierError("RUNTIME_INVALID_RESPONSE")
        tokenized = await self.request(
            "POST",
            "/tokenize",
            {
                "content": template["prompt"],
                "add_special": True,
                "parse_special": True,
            },
        )
        tokens = tokenized.get("tokens")
        if not isinstance(tokens, list):
            raise ClassifierError("RUNTIME_INVALID_RESPONSE")
        if len(tokens) + self.settings.max_output_tokens + 32 > self.settings.context_tokens:
            raise ClassifierError("CONTEXT_TOO_LARGE")
        response = await self.request(
            "POST",
            "/v1/chat/completions",
            {
                "model": self.settings.model,
                "messages": messages,
                "stream": False,
                "temperature": 0.0,
                "seed": 42,
                "max_tokens": self.settings.max_output_tokens,
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {"name": "cirno_router", "strict": True, "schema": schema},
                },
                "chat_template_kwargs": {"enable_thinking": False},
                "reasoning_effort": "none",
                "cache_prompt": True,
            },
        )
        try:
            choice = response["choices"][0]
            if response["model"] != self.settings.model:
                raise ClassifierError("MODEL_VERSION_MISMATCH")
            if choice["finish_reason"] != "stop":
                raise ClassifierError("ROUTER_OUTPUT_TRUNCATED")
            message = choice["message"]
            if message.get("tool_calls") or message.get("reasoning_content"):
                raise ClassifierError("UNEXPECTED_MODEL_CHANNEL")
            raw = message["content"]
            if not isinstance(raw, str):
                raise ClassifierError("ROUTER_INVALID_OUTPUT")
            usage = response.get("usage", {})
            counts = {
                k: v if type(v) is int and v >= 0 else None
                for k in ("prompt_tokens", "completion_tokens")
                for v in [usage.get(k)]
            }
            return raw, counts
        except (KeyError, IndexError, TypeError, AttributeError) as exc:
            raise ClassifierError("RUNTIME_INVALID_RESPONSE") from exc
