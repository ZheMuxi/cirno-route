import json

from pydantic import ValidationError

from .contracts import ClassifyRequest, RouterPrediction
from .errors import ClassifierError


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def strict_json(text: str):
    def invalid_constant(_value):
        raise ValueError("non-finite JSON number")

    return json.loads(text, object_pairs_hook=_unique_object, parse_constant=invalid_constant)


def validate_prediction(raw: str, request: ClassifyRequest) -> RouterPrediction:
    try:
        prediction = RouterPrediction.model_validate(strict_json(raw))
    except (ValueError, ValidationError, RecursionError) as exc:
        raise ClassifierError("ROUTER_INVALID_OUTPUT") from exc
    cards = {c.candidate_id: c for c in request.eligible_candidates}
    ids = [p.candidate_id for p in prediction.candidates]
    if len(ids) != len(set(ids)) or set(ids) != set(cards):
        raise ClassifierError("ROUTER_CANDIDATE_MISMATCH")
    for item in prediction.candidates:
        evidence = {e.evidence_id: e for e in cards[item.candidate_id].evidence}
        if len(set(item.evidence_ids)) != len(item.evidence_ids):
            raise ClassifierError("EVIDENCE_INVALID")
        if not set(item.evidence_ids) <= evidence.keys():
            raise ClassifierError("EVIDENCE_INVALID")
        if len(set(item.reason_codes)) != len(item.reason_codes):
            raise ClassifierError("ROUTER_INVALID_OUTPUT")
        if (item.quality_level is not None or item.preference_fit_level is not None) and not (
            item.evidence_ids
        ):
            raise ClassifierError("EVIDENCE_INVALID")
        if "OBSERVED_PERFORMANCE" in item.reason_codes and not any(
            evidence[eid].source == "measured" for eid in item.evidence_ids
        ):
            raise ClassifierError("EVIDENCE_INVALID")
        if not request.relevant_preferences and (
            item.preference_fit_level is not None or "PREFERENCE_MATCH" in item.reason_codes
        ):
            raise ClassifierError("ROUTER_PREFERENCE_MISMATCH")
        if prediction.status == "ok" and (
            item.quality_level is None
            or (request.relevant_preferences and item.preference_fit_level is None)
        ):
            raise ClassifierError("ROUTER_MUST_ABSTAIN")
    return prediction
