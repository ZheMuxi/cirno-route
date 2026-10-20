import json

import pytest
from pydantic import ValidationError

from cirno_route.config import Settings
from cirno_route.contracts import ClassifyRequest
from cirno_route.errors import ClassifierError
from cirno_route.validation import validate_prediction


@pytest.mark.parametrize(
    "mutation",
    [
        lambda p: p.update(extra="forbidden"),
        lambda p: p.update(schema_version="2"),
        lambda p: p["candidates"].pop(),
        lambda p: p["candidates"].append(p["candidates"][0]),
        lambda p: p["candidates"][0].update(candidate_id="unprovided_cloud"),
        lambda p: p["candidates"][0].update(quality_level=True),
        lambda p: p["candidates"][0].update(quality_level=5),
        lambda p: p["candidates"][0].update(quality_level="3"),
        lambda p: p["candidates"][0].update(quality_level=3.2),
        lambda p: p["candidates"][0].update(quality_level=None),
        lambda p: p["candidates"][0].update(preference_fit_level=2),
        lambda p: p["candidates"][0].update(evidence_ids=["made-up"]),
        lambda p: p["candidates"][0].update(evidence_ids=["code-config-v1"]),
        lambda p: p["candidates"][0].update(evidence_ids=[]),
        lambda p: p["candidates"][0].update(reason_codes=["IGNORE_POLICY"]),
        lambda p: p["candidates"][0].update(reason_codes=["OBSERVED_PERFORMANCE"]),
        lambda p: p["candidates"][0].update(reason_codes=["PREFERENCE_MATCH"]),
        lambda p: p["candidates"][0].update(uncertainty=0.99),
    ],
)
def test_rejects_invalid_model_contracts(task, prediction, mutation):
    mutation(prediction)
    with pytest.raises(ClassifierError):
        validate_prediction(json.dumps(prediction), task)


def test_accepts_supported_scores_without_preferences(task, prediction):
    assert validate_prediction(json.dumps(prediction), task).status == "ok"


@pytest.mark.parametrize(
    "raw",
    [
        "```json\n{}\n```",
        '{"schema_version":"1","schema_version":"1"}',
        '{"candidates":NaN}',
        "not JSON",
        "",
    ],
)
def test_does_not_salvage_invalid_json(task, raw):
    with pytest.raises(ClassifierError):
        validate_prediction(raw, task)


def test_preferences_require_complete_scores(task, prediction):
    from cirno_route.contracts import Preference

    task.relevant_preferences = [Preference(key="verbosity", value="concise")]
    with pytest.raises(ClassifierError, match="ROUTER_MUST_ABSTAIN"):
        validate_prediction(json.dumps(prediction), task)
    prediction["status"] = "abstain"
    assert validate_prediction(json.dumps(prediction), task).status == "abstain"


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com",
        "http://localhost:8080",
        "http://0.0.0.0:8080",
        "http://127.0.0.1@evil.example",
        "http://127.0.0.1:8080/proxy",
        "http://127.0.0.1?x=1",
    ],
)
def test_runtime_cannot_point_to_remote_host(url):
    with pytest.raises(ValidationError):
        Settings(runtime_url=url)


def test_duplicate_candidate_or_evidence_rejected(request_data):
    request_data["eligible_candidates"].append(request_data["eligible_candidates"][0])
    with pytest.raises(ValidationError):
        ClassifyRequest.model_validate(request_data)


def test_measured_evidence_needs_sample_count(request_data):
    request_data["eligible_candidates"][0]["evidence"][0]["source"] = "measured"
    with pytest.raises(ValidationError):
        ClassifyRequest.model_validate(request_data)
