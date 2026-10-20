"""V3 internal judgments and their strict projection onto the public v1 contract."""

import copy
import json
import re
from typing import Annotated, Literal

from pydantic import Field, ValidationError

from .contracts import (
    CandidatePrediction,
    ClassifyRequest,
    Contract,
    Identifier,
    Level,
    ReasonCode,
)
from .errors import ClassifierError
from .validation import strict_json, validate_prediction


class CandidateAssessment(Contract):
    candidate_id: Identifier
    basis_excerpt: Annotated[str, Field(max_length=80)]
    evidence_status: Literal["insufficient", "supported", "unsupported"]
    quality_level: Level | None
    preference_fit_level: Level | None
    uncertainty: Literal["low", "medium", "high"]
    evidence_ids: Annotated[list[Identifier], Field(max_length=20)]
    reason_codes: Annotated[list[ReasonCode], Field(min_length=1, max_length=5)]


class Assessment(Contract):
    input_status: Literal["missing", "ready"]
    candidates: Annotated[list[CandidateAssessment], Field(max_length=8)]


class InputReadiness(Contract):
    input_status: Literal["missing", "ready"]


class ExplicitLimit(Contract):
    explicit_limit: bool


LIMIT_SCHEMA = ExplicitLimit.model_json_schema()


class EvidenceDecision(Contract):
    candidate_id: Identifier
    basis_excerpt: Annotated[str, Field(max_length=80)]
    evidence_status: Literal["insufficient", "supported", "unsupported"]
    evidence_ids: Annotated[list[Identifier], Field(max_length=20)]


EVIDENCE_SCHEMA = EvidenceDecision.model_json_schema()
INPUT_SCHEMA = InputReadiness.model_json_schema()
ASSESSMENT_SCHEMA = Assessment.model_json_schema()


def evidence_excerpts(card):
    """Literal, bounded alternatives for grounding; no semantic keyword classification."""
    excerpts = []
    for evidence in card.evidence:
        for sentence in re.findall(r"[^。；;\n]+[。；;\n]?", evidence.summary):
            # Overlap long sentences so an arbitrary boundary does not hide a limitation.
            for start in range(0, len(sentence), 60):
                excerpt = sentence[start : start + 80]
                if excerpt not in excerpts:
                    excerpts.append(excerpt)
    return excerpts


def canonical_request(request: ClassifyRequest) -> ClassifyRequest:
    """Normalize unordered card collections without changing the caller's request."""
    canonical = request.model_copy(deep=True)
    canonical.eligible_candidates.sort(key=lambda c: c.candidate_id)
    for card in canonical.eligible_candidates:
        card.evidence.sort(key=lambda e: e.evidence_id)
        card.capabilities.sort()
    return canonical


def assessment_schema(request: ClassifyRequest, legacy_schema: dict) -> dict:
    """Branch before scores: missing inputs / insufficient evidence cannot emit numbers."""
    variants = legacy_schema["properties"]["candidates"]["items"].get("anyOf", [])
    branches = []
    for input_status in ("missing", "ready"):
        rows = []
        for card, template in zip(request.eligible_candidates, variants, strict=True):
            excerpts = evidence_excerpts(card)
            states = ("insufficient",)
            if input_status == "ready" and card.evidence:
                states = ("insufficient", "supported", "unsupported")
            for state in states:
                row = copy.deepcopy(template)
                original = row["properties"]
                properties = {
                    "candidate_id": original.pop("candidate_id"),
                    "basis_excerpt": {
                        "type": "string",
                        "enum": ([""] if state == "insufficient" else []) + excerpts,
                    },
                    "evidence_status": {"type": "string", "const": state},
                    **original,
                }
                row["properties"] = properties
                row["required"] = list(properties)
                if input_status == "missing" or not card.evidence:
                    properties["basis_excerpt"] = {"type": "string", "const": ""}
                if state == "insufficient":
                    properties["quality_level"] = {"type": "null"}
                    properties["preference_fit_level"] = {"type": "null"}
                    properties["uncertainty"] = {"type": "string", "const": "high"}
                    properties["reason_codes"] = {
                        "type": "array",
                        "items": {"type": "string", "const": "EVIDENCE_INSUFFICIENT"},
                        "minItems": 1,
                        "maxItems": 1,
                    }
                else:
                    properties["basis_excerpt"]["minLength"] = 1
                    properties["evidence_ids"]["minItems"] = 1
                    if not any(e.source == "measured" for e in card.evidence):
                        properties["uncertainty"] = {"type": "string", "enum": ["medium", "high"]}
                    properties["quality_level"] = (
                        {"type": "integer", "const": 0}
                        if state == "unsupported"
                        else {"type": "integer", "minimum": 1, "maximum": 4}
                    )
                    if state == "unsupported":
                        properties["reason_codes"] = {
                            "type": "array",
                            "items": {"type": "string", "const": "CAPABILITY_LIMIT"},
                            "minItems": 1,
                            "maxItems": 1,
                        }
                    else:
                        properties["reason_codes"]["items"]["enum"].remove("EVIDENCE_INSUFFICIENT")
                rows.append(row)
        count = len(request.eligible_candidates)
        branches.append(
            {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "input_status": {"type": "string", "const": input_status},
                    "candidates": {
                        "type": "array",
                        "minItems": count,
                        "maxItems": count,
                        "items": {"anyOf": rows} if rows else {},
                    },
                },
                "required": ["input_status", "candidates"],
            }
        )
    return {"anyOf": branches}


def evidence_schema(request, legacy_schema):
    variants = assessment_schema(request, legacy_schema)["anyOf"][1]["properties"]["candidates"][
        "items"
    ]["anyOf"]
    fields = {"candidate_id", "basis_excerpt", "evidence_status", "evidence_ids"}
    for variant in variants:
        variant["properties"] = {k: v for k, v in variant["properties"].items() if k in fields}
        variant["required"] = list(variant["properties"])
    return {"anyOf": variants}


def validate_evidence(raw, card):
    try:
        decision = EvidenceDecision.model_validate(strict_json(raw))
    except (ValueError, ValidationError, RecursionError) as exc:
        raise ClassifierError("ROUTER_INVALID_OUTPUT") from exc
    evidence = {e.evidence_id: e for e in card.evidence}
    if (
        decision.candidate_id != card.candidate_id
        or len(set(decision.evidence_ids)) != len(decision.evidence_ids)
        or not set(decision.evidence_ids) <= evidence.keys()
        or (
            decision.basis_excerpt
            and not any(
                decision.basis_excerpt in evidence[eid].summary for eid in decision.evidence_ids
            )
        )
        or (decision.evidence_status != "insufficient" and not decision.basis_excerpt)
    ):
        raise ClassifierError("EVIDENCE_INVALID")
    return decision


def validate_assessment(raw: str, request: ClassifyRequest):
    try:
        assessment = Assessment.model_validate(strict_json(raw))
    except (ValueError, ValidationError, RecursionError) as exc:
        raise ClassifierError("ROUTER_INVALID_OUTPUT") from exc
    cards = {c.candidate_id: c for c in request.eligible_candidates}
    rows = []
    for item in assessment.candidates:
        state = item.evidence_status
        if assessment.input_status == "missing" and state != "insufficient":
            raise ClassifierError("ROUTER_ASSESSMENT_MISMATCH")
        if state == "insufficient":
            valid = (
                item.quality_level is None
                and item.preference_fit_level is None
                and item.uncertainty == "high"
                and item.reason_codes == ["EVIDENCE_INSUFFICIENT"]
            )
        elif state == "unsupported":
            valid = item.quality_level == 0 and item.reason_codes == ["CAPABILITY_LIMIT"]
        else:
            valid = (
                item.quality_level is not None
                and item.quality_level >= 1
                and "EVIDENCE_INSUFFICIENT" not in item.reason_codes
            )
        card = cards.get(item.candidate_id)
        if item.basis_excerpt and not (
            card
            and any(
                item.basis_excerpt in e.summary and e.evidence_id in item.evidence_ids
                for e in card.evidence
            )
        ):
            raise ClassifierError("EVIDENCE_INVALID")
        if (
            state != "insufficient"
            and not item.basis_excerpt
            or assessment.input_status == "missing"
            and item.basis_excerpt
        ):
            valid = False
        if (
            card
            and item.uncertainty == "low"
            and not any(
                e.source == "measured" and e.evidence_id in item.evidence_ids for e in card.evidence
            )
        ):
            valid = False
        if not valid:
            raise ClassifierError("ROUTER_ASSESSMENT_MISMATCH")
        rows.append(
            CandidatePrediction.model_validate(
                item.model_dump(exclude={"evidence_status", "basis_excerpt"})
            )
        )
    unknown = any(
        row.quality_level is None
        or (request.relevant_preferences and row.preference_fit_level is None)
        for row in rows
    )
    prediction = validate_prediction(
        json.dumps(
            {
                "schema_version": "1",
                "status": "abstain" if unknown else "ok",
                "candidates": [row.model_dump() for row in rows],
            }
        ),
        request,
    )
    return prediction, assessment
