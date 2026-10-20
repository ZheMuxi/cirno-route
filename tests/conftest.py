import json
from pathlib import Path

import pytest

from cirno_route.config import Settings
from cirno_route.contracts import ClassifyRequest, RuntimeLock


@pytest.fixture
def request_data():
    return json.loads((Path(__file__).parents[1] / "examples/coding.json").read_text())


@pytest.fixture
def task(request_data):
    return ClassifyRequest.model_validate(request_data)


@pytest.fixture
def settings(tmp_path):
    lock = RuntimeLock(
        model="cirno-gemma-e4b",
        checkpoint="test",
        model_path=str(tmp_path / "model.gguf"),
        model_digest="test",
        model_size=10,
        model_mtime_ns=1,
        template_sha256="test",
        runtime_version="test",
        context_tokens=8192,
    )
    path = tmp_path / "model-lock.json"
    path.write_text(lock.model_dump_json())
    return Settings(lock_file=str(path), fallback_order=["forbidden", "demo_general", "demo_code"])


@pytest.fixture
def prediction(task):
    return {
        "schema_version": "1",
        "status": "ok",
        "candidates": [
            {
                "candidate_id": c.candidate_id,
                "quality_level": score,
                "preference_fit_level": None,
                "uncertainty": "medium",
                "evidence_ids": [c.evidence[0].evidence_id],
                "reason_codes": ["TASK_MATCH"],
            }
            for c, score in zip(task.eligible_candidates, [2, 4, 0], strict=True)
        ],
    }


class FakeRuntime:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []
        self.verifies = 0

    async def verify(self, _lock):
        self.verifies += 1

    async def complete(self, messages, _schema):
        self.calls.append([dict(m) for m in messages])
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        return value, {"prompt_tokens": 500, "completion_tokens": 100}

    async def close(self):
        pass
