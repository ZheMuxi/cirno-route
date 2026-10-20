import asyncio
import copy
import json
import time
from importlib.resources import files
from pathlib import Path
from uuid import uuid4

from pydantic import ValidationError

from .assessment import (
    ASSESSMENT_SCHEMA,
    EVIDENCE_SCHEMA,
    INPUT_SCHEMA,
    LIMIT_SCHEMA,
    ExplicitLimit,
    InputReadiness,
    assessment_schema,
    canonical_request,
    evidence_schema,
    validate_assessment,
    validate_evidence,
)
from .config import Settings
from .contracts import (
    CandidatePrediction,
    ClassificationResult,
    ClassifyRequest,
    RouterPrediction,
    RuntimeLock,
)
from .errors import ClassifierError
from .runtime import LlamaRuntime, sha256
from .validation import strict_json, validate_prediction

PROMPT_VERSION = "router-system-v3"
PROMPT = files("cirno_route").joinpath(f"resources/{PROMPT_VERSION}.txt").read_text()
OUTPUT_SCHEMA = RouterPrediction.model_json_schema()
INPUT_PROMPT = files("cirno_route").joinpath("resources/router-input-v3.txt").read_text()
EVIDENCE_PROMPT = files("cirno_route").joinpath("resources/router-evidence-v3.txt").read_text()
LIMIT_PROMPT = files("cirno_route").joinpath("resources/router-limit-v3.txt").read_text()


def constrained_schema(request: ClassifyRequest) -> dict:
    """Narrow the generation grammar to this request; always validate semantics afterwards."""
    schema = copy.deepcopy(OUTPUT_SCHEMA)
    count = len(request.eligible_candidates)
    schema["properties"]["candidates"].update(minItems=count, maxItems=count)
    variants = []
    for candidate in request.eligible_candidates:
        variant = copy.deepcopy(schema["$defs"]["CandidatePrediction"])
        properties = variant["properties"]
        properties["candidate_id"] = {"type": "string", "const": candidate.candidate_id}
        evidence_ids = [e.evidence_id for e in candidate.evidence]
        properties["evidence_ids"]["maxItems"] = len(evidence_ids)
        if evidence_ids:
            properties["evidence_ids"]["items"]["enum"] = evidence_ids
        reasons = properties["reason_codes"]["items"]["enum"]
        if not any(e.source == "measured" for e in candidate.evidence):
            reasons.remove("OBSERVED_PERFORMANCE")
        if not request.relevant_preferences:
            properties["preference_fit_level"] = {"type": "null"}
            reasons.remove("PREFERENCE_MATCH")
        variants.append(variant)
    if variants:
        schema["properties"]["candidates"]["items"] = {"anyOf": variants}
    del schema["$defs"]
    if not variants:
        schema["properties"]["candidates"]["items"] = {}
    return schema


class Classifier:
    def __init__(
        self,
        settings: Settings,
        runtime: LlamaRuntime | None = None,
        *,
        system_prompt: str = PROMPT,
        prompt_version: str = PROMPT_VERSION,
        pipeline_version: str = "v3",
        input_status_checked: bool = False,
        evidence_decision=None,
    ):
        self.settings = settings
        self.runtime = runtime
        # Trusted construction-time override for paired evaluations; never request-controlled.
        self.system_prompt = system_prompt
        self.prompt_version = prompt_version
        if pipeline_version not in {"v2", "v3", "v3-single"}:
            raise ValueError("unsupported classifier pipeline")
        self.pipeline_version = pipeline_version
        self.input_status_checked = input_status_checked
        self.evidence_decision = evidence_decision

    async def classify(self, request: ClassifyRequest, *, rules_only: bool = False):
        started = time.monotonic()
        attempts = []
        model_request = canonical_request(request) if self.pipeline_version != "v2" else request
        output_schema = constrained_schema(model_request)
        model_schema = OUTPUT_SCHEMA
        if self.pipeline_version != "v2":
            output_schema = assessment_schema(model_request, output_schema)
            if self.input_status_checked:
                output_schema = output_schema["anyOf"][1]
            if self.evidence_decision is not None:
                variants = output_schema["properties"]["candidates"]["items"]["anyOf"]
                supported = next(
                    v
                    for v in variants
                    if v["properties"]["evidence_status"]["const"] == "supported"
                )
                supported["properties"]["basis_excerpt"] = {
                    "type": "string",
                    "const": self.evidence_decision.basis_excerpt,
                }
                supported["properties"]["evidence_ids"] = {
                    "type": "array",
                    "const": self.evidence_decision.evidence_ids,
                }
                output_schema["properties"]["candidates"]["items"] = supported
            model_schema = ASSESSMENT_SCHEMA
        metadata = {
            "request_id": str(uuid4()),
            "router_prompt_version": self.prompt_version,
            "router_prompt_sha256": sha256(self.system_prompt),
            "output_schema_sha256": sha256(json.dumps(OUTPUT_SCHEMA, sort_keys=True)),
            "pipeline_version": self.pipeline_version,
            "generation_schema_sha256": sha256(json.dumps(model_schema, sort_keys=True)),
            "model_input_sha256": sha256(model_request.model_dump_json()),
            "output_constraint_sha256": sha256(json.dumps(output_schema, sort_keys=True)),
            "candidate_cards_sha256": sha256(
                json.dumps(
                    [c.model_dump() for c in request.eligible_candidates],
                    sort_keys=True,
                    ensure_ascii=False,
                )
            ),
            "thinking": "disabled",
            "temperature": 0.0,
            "seed": 42,
            "max_output_tokens": self.settings.max_output_tokens,
            "attempts": attempts,
            "verified_runtime": None,
        }

        def finish(prediction, source, reasons, blocked=False):
            if self.pipeline_version == "v3":
                metadata["model_input_sha256"] = sha256(
                    json.dumps([record.get("model_input_sha256") for record in attempts])
                )
                metadata["output_constraint_sha256"] = sha256(
                    json.dumps([record.get("output_constraint_sha256") for record in attempts])
                )
            by_id = {row.candidate_id: row for row in prediction.candidates}
            prediction.candidates = [by_id[c.candidate_id] for c in request.eligible_candidates]
            eligible = {c.candidate_id for c in request.eligible_candidates}
            fallback = None
            if prediction.status == "abstain" and not blocked:
                fallback = next((c for c in self.settings.fallback_order if c in eligible), None)
            metadata["latency_ms"] = round((time.monotonic() - started) * 1000, 2)
            return ClassificationResult(
                status="blocked" if blocked else prediction.status,
                source=source,
                prediction=prediction,
                fallback_candidate_id=fallback,
                reason_codes=reasons,
                metadata=metadata,
            )

        def abstain(reason, blocked=False):
            prediction = RouterPrediction(
                schema_version="1",
                status="abstain",
                candidates=[
                    CandidatePrediction(
                        candidate_id=c.candidate_id,
                        quality_level=None,
                        preference_fit_level=None,
                        uncertainty="high",
                        evidence_ids=[],
                        reason_codes=["EVIDENCE_INSUFFICIENT"],
                    )
                    for c in request.eligible_candidates
                ],
            )
            return finish(prediction, "rules", [reason], blocked)

        if not request.eligible_candidates:
            return abstain("NO_ELIGIBLE_MODEL", blocked=True)
        payload = model_request.model_dump_json()
        if len(payload.encode()) > self.settings.max_input_bytes:
            return abstain("CONTEXT_TOO_LARGE", blocked=True)
        if rules_only:
            return abstain("RULES_ONLY")
        if self.pipeline_version == "v2" and any(
            not c.evidence for c in request.eligible_candidates
        ):
            return abstain("UNSUPPORTED_BY_ROUTER")
        if self.runtime is None:
            return abstain("MODEL_UNAVAILABLE")
        try:
            lock_text = await asyncio.to_thread(Path(self.settings.lock_file).read_text)
            lock = RuntimeLock.model_validate_json(lock_text)
        except (OSError, ValidationError):
            return abstain("MODEL_LOCK_MISSING_OR_INVALID")

        try:
            async with asyncio.timeout(self.settings.timeout_seconds):
                await self.runtime.verify(lock)
                metadata["verified_runtime"] = lock.model_dump()
                if self.pipeline_version == "v3":
                    return await self._classify_independently(
                        model_request, lock, metadata, finish, abstain
                    )
                # Schema is in both the grammar and system instruction; all dynamic data stays user.
                system = self.system_prompt + "\nJSON Schema:\n" + json.dumps(model_schema)
                if self.input_status_checked:
                    system += "\n任务输入已单独检查为ready。只判断本次唯一候选的证据和分数。"
                messages = [
                    {"role": "system", "content": system},
                    {"role": "user", "content": payload},
                ]
                for attempt in range(self.settings.format_retries + 1):
                    record = {
                        "number": attempt + 1,
                        "usage": None,
                        "error": None,
                        "effective_system_sha256": sha256(messages[0]["content"]),
                    }
                    attempts.append(record)
                    try:
                        raw, usage = await self.runtime.complete(messages, output_schema)
                        record["usage"] = usage
                        if self.pipeline_version != "v2":
                            prediction, assessment = validate_assessment(raw, model_request)
                            if self.input_status_checked and assessment.input_status != "ready":
                                raise ClassifierError("ROUTER_ASSESSMENT_MISMATCH")
                            if self.evidence_decision is not None and any(
                                c.evidence_status != "supported"
                                or c.basis_excerpt != self.evidence_decision.basis_excerpt
                                or c.evidence_ids != self.evidence_decision.evidence_ids
                                for c in assessment.candidates
                            ):
                                raise ClassifierError("ROUTER_ASSESSMENT_MISMATCH")
                        else:
                            prediction = validate_prediction(raw, request)
                        await self.runtime.verify(lock)
                        if self.pipeline_version != "v2":
                            metadata["input_status"] = assessment.input_status
                            metadata["candidate_evidence_status"] = {
                                c.candidate_id: c.evidence_status for c in assessment.candidates
                            }
                        reasons = ["ROUTER_ABSTAIN"] if prediction.status == "abstain" else []
                        return finish(prediction, "gemma", reasons)
                    except ClassifierError as exc:
                        record["error"] = exc.code
                        repairable = exc.code in {
                            "ROUTER_INVALID_OUTPUT",
                            "ROUTER_CANDIDATE_MISMATCH",
                            "EVIDENCE_INVALID",
                            "ROUTER_PREFERENCE_MISMATCH",
                            "ROUTER_MUST_ABSTAIN",
                            "ROUTER_OUTPUT_TRUNCATED",
                            "ROUTER_ASSESSMENT_MISMATCH",
                        }
                        if not repairable or attempt == self.settings.format_retries:
                            raise
                        # Retry only format/contract issues, without replaying untrusted output.
                        messages[0] = {
                            "role": "system",
                            "content": system
                            + (
                                "\n前次输出未通过合同校验（" + exc.code + "）。"
                                "仅修正结构、ID、证据引用和弃权条件，不能新增事实或证据。"
                            ),
                        }
        except TimeoutError:
            if attempts:
                attempts[-1]["error"] = "ROUTER_TIMEOUT"
            return abstain("ROUTER_TIMEOUT")
        except ClassifierError as exc:
            return abstain(exc.code, blocked=exc.code == "CONTEXT_TOO_LARGE")

    async def _classify_independently(self, request, lock, metadata, finish, abstain):
        """One task readiness check, then independent candidate judgments under one deadline."""
        task_payload = request.task.model_dump_json()
        single_requests = [
            request.model_copy(update={"eligible_candidates": [card]}, deep=True)
            for card in request.eligible_candidates
        ]
        metadata["model_input_sha256"] = sha256(
            json.dumps([task_payload] + [r.model_dump_json() for r in single_requests])
        )
        metadata["output_constraint_sha256"] = sha256(
            json.dumps(
                [INPUT_SCHEMA]
                + [
                    assessment_schema(r, constrained_schema(r))["anyOf"][1] for r in single_requests
                ],
                sort_keys=True,
            )
        )
        metadata["input_check_prompt_sha256"] = sha256(INPUT_PROMPT)
        metadata["evidence_check_prompt_sha256"] = sha256(EVIDENCE_PROMPT)
        metadata["limit_check_prompt_sha256"] = sha256(LIMIT_PROMPT)
        system = INPUT_PROMPT + "\nJSON Schema:\n" + json.dumps(INPUT_SCHEMA)
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": task_payload},
        ]
        for attempt in range(self.settings.format_retries + 1):
            record = {
                "number": len(metadata["attempts"]) + 1,
                "stage": "input_check",
                "stage_attempt": attempt + 1,
                "usage": None,
                "error": None,
                "effective_system_sha256": sha256(messages[0]["content"]),
                "model_input_sha256": sha256(task_payload),
                "output_constraint_sha256": sha256(json.dumps(INPUT_SCHEMA, sort_keys=True)),
            }
            metadata["attempts"].append(record)
            try:
                raw, usage = await self.runtime.complete(messages, INPUT_SCHEMA)
                record["usage"] = usage
                readiness = InputReadiness.model_validate(strict_json(raw))
                break
            except (ValueError, ValidationError, RecursionError) as exc:
                record["error"] = "ROUTER_INVALID_OUTPUT"
                if attempt == self.settings.format_retries:
                    raise ClassifierError("ROUTER_INVALID_OUTPUT") from exc
                messages[0] = {"role": "system", "content": system + "\n仅返回规定的单字段JSON。"}
            except ClassifierError as exc:
                record["error"] = exc.code
                raise
        await self.runtime.verify(lock)
        if readiness.input_status == "missing":
            metadata["input_status"] = "missing"
            metadata["candidate_evidence_status"] = {
                c.candidate_id: "insufficient" for c in request.eligible_candidates
            }
            prediction = RouterPrediction(
                schema_version="1",
                status="abstain",
                candidates=[
                    CandidatePrediction(
                        candidate_id=c.candidate_id,
                        quality_level=None,
                        preference_fit_level=None,
                        uncertainty="high",
                        evidence_ids=[],
                        reason_codes=["EVIDENCE_INSUFFICIENT"],
                    )
                    for c in request.eligible_candidates
                ],
            )
            return finish(prediction, "gemma", ["ROUTER_ABSTAIN"])
        rows, states = [], {}
        for one in single_requests:
            cid = one.eligible_candidates[0].candidate_id
            decision = await self._check_evidence(one, metadata)
            if decision.evidence_status == "unsupported":
                explicit = await self._check_limit(one, decision, metadata)
                metadata.setdefault("explicit_limit_checks", {})[cid] = explicit
                if not explicit:
                    decision = decision.model_copy(update={"evidence_status": "insufficient"})
            states[cid] = decision.evidence_status
            if decision.evidence_status != "supported":
                unknown = decision.evidence_status == "insufficient"
                rows.append(
                    CandidatePrediction(
                        candidate_id=cid,
                        quality_level=None if unknown else 0,
                        preference_fit_level=None,
                        uncertainty="high" if unknown else "medium",
                        evidence_ids=decision.evidence_ids,
                        reason_codes=["EVIDENCE_INSUFFICIENT" if unknown else "CAPABILITY_LIMIT"],
                    )
                )
                continue
            child = Classifier(
                self.settings,
                self.runtime,
                system_prompt=self.system_prompt,
                prompt_version=self.prompt_version,
                pipeline_version="v3-single",
                input_status_checked=True,
                evidence_decision=decision,
            )
            metadata["attempts"].append(
                {
                    "number": len(metadata["attempts"]) + 1,
                    "stage": "candidate",
                    "candidate_id": cid,
                    "stage_attempt": 1,
                    "usage": None,
                    "error": None,
                    "effective_system_sha256": None,
                    "model_input_sha256": sha256(one.model_dump_json()),
                }
            )
            result = await child.classify(one)
            metadata["attempts"].pop()
            for entry in result.metadata["attempts"]:
                metadata["attempts"].append(
                    {
                        **entry,
                        "stage": "candidate",
                        "candidate_id": cid,
                        "stage_attempt": entry["number"],
                        "number": len(metadata["attempts"]) + 1,
                        "model_input_sha256": result.metadata["model_input_sha256"],
                        "output_constraint_sha256": result.metadata["output_constraint_sha256"],
                    }
                )
            if result.source != "gemma":
                return abstain(result.reason_codes[0], blocked=result.status == "blocked")
            rows.extend(result.prediction.candidates)
            states.update(result.metadata["candidate_evidence_status"])
        await self.runtime.verify(lock)
        metadata["input_status"] = "ready"
        metadata["candidate_evidence_status"] = states
        unknown = any(
            r.quality_level is None
            or (request.relevant_preferences and r.preference_fit_level is None)
            for r in rows
        )
        prediction = RouterPrediction(
            schema_version="1",
            status="abstain" if unknown else "ok",
            candidates=rows,
        )
        return finish(prediction, "gemma", ["ROUTER_ABSTAIN"] if unknown else [])

    async def _check_evidence(self, request, metadata):
        schema = evidence_schema(request, constrained_schema(request))
        system = EVIDENCE_PROMPT + "\nJSON Schema:\n" + json.dumps(EVIDENCE_SCHEMA)
        payload = request.model_dump_json()
        messages = [{"role": "system", "content": system}, {"role": "user", "content": payload}]
        for attempt in range(self.settings.format_retries + 1):
            record = {
                "number": len(metadata["attempts"]) + 1,
                "stage": "evidence_check",
                "candidate_id": request.eligible_candidates[0].candidate_id,
                "stage_attempt": attempt + 1,
                "usage": None,
                "error": None,
                "effective_system_sha256": sha256(messages[0]["content"]),
                "model_input_sha256": sha256(payload),
                "output_constraint_sha256": sha256(json.dumps(schema, sort_keys=True)),
            }
            metadata["attempts"].append(record)
            try:
                raw, usage = await self.runtime.complete(messages, schema)
                record["usage"] = usage
                return validate_evidence(raw, request.eligible_candidates[0])
            except ClassifierError as exc:
                record["error"] = exc.code
                if (
                    exc.code not in {"ROUTER_INVALID_OUTPUT", "EVIDENCE_INVALID"}
                    or attempt == self.settings.format_retries
                ):
                    raise
                messages[0] = {
                    "role": "system",
                    "content": system + "\n严格遵循Schema，引用候选自己的资料原句。",
                }

    async def _check_limit(self, request, decision, metadata):
        # Check the cited original statements without the task: silence is not a negative fact.
        payload = json.dumps(
            [
                e.summary
                for e in request.eligible_candidates[0].evidence
                if e.evidence_id in decision.evidence_ids
            ],
            ensure_ascii=False,
        )
        system = LIMIT_PROMPT + "\nJSON Schema:\n" + json.dumps(LIMIT_SCHEMA)
        messages = [{"role": "system", "content": system}, {"role": "user", "content": payload}]
        for attempt in range(self.settings.format_retries + 1):
            record = {
                "number": len(metadata["attempts"]) + 1,
                "stage": "limit_check",
                "candidate_id": decision.candidate_id,
                "stage_attempt": attempt + 1,
                "usage": None,
                "error": None,
                "effective_system_sha256": sha256(messages[0]["content"]),
                "model_input_sha256": sha256(payload),
                "output_constraint_sha256": sha256(json.dumps(LIMIT_SCHEMA, sort_keys=True)),
            }
            metadata["attempts"].append(record)
            try:
                raw, usage = await self.runtime.complete(messages, LIMIT_SCHEMA)
                record["usage"] = usage
                return ExplicitLimit.model_validate(strict_json(raw)).explicit_limit
            except (ValueError, ValidationError, RecursionError) as exc:
                record["error"] = "ROUTER_INVALID_OUTPUT"
                if attempt == self.settings.format_retries:
                    raise ClassifierError("ROUTER_INVALID_OUTPUT") from exc
                messages[0] = {"role": "system", "content": system + "\n仅返回规定的布尔字段。"}
            except ClassifierError as exc:
                record["error"] = exc.code
                raise
