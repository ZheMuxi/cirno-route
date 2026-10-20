"""Lossless wire adapter: V2 scoring rules and public results remain unchanged."""

import json
from importlib.resources import files

from .contracts import ClassifyRequest, RouterPrediction
from .errors import ClassifierError
from .research import EVIDENCE_PREAMBLE
from .validation import strict_json, validate_prediction

INSTRUCTION = files("cirno_route").joinpath("resources/router-wire-compact-v1.txt").read_text()


def encode(request: ClassifyRequest):
    candidates = sorted(request.eligible_candidates, key=lambda c: c.candidate_id)
    payload = {
        "task": request.task.model_dump(exclude_none=True, exclude_defaults=True),
        "eligible_candidates": [],
        "relevant_preferences": [p.model_dump() for p in request.relevant_preferences],
    }
    properties = {}
    mapping = {}
    evidence_index = 0
    for index, candidate in enumerate(candidates):
        cid = f"c{index}"
        evidence = []
        ids = {}
        for item in candidate.evidence:
            eid = f"e{evidence_index}"
            evidence_index += 1
            ids[eid] = item.evidence_id
            row = item.model_dump(exclude_none=True)
            row["evidence_id"] = eid
            if row["summary"].startswith(EVIDENCE_PREAMBLE):
                payload["evidence_preamble"] = EVIDENCE_PREAMBLE
                row["summary"] = row["summary"][len(EVIDENCE_PREAMBLE) :]
                row["shared_preamble"] = True
            evidence.append(row)
        payload["eligible_candidates"].append(
            {"candidate_id": cid, "capabilities": candidate.capabilities, "evidence": evidence}
        )
        mapping[cid] = (candidate.candidate_id, ids)
        reasons = ["TASK_MATCH", "CAPABILITY_LIMIT", "EVIDENCE_INSUFFICIENT"]
        if any(e.source == "measured" for e in candidate.evidence):
            reasons.append("OBSERVED_PERFORMANCE")
        fields = {
            "q": {"enum": [0, 1, 2, 3, 4, None]},
            "u": {"enum": ["low", "medium", "high"]},
            "e": {
                "type": "array",
                "items": {"type": "string", "enum": list(ids)} if ids else {"type": "string"},
                "maxItems": len(ids),
            },
            "r": {
                "type": "array",
                "items": {"type": "string", "enum": reasons},
                "minItems": 1,
                "maxItems": len(reasons),
            },
        }
        if request.relevant_preferences:
            reasons.append("PREFERENCE_MATCH")
            fields["r"]["maxItems"] = len(reasons)
            fields["p"] = {"enum": [0, 1, 2, 3, 4, None]}
        properties[cid] = {
            "type": "array",
            # llama.cpp's pinned converter supports fixed tuples via prefixItems.
            "prefixItems": list(fields.values()),
            "minItems": len(fields),
            "maxItems": len(fields),
        }
    schema = {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")), schema, mapping


def decode(raw: str, request: ClassifyRequest, mapping: dict) -> RouterPrediction:
    try:
        value = strict_json(raw)
    except (ValueError, TypeError, RecursionError) as exc:
        raise ClassifierError("ROUTER_INVALID_OUTPUT") from exc
    if not isinstance(value, dict) or set(value) != set(mapping):
        raise ClassifierError("ROUTER_CANDIDATE_MISMATCH")
    rows = []
    for key, (candidate_id, evidence_ids) in mapping.items():
        item = value[key]
        fields = ["q", "u", "e", "r"] + (["p"] if request.relevant_preferences else [])
        if not isinstance(item, list) or len(item) != len(fields):
            raise ClassifierError("ROUTER_INVALID_OUTPUT")
        item = dict(zip(fields, item, strict=True))
        if not isinstance(item["e"], list) or any(
            not isinstance(e, str) or e not in evidence_ids for e in item["e"]
        ):
            raise ClassifierError("EVIDENCE_INVALID")
        rows.append(
            {
                "candidate_id": candidate_id,
                "quality_level": item["q"],
                "preference_fit_level": item.get("p"),
                "uncertainty": item["u"],
                "evidence_ids": [evidence_ids[e] for e in item["e"]],
                "reason_codes": item["r"],
            }
        )
    abstain = any(
        r["quality_level"] is None
        or (request.relevant_preferences and r["preference_fit_level"] is None)
        for r in rows
    )
    return validate_prediction(
        json.dumps(
            {"schema_version": "1", "status": "abstain" if abstain else "ok", "candidates": rows}
        ),
        request,
    )
