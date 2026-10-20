import asyncio
import copy
import itertools
import json
from importlib.resources import files

import pytest
from conftest import FakeRuntime

from cirno_route.classifier import Classifier
from cirno_route.errors import ClassifierError

V3_PROMPT = files("cirno_route").joinpath("resources/router-system-v3.txt").read_text()


def classifier(settings, runtime):
    return Classifier(
        settings,
        runtime,
        pipeline_version="v3-single",
        prompt_version="router-system-v3",
        system_prompt=V3_PROMPT,
    )


def assessment(prediction, task):
    rows = copy.deepcopy(prediction["candidates"])
    for row in rows:
        card = next(c for c in task.eligible_candidates if c.candidate_id == row["candidate_id"])
        row["basis_excerpt"] = card.evidence[0].summary[:80]
        row["evidence_status"] = "supported" if row["quality_level"] else "unsupported"
        if row["quality_level"] == 0:
            row["reason_codes"] = ["CAPABILITY_LIMIT"]
    return {"input_status": "ready", "candidates": rows}


def mark_unknown(row):
    row.update(
        basis_excerpt="",
        evidence_status="insufficient",
        quality_level=None,
        preference_fit_level=None,
        uncertainty="high",
        reason_codes=["EVIDENCE_INSUFFICIENT"],
        evidence_ids=[],
    )


async def test_all_permutations_have_identical_inference_and_restore_caller_order(
    settings, task, prediction
):
    class RecordingRuntime(FakeRuntime):
        async def complete(self, messages, schema):
            self.schemas.append(copy.deepcopy(schema))
            return await super().complete(messages, schema)

    raw = json.dumps(assessment(prediction, task))
    runtime = RecordingRuntime(*([raw] * 6))
    runtime.schemas = []
    engine = classifier(settings, runtime)
    hashes, constraints = set(), set()
    for cards in itertools.permutations(task.eligible_candidates):
        request = task.model_copy(deep=True)
        request.eligible_candidates = list(cards)
        original = request.model_dump()
        result = await engine.classify(request)
        assert result.status == "ok" and result.source == "gemma"
        assert [r.candidate_id for r in result.prediction.candidates] == [
            c.candidate_id for c in cards
        ]
        assert request.model_dump() == original
        assert {r.candidate_id: r.quality_level for r in result.prediction.candidates} == {
            r["candidate_id"]: r["quality_level"] for r in prediction["candidates"]
        }
        hashes.add(result.metadata["model_input_sha256"])
        constraints.add(result.metadata["output_constraint_sha256"])
    assert len(hashes) == len(constraints) == 1
    assert all(call == runtime.calls[0] for call in runtime.calls)
    assert all(schema == runtime.schemas[0] for schema in runtime.schemas)


async def test_missing_input_abstains_from_model_judgment(settings, task, prediction):
    value = assessment(prediction, task)
    value["input_status"] = "missing"
    for row in value["candidates"]:
        mark_unknown(row)
    runtime = FakeRuntime(json.dumps(value))
    result = await classifier(settings, runtime).classify(task)
    assert result.source == "gemma" and result.status == "abstain"
    assert all(row.quality_level is None for row in result.prediction.candidates)
    assert result.metadata["input_status"] == "missing"
    assert result.reason_codes == ["ROUTER_ABSTAIN"]
    assert runtime.verifies == 2
    assert task.task.text not in json.dumps(result.metadata)


@pytest.mark.parametrize("empty_card", [False, True])
async def test_partial_unknown_preserves_other_model_scores(settings, task, prediction, empty_card):
    value = assessment(prediction, task)
    mark_unknown(value["candidates"][0])
    if empty_card:
        task.eligible_candidates[0].evidence = []
    result = await classifier(settings, FakeRuntime(json.dumps(value))).classify(task)
    assert result.source == "gemma" and result.status == "abstain"
    assert [row.quality_level for row in result.prediction.candidates] == [None, 4, 0]
    assert result.metadata["input_status"] == "ready"
    assert result.metadata["candidate_evidence_status"][
        task.eligible_candidates[0].candidate_id
    ] == ("insufficient")


@pytest.mark.parametrize(
    "error", ["missing_with_score", "insufficient_with_score", "false_zero", "low"]
)
async def test_inconsistent_assessments_fail_closed_even_if_runtime_ignores_grammar(
    settings, task, prediction, error
):
    value = assessment(prediction, task)
    if error == "missing_with_score":
        value["input_status"] = "missing"
    elif error == "insufficient_with_score":
        value["candidates"][0]["evidence_status"] = "insufficient"
    elif error == "false_zero":
        value["candidates"][0]["evidence_status"] = "unsupported"
    else:
        value["candidates"][0]["uncertainty"] = "low"
    runtime = FakeRuntime(json.dumps(value), json.dumps(value))
    result = await classifier(settings, runtime).classify(task)
    assert result.status == "abstain" and result.source == "rules"
    assert result.reason_codes == ["ROUTER_ASSESSMENT_MISMATCH"]
    assert len(runtime.calls) == 2
    assert all(row.quality_level is None for row in result.prediction.candidates)


async def test_v3_still_rejects_cross_candidate_evidence(settings, task, prediction):
    value = assessment(prediction, task)
    value["candidates"][0]["evidence_ids"] = value["candidates"][1]["evidence_ids"]
    raw = json.dumps(value)
    result = await classifier(settings, FakeRuntime(raw, raw)).classify(task)
    assert result.source == "rules" and result.reason_codes == ["EVIDENCE_INVALID"]


async def test_v3_rejects_invented_evidence_excerpt(settings, task, prediction):
    value = assessment(prediction, task)
    value["candidates"][0]["basis_excerpt"] = "Invented permission to access all private databases."
    raw = json.dumps(value)
    result = await classifier(settings, FakeRuntime(raw, raw)).classify(task)
    assert result.source == "rules" and result.reason_codes == ["EVIDENCE_INVALID"]


async def test_v3_postflight_version_mismatch_discards_judgments(settings, task, prediction):
    class ChangedRuntime(FakeRuntime):
        async def verify(self, _lock):
            self.verifies += 1
            if self.verifies == 2:
                raise ClassifierError("MODEL_VERSION_MISMATCH")

    result = await classifier(
        settings, ChangedRuntime(json.dumps(assessment(prediction, task)))
    ).classify(task)
    assert result.source == "rules" and result.reason_codes == ["MODEL_VERSION_MISMATCH"]
    assert "input_status" not in result.metadata
    assert "candidate_evidence_status" not in result.metadata


def independent_classifier(settings, runtime):
    return Classifier(
        settings,
        runtime,
        pipeline_version="v3",
        prompt_version="router-system-v3",
        system_prompt=V3_PROMPT,
    )


async def test_independent_pipeline_all_permutations_and_no_other_candidate_context(
    settings, task, prediction
):
    rows = sorted(assessment(prediction, task)["candidates"], key=lambda c: c["candidate_id"])
    batch = [json.dumps({"input_status": "ready"})]
    for row in rows:
        batch.append(
            json.dumps(
                {
                    k: row[k]
                    for k in ("candidate_id", "basis_excerpt", "evidence_status", "evidence_ids")
                }
            )
        )
        if row["evidence_status"] == "unsupported":
            batch.append(json.dumps({"explicit_limit": True}))
        if row["evidence_status"] == "supported":
            batch.append(json.dumps({"input_status": "ready", "candidates": [row]}))
    runtime = FakeRuntime(*(batch * 6))
    engine = independent_classifier(settings, runtime)
    hashes = set()
    for cards in itertools.permutations(task.eligible_candidates):
        request = task.model_copy(update={"eligible_candidates": list(cards)}, deep=True)
        original = request.model_dump()
        result = await engine.classify(request)
        assert result.source == "gemma" and result.status == "ok"
        assert len(result.metadata["attempts"]) == len(batch)
        assert [r.candidate_id for r in result.prediction.candidates] == [
            c.candidate_id for c in cards
        ]
        assert request.model_dump() == original
        hashes.add(result.metadata["model_input_sha256"])
    assert len(hashes) == 1
    assert all(
        runtime.calls[i : i + len(batch)] == runtime.calls[: len(batch)]
        for i in range(0, len(runtime.calls), len(batch))
    )
    gate_payload = json.loads(runtime.calls[0][1]["content"])
    assert "eligible_candidates" not in gate_payload
    for call in runtime.calls[1 : len(batch)]:
        data = json.loads(call[1]["content"])
        if isinstance(data, dict):
            assert len(data["eligible_candidates"]) == 1
        else:
            assert isinstance(data, list)  # Literal-evidence check receives no task or model name.


async def test_independent_missing_input_skips_candidate_calls(settings, task):
    runtime = FakeRuntime('{"input_status":"missing"}')
    result = await independent_classifier(settings, runtime).classify(task)
    assert result.source == "gemma" and result.status == "abstain"
    assert len(runtime.calls) == 1 and runtime.verifies == 2
    assert all(r.quality_level is None for r in result.prediction.candidates)


async def test_independent_pipeline_has_one_total_deadline(settings, task):
    class SlowRuntime(FakeRuntime):
        async def complete(self, messages, schema):
            if len(schema.get("properties", {})) == 1:
                return '{"input_status":"ready"}', {"prompt_tokens": 10, "completion_tokens": 5}
            await asyncio.sleep(0.2)

    settings.timeout_seconds = 0.02
    result = await independent_classifier(settings, SlowRuntime()).classify(task)
    assert result.source == "rules" and result.reason_codes == ["ROUTER_TIMEOUT"]
    assert result.metadata["attempts"][-1]["stage"] == "evidence_check"
    assert result.metadata["attempts"][-1]["error"] == "ROUTER_TIMEOUT"
    assert result.metadata["attempts"][-1]["usage"] is None


async def test_failed_candidate_does_not_publish_partial_results(settings, task):
    runtime = FakeRuntime('{"input_status":"ready"}', ClassifierError("MODEL_UNAVAILABLE"))
    result = await independent_classifier(settings, runtime).classify(task)
    assert result.source == "rules" and result.reason_codes == ["MODEL_UNAVAILABLE"]
    assert all(r.quality_level is None for r in result.prediction.candidates)
    assert "input_status" not in result.metadata


async def test_default_pipeline_is_v3_and_runs_readiness_before_scoring(settings, task):
    runtime = FakeRuntime('{"input_status":"missing"}')
    result = await Classifier(settings, runtime).classify(task)
    assert result.metadata["pipeline_version"] == "v3"
    assert result.metadata["router_prompt_version"] == "router-system-v3"
    assert result.metadata["attempts"][0]["stage"] == "input_check"
    assert result.source == "gemma" and result.status == "abstain"
    assert len(runtime.calls) == 1


async def test_absent_negative_evidence_cannot_become_zero(settings, task, prediction):
    row = assessment(prediction, task)["candidates"][0]
    decision = {
        k: row[k] for k in ("candidate_id", "basis_excerpt", "evidence_status", "evidence_ids")
    }
    decision["evidence_status"] = "unsupported"
    request = task.model_copy(
        update={"eligible_candidates": [task.eligible_candidates[0]]}, deep=True
    )
    runtime = FakeRuntime(
        '{"input_status":"ready"}', json.dumps(decision), '{"explicit_limit":false}'
    )
    result = await Classifier(settings, runtime).classify(request)
    assert result.source == "gemma" and result.status == "abstain"
    assert result.prediction.candidates[0].quality_level is None
    assert result.metadata["explicit_limit_checks"][row["candidate_id"]] is False
    assert (
        len(runtime.calls) == 3
    )  # No quality scoring after the unsupported claim was unsubstantiated.
