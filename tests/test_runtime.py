import asyncio
import hashlib
import json
import sys

import httpx
import pytest

from cirno_route.config import Settings
from cirno_route.errors import ClassifierError
from cirno_route.node_runtime import NodeRuntime
from cirno_route.runtime import LlamaRuntime


def client_for(handler):
    return httpx.AsyncClient(
        base_url="http://127.0.0.1:18080",
        transport=httpx.MockTransport(handler),
        follow_redirects=False,
        trust_env=False,
    )


@pytest.mark.parametrize(
    "mutation, expected",
    [
        (lambda r: r["choices"][0].update(finish_reason="length"), "ROUTER_OUTPUT_TRUNCATED"),
        (lambda r: r.update(model="different-model"), "MODEL_VERSION_MISMATCH"),
        (lambda r: r["choices"][0]["message"].update(tool_calls=[{}]), "UNEXPECTED_MODEL_CHANNEL"),
        (
            lambda r: r["choices"][0]["message"].update(reasoning_content="thought"),
            "UNEXPECTED_MODEL_CHANNEL",
        ),
        (lambda r: r["choices"][0]["message"].update(content=None), "ROUTER_INVALID_OUTPUT"),
        (lambda r: r.update(choices=[]), "RUNTIME_INVALID_RESPONSE"),
    ],
)
async def test_invalid_response_channels_and_truncation(mutation, expected):
    response = {
        "model": "cirno-gemma-e4b",
        "choices": [{"finish_reason": "stop", "message": {"content": "{}"}}],
    }
    mutation(response)

    def handler(request):
        if request.url.path == "/apply-template":
            return httpx.Response(200, json={"prompt": "prompt"})
        if request.url.path == "/tokenize":
            return httpx.Response(200, json={"tokens": [1, 2]})
        body = json.loads(request.content)
        assert body["chat_template_kwargs"] == {"enable_thinking": False}
        assert body["reasoning_effort"] == "none" and "tools" not in body
        assert body["response_format"]["json_schema"]["schema"] == {}
        assert "schema" not in body["response_format"]
        return httpx.Response(200, json=response)

    async with client_for(handler) as client:
        with pytest.raises(ClassifierError, match=expected):
            await LlamaRuntime(Settings(), client).complete([], {})


async def test_real_token_length_prevents_generation():
    paths = []

    def handler(request):
        paths.append(request.url.path)
        body = (
            {"prompt": "prompt"}
            if request.url.path == "/apply-template"
            else {"tokens": [0] * 8000}
        )
        return httpx.Response(200, json=body)

    async with client_for(handler) as client:
        with pytest.raises(ClassifierError, match="CONTEXT_TOO_LARGE"):
            await LlamaRuntime(Settings(), client).complete([], {})
    assert "/v1/chat/completions" not in paths


async def test_missing_usage_stays_unknown():
    def handler(request):
        if request.url.path == "/apply-template":
            return httpx.Response(200, json={"prompt": "prompt"})
        if request.url.path == "/tokenize":
            return httpx.Response(200, json={"tokens": [1]})
        return httpx.Response(
            200,
            json={
                "model": "cirno-gemma-e4b",
                "choices": [{"finish_reason": "stop", "message": {"content": "{}"}}],
            },
        )

    async with client_for(handler) as client:
        _, usage = await LlamaRuntime(Settings(), client).complete([], {})
    assert usage == {"prompt_tokens": None, "completion_tokens": None}


async def test_redirect_is_not_followed():
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(307, headers={"location": "https://example.com/collect"})

    async with client_for(handler) as client:
        with pytest.raises(ClassifierError, match="RUNTIME_HTTP_ERROR"):
            await LlamaRuntime(Settings(), client).request("GET", "/props")
    assert calls == ["http://127.0.0.1:18080/props"]


@pytest.mark.parametrize("grammar_enforced", [True, False])
async def test_model_lock_checks_hash_template_build_and_file_changes(tmp_path, grammar_enforced):
    model = tmp_path / "test.gguf"
    model.write_bytes(b"test local weights")
    props = {
        "model_path": str(model),
        "chat_template": "test template",
        "build_info": "test-build",
        "default_generation_settings": {"n_ctx": 8192},
    }

    def handler(request):
        if request.url.path == "/props":
            return httpx.Response(200, json=props)
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "cirno-gemma-e4b"}]})
        if request.url.path == "/tokenize":
            return httpx.Response(200, json={"tokens": [1, 2]})
        if request.url.path == "/v1/chat/completions":
            return httpx.Response(
                200,
                json={
                    "model": "cirno-gemma-e4b",
                    "choices": [
                        {
                            "finish_reason": "stop",
                            "message": {
                                "content": json.dumps(
                                    {
                                        "answer": "SCHEMA_ENFORCED"
                                        if grammar_enforced
                                        else "NOT_ENFORCED"
                                    }
                                )
                            },
                        }
                    ],
                },
            )
        return httpx.Response(
            200,
            json={
                "prompt": "<|turn>system\nCIRNO_SYSTEM_SENTINEL<turn|>"
                "<|turn>user\nCIRNO_USER_SENTINEL<turn|>"
            },
        )

    async with client_for(handler) as client:
        runtime = LlamaRuntime(Settings(), client)
        if not grammar_enforced:
            with pytest.raises(ClassifierError, match="STRUCTURED_OUTPUT_UNVERIFIED"):
                await runtime.lock_model()
            return
        lock = await runtime.lock_model()
        assert lock.model_digest == hashlib.sha256(b"test local weights").hexdigest()
        await runtime.verify(lock)
        props["build_info"] = "new-build"
        with pytest.raises(ClassifierError, match="MODEL_VERSION_MISMATCH"):
            await runtime.verify(lock)
        props["build_info"] = "test-build"
        model.write_bytes(b"replaced weights")
        with pytest.raises(ClassifierError, match="MODEL_VERSION_MISMATCH"):
            await runtime.verify(lock)


async def native_pipe(settings, behavior):
    runtime = NodeRuntime(settings)
    code = "import sys,json,time\nfor line in sys.stdin:\n p=json.loads(line)\n " + behavior
    runtime.process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-u",
        "-c",
        code,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
    )
    return runtime


async def test_native_pipe_checks_reply_identity(settings):
    runtime = await native_pipe(
        settings, "print(json.dumps({'id':'wrong','result':{}}),flush=True)"
    )
    try:
        with pytest.raises(ClassifierError, match="RUNTIME_INVALID_RESPONSE"):
            await runtime.rpc("snapshot")
    finally:
        await runtime.close()


async def test_native_timeout_reaps_process_and_discards_late_reply(settings):
    runtime = await native_pipe(settings, "time.sleep(30)")
    process = runtime.process
    try:
        with pytest.raises(TimeoutError):
            async with asyncio.timeout(0.05):
                await runtime.rpc("complete")
        assert process.returncode is not None
        assert runtime.process is None
        with pytest.raises(ClassifierError, match="MODEL_UNAVAILABLE"):
            await runtime.rpc("snapshot")
    finally:
        await runtime.close()


async def test_native_complete_preserves_messages_schema_and_unknown_usage(settings):
    runtime = await native_pipe(
        settings,
        "assert p['method']=='complete' and p['body']['schema']=={'const':'safe'}; "
        "assert p['body']['messages']==[{'role':'user','content':'test'}]; "
        "print(json.dumps({'id':p['id'],'result':{'text':'\\\"safe\\\"',"
        "'usage':{'prompt_tokens':True,'completion_tokens':-1}}}),flush=True)",
    )
    try:
        text, usage = await runtime.complete(
            [{"role": "user", "content": "test"}], {"const": "safe"}
        )
        assert text == '"safe"'
        assert usage == {"prompt_tokens": None, "completion_tokens": None}
    finally:
        await runtime.close()
