import asyncio
import copy
import json
import time
from importlib.resources import files
from pathlib import Path
from uuid import uuid4

from pydantic import ValidationError

from .compact import INSTRUCTION, decode, encode
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
from .task_profile import INPUT_INSTRUCTION, INPUT_STATUSES, TaskLabels, profile_schema
from .task_profile import INSTRUCTION as PROFILE_INSTRUCTION
from .validation import strict_json, validate_prediction

PROMPT_VERSION = "router-system-v2.1"
PROMPT = files("cirno_route").joinpath(f"resources/{PROMPT_VERSION}.txt").read_text()
PRICING_INSTRUCTION = (
    files("cirno_route").joinpath("resources/router-pricing-context-v1.txt").read_text()
)
OUTPUT_SCHEMA = RouterPrediction.model_json_schema()


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
        pipeline_version: str = "v2",
    ):
        self.settings = settings
        self.runtime = runtime
        # Trusted construction-time override for paired evaluations; never request-controlled.
        self.system_prompt = system_prompt
        self.prompt_version = prompt_version
        if pipeline_version != "v2":
            raise ValueError("unsupported classifier pipeline")
        self.pipeline_version = pipeline_version

    async def classify(self, request: ClassifyRequest, *, rules_only: bool = False):
        started = time.monotonic()
        attempts = []
        model_request = request
        output_schema = constrained_schema(model_request)
        original_payload = model_request.model_input_json()
        payload = original_payload
        mapping = None
        system = self.system_prompt
        if self.settings.compact_protocol:
            payload, output_schema, mapping = encode(model_request)
            system += "\n\n" + INSTRUCTION
        prefix_properties = {"input_status": {"type": "string", "enum": list(INPUT_STATUSES)}}
        suffix_properties = {}
        if request.include_task_profile:
            suffix_properties["task_profile"] = profile_schema()
        output_schema["properties"] = {
            **prefix_properties,
            **output_schema["properties"],
            **suffix_properties,
        }
        output_schema["required"] = [
            *prefix_properties,
            *output_schema["required"],
            *suffix_properties,
        ]
        if mapping is None:
            # Keep candidate-specific identifiers in grammar constraints and user data only.
            public_schema = copy.deepcopy(OUTPUT_SCHEMA)
            public_schema["properties"] = {
                **prefix_properties,
                **public_schema["properties"],
                **suffix_properties,
            }
            public_schema["required"] = [
                *prefix_properties,
                *public_schema["required"],
                *suffix_properties,
            ]
            system += "\nJSON Schema:\n" + json.dumps(public_schema)
        if request.pricing_context is not None:
            system += "\n\n" + PRICING_INSTRUCTION
        if request.include_task_profile:
            system += "\n" + PROFILE_INSTRUCTION
        # Keep the task-input gate last so optional learning instructions cannot
        # distract from missing material before the first generated decision.
        system += "\n\n" + INPUT_INSTRUCTION
        metadata = {
            "request_id": str(uuid4()),
            "router_prompt_version": self.prompt_version,
            "router_prompt_sha256": sha256(self.system_prompt),
            "output_schema_sha256": sha256(json.dumps(OUTPUT_SCHEMA, sort_keys=True)),
            "pipeline_version": self.pipeline_version,
            "generation_schema_sha256": sha256(json.dumps(output_schema, sort_keys=True)),
            "model_input_sha256": sha256(payload),
            "wire_format": "compact-v2" if mapping is not None else "full-v2",
            "wire_prompt_sha256": sha256(INSTRUCTION) if mapping is not None else None,
            "model_input_bytes": len(payload.encode()),
            "original_input_bytes": len(original_payload.encode()),
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
            "input_check_prompt_sha256": sha256(INPUT_INSTRUCTION),
            "task_profile_prompt_sha256": sha256(PROFILE_INSTRUCTION)
            if request.include_task_profile
            else None,
        }
        if request.pricing_context is not None:
            metadata["pricing_context_sha256"] = sha256(
                json.dumps(request.pricing_context.model_dump(), sort_keys=True, ensure_ascii=False)
            )
            metadata["pricing_context_prompt_sha256"] = sha256(PRICING_INSTRUCTION)

        def finish(prediction, source, reasons, blocked=False):
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

        def abstain(reason, blocked=False, *, source="rules"):
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
            return finish(prediction, source, [reason], blocked)

        if not request.eligible_candidates:
            return abstain("NO_ELIGIBLE_MODEL", blocked=True)
        if len(original_payload.encode()) > self.settings.max_input_bytes:
            return abstain("CONTEXT_TOO_LARGE", blocked=True)
        if rules_only:
            return abstain("RULES_ONLY")
        if any(not c.evidence for c in request.eligible_candidates):
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
                # The compact schema is grammar-only; all dynamic data stays user.
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
                        profile = None
                        try:
                            value = strict_json(raw)
                            input_status = value.pop("input_status", None)
                            if input_status not in INPUT_STATUSES:
                                raise ValueError("invalid input status")
                        except (ValueError, KeyError, TypeError, AttributeError) as exc:
                            raise ClassifierError("ROUTER_INVALID_OUTPUT") from exc
                        if request.include_task_profile:
                            profile_value = value.pop("task_profile", None)
                            # Optional learning must never discard otherwise valid model scores.
                            try:
                                profile = TaskLabels.from_wire(profile_value).public_profile(
                                    input_status
                                )
                            except ValidationError:
                                metadata["task_profile_error"] = "TASK_PROFILE_INVALID"
                        raw = json.dumps(value)
                        prediction = (
                            decode(raw, request, mapping)
                            if mapping is not None
                            else validate_prediction(raw, request)
                        )
                        await self.runtime.verify(lock)
                        metadata["input_status"] = input_status
                        if profile is not None:
                            metadata["task_profile"] = profile.model_dump()
                            metadata.pop("task_profile_error", None)
                        if input_status != "ready":
                            return abstain(
                                "TASK_INPUT_MISSING"
                                if input_status == "missing"
                                else "TASK_INPUT_UNCLEAR",
                                source="gemma",
                            )
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
