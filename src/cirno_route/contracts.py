"""Versioned, strict contracts shared by the CLI, API and model boundary."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Identifier = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_.:-]+$")]
ShortText = Annotated[str, Field(min_length=1, max_length=2000)]
Level = Annotated[int, Field(strict=True, ge=0, le=4)]
ReasonCode = Literal[
    "TASK_MATCH",
    "PREFERENCE_MATCH",
    "OBSERVED_PERFORMANCE",
    "CAPABILITY_LIMIT",
    "EVIDENCE_INSUFFICIENT",
]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Evidence(Contract):
    evidence_id: Identifier
    source: Literal["configured", "measured"]
    summary: ShortText
    sample_count: Annotated[int, Field(ge=1)] | None = None

    @model_validator(mode="after")
    def check_sample_count(self):
        if self.source == "measured" and self.sample_count is None:
            raise ValueError("measured evidence requires sample_count")
        if self.source == "configured" and self.sample_count is not None:
            raise ValueError("configured evidence cannot claim measured samples")
        return self


class Candidate(Contract):
    candidate_id: Identifier
    model: ShortText
    revision: ShortText
    capabilities: Annotated[list[ShortText], Field(max_length=20)] = Field(default_factory=list)
    evidence: Annotated[list[Evidence], Field(max_length=20)] = Field(default_factory=list)


class Preference(Contract):
    """An already validated relevant preference, never a persistent profile update."""

    key: Literal[
        "language", "verbosity", "structure", "explanation_depth", "code_presentation", "examples"
    ]
    value: Annotated[str, Field(min_length=1, max_length=200)]


class Task(Contract):
    text: Annotated[str, Field(min_length=1, max_length=16000)]
    task_type: Identifier | None = None
    requirements: Annotated[list[ShortText], Field(max_length=20)] = Field(default_factory=list)

    @model_validator(mode="after")
    def nonblank(self):
        if not self.text.strip():
            raise ValueError("task text cannot be blank")
        return self


class ClassifyRequest(Contract):
    schema_version: Literal["1"] = "1"
    task: Task
    eligible_candidates: Annotated[list[Candidate], Field(max_length=8)]
    relevant_preferences: Annotated[list[Preference], Field(max_length=12)] = Field(
        default_factory=list
    )

    @model_validator(mode="after")
    def unique_ids(self):
        ids = [item.candidate_id for item in self.eligible_candidates]
        if len(ids) != len(set(ids)):
            raise ValueError("candidate_id must be unique")
        evidence = [e.evidence_id for c in self.eligible_candidates for e in c.evidence]
        if len(evidence) != len(set(evidence)):
            raise ValueError("evidence_id must be globally unique in one request")
        return self


class CandidatePrediction(Contract):
    candidate_id: Identifier
    quality_level: Level | None
    preference_fit_level: Level | None
    uncertainty: Literal["low", "medium", "high"]
    evidence_ids: Annotated[list[Identifier], Field(max_length=20)]
    reason_codes: Annotated[list[ReasonCode], Field(min_length=1, max_length=5)]


class RouterPrediction(Contract):
    schema_version: Literal["1"]
    status: Literal["ok", "abstain"]
    candidates: Annotated[list[CandidatePrediction], Field(max_length=8)]


class RuntimeLock(Contract):
    schema_version: Literal["1"] = "1"
    model: str
    checkpoint: str
    model_path: str
    model_digest: str
    model_size: int
    model_mtime_ns: int
    template_sha256: str
    runtime_version: str
    context_tokens: int


class ClassificationResult(Contract):
    schema_version: Literal["1"] = "1"
    status: Literal["ok", "abstain", "blocked"]
    source: Literal["gemma", "rules"]
    prediction: RouterPrediction
    fallback_candidate_id: str | None = None
    reason_codes: list[str]
    metadata: dict
