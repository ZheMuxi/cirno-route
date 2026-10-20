"""Public model research. This boundary never accepts a user's task or conversation."""

import asyncio
import hashlib
import ipaddress
import json
import os
import re
import time
from importlib.resources import files
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from pydantic import Field, field_validator, model_validator

from .contracts import Candidate, Contract, Evidence, Identifier
from .errors import ClassifierError
from .validation import strict_json

PROMPT = files("cirno_route").joinpath("resources/capability-research-v1.txt").read_text()
DIMENSIONS = (
    "coding",
    "reasoning",
    "math",
    "writing",
    "translation",
    "extraction",
    "long_context",
    "vision",
    "tool_use",
)
LABELS = dict(
    zip(
        DIMENSIONS,
        (
            "编程",
            "推理",
            "数学",
            "写作",
            "翻译",
            "结构提取",
            "长文理解",
            "视觉",
            "工具调用",
        ),
        strict=True,
    )
)
Dimension = Literal[
    "coding",
    "reasoning",
    "math",
    "writing",
    "translation",
    "extraction",
    "long_context",
    "vision",
    "tool_use",
]
Text = Annotated[str, Field(min_length=1, max_length=200)]


def digest(value):
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()


def search_query(identity):
    # Prefer publishers without treating name similarity as proof of a gateway alias.
    text = (identity.model + " " + identity.name).lower()
    domain = next(
        (
            domain
            for prefix, domain in (
                ("claude", "anthropic.com"),
                ("gemini", "deepmind.google"),
                ("deepseek", "api-docs.deepseek.com"),
                ("gpt-oss", "huggingface.co/openai"),
                ("gemma", "huggingface.co"),
            )
            if prefix in text
        ),
        None,
    )
    suffix = (
        f" capabilities benchmarks site:{domain}" if domain else " official model card capabilities"
    )
    name = (
        identity.name
        if identity.provider == "cirno-local"
        else identity.model + " " + identity.name
    )
    return name[: 128 - len(suffix)] + suffix


class ResearchSettings(Contract):
    enabled: bool = False
    base_url: str = "https://api.deepseek.com/v1"
    model: Text = "deepseek-flash"
    api_key_env: str = "DEEPSEEK_API_KEY"
    api_key_file: str = ".runtime/deepseek.token"
    search_base_url: str = "https://api.deepseek.com/v1/tools"
    search_api_key_env: str = "DEEPSEEK_API_KEY"
    search_api_key_file: str = ".runtime/deepseek.token"
    cache_dir: str = ".runtime/model-capabilities"
    ttl_hours: int = Field(default=168, ge=1, le=720)
    unknown_ttl_hours: int = Field(default=1, ge=1, le=24)
    concurrency: int = Field(default=2, ge=1, le=4)
    search_count: int = Field(default=3, ge=1, le=5)
    timeout_seconds: float = Field(default=60.0, gt=0, le=180)
    failure_retry_seconds: int = Field(default=300, ge=30, le=3600)

    @field_validator("base_url", "search_base_url")
    @classmethod
    def endpoint(cls, value):
        url = urlsplit(value)
        if (
            not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or (
                url.scheme != "https"
                and not (url.scheme == "http" and url.hostname in {"127.0.0.1", "::1"})
            )
        ):
            raise ValueError("research endpoints require HTTPS or literal loopback HTTP")
        _ = url.port
        return value.rstrip("/")


class ModelIdentity(Contract):
    candidate_id: Identifier
    provider: Text
    model: Text
    name: Text


class ResearchRequest(Contract):
    models: Annotated[list[ModelIdentity], Field(min_length=1, max_length=128)]
    action: Literal["ensure", "refresh", "status"] = "ensure"

    @model_validator(mode="after")
    def unique(self):
        if len({m.candidate_id for m in self.models}) != len(self.models):
            raise ValueError("duplicate candidate")
        if len({(m.provider, m.model) for m in self.models}) != len(self.models):
            raise ValueError("duplicate model")
        return self


class Assessment(Contract):
    dimension: Dimension
    level: Annotated[int, Field(strict=True, ge=0, le=4)] | None
    basis: Annotated[str, Field(max_length=100)]
    source_ids: Annotated[list[str], Field(max_length=5)]


class Findings(Contract):
    identity_status: Literal["documented", "unverified"]
    canonical_name: Annotated[str, Field(max_length=200)]
    summary: Annotated[str, Field(max_length=320)]
    assessments: Annotated[list[Assessment], Field(min_length=9, max_length=9)]
    limitations: Annotated[list[Annotated[str, Field(max_length=100)]], Field(max_length=3)]
    identity_source_ids: Annotated[list[str], Field(max_length=5)]

    @model_validator(mode="after")
    def dimensions(self):
        if {a.dimension for a in self.assessments} != set(DIMENSIONS):
            raise ValueError("missing/duplicate dimension")
        return self


class Source(Contract):
    source_id: str
    url: str
    title: str
    excerpt: str
    published_at: str | None


class Profile(Contract):
    schema_version: Literal["1"] = "1"
    cache_key: str
    identity: ModelIdentity
    retrieved_at: float
    expires_at: float
    researcher: str
    response_model: str
    prompt_sha256: str
    findings: Findings
    sources: list[Source]
    usage: dict


class Failure(Contract):
    cache_key: str
    error: Annotated[str, Field(pattern=r"^RESEARCH_[A-Z0-9_]+$")]
    retry_after: float


def valid_source_url(value):
    try:
        url = urlsplit(value)
        if (
            url.scheme not in {"https", "http"}
            or not url.hostname
            or url.username
            or url.password
            or url.hostname.lower() in {"localhost", "localhost.localdomain"}
            or url.hostname.lower().endswith((".local", ".localhost"))
        ):
            return False
        try:
            return ipaddress.ip_address(url.hostname).is_global
        except ValueError:
            return "." in url.hostname
    except (ValueError, TypeError):
        return False


def credential(env, filename):
    value = os.environ.get(env, "") if env else ""
    if not value:
        try:
            value = Path(filename).read_text().strip()
        except OSError:
            raise ClassifierError("RESEARCH_KEY_UNAVAILABLE") from None
    if not 16 <= len(value) <= 512 or not all(33 <= ord(c) <= 126 for c in value):
        raise ClassifierError("RESEARCH_KEY_INVALID")
    return value


def validate_findings(findings, sources):
    ids = {s.source_id for s in sources}
    if any(i not in ids for i in findings.identity_source_ids):
        raise ValueError("unprovided identity source")
    if findings.identity_status == "documented" and not findings.identity_source_ids:
        raise ValueError("identity requires source")
    for row in findings.assessments:
        if any(i not in ids for i in row.source_ids):
            raise ValueError("unprovided source")
        if row.level is not None and (
            not row.source_ids or not row.basis.strip() or findings.identity_status != "documented"
        ):
            raise ValueError("unsupported capability")
    return findings


def unknown_findings():
    return Findings(
        identity_status="unverified",
        canonical_name="",
        summary="未获得可核实的型号能力资料。",
        assessments=[
            Assessment(dimension=d, level=None, basis="", source_ids=[]) for d in DIMENSIONS
        ],
        limitations=[],
        identity_source_ids=[],
    )


def unresolved_alias(identity, findings, sources):
    """A base model's page is not evidence for a gateway's undocumented suffix."""
    if findings.identity_status != "documented" or not (
        re.search(r"-(high|low|medium|tiered|extra|agent|thinking)$", identity.model)
        or identity.model.startswith("tab_")
    ):
        return False
    normalize = lambda s: "".join(c for c in s.casefold() if c.isalnum())  # noqa: E731
    marker = normalize(identity.model)
    return not any(
        marker in normalize(source.title + " " + source.excerpt)
        for source in sources
        if source.source_id in findings.identity_source_ids
    )


EVIDENCE_PREAMBLE = (
    "联网资料整理，非本地实测。型号资料不证明网关实际后端或工具权限。"
    "能力等级0=明确不支持，1=弱，2=基础，3=熟练，4=有高难任务证据；"
    "不等于本次任务适配分，未知不等于不支持。\n"
)


def card_from_profile(identity, profile):
    card = Candidate(
        candidate_id=identity.candidate_id,
        model=identity.model,
        revision="research-unknown",
        capabilities=[],
        evidence=[],
    )
    if not profile or profile.findings.identity_status != "documented":
        return card
    f = profile.findings
    if not any(a.level is not None for a in f.assessments):
        return card
    revision = digest(
        {"findings": f.model_dump(), "sources": [s.model_dump() for s in profile.sources]}
    )
    card.revision = "research-" + revision[:16]
    levels = "; ".join(
        f"{LABELS[a.dimension]}={'未知' if a.level is None else a.level}"
        + (f"({a.basis})" if a.basis else "")
        for a in sorted(f.assessments, key=lambda a: DIMENSIONS.index(a.dimension))
    )
    summary = (
        EVIDENCE_PREAMBLE + levels + "\n概述：" + f.summary + "\n限制：" + "；".join(f.limitations)
    )
    card.capabilities = [
        LABELS[a.dimension] for a in f.assessments if a.level is not None and a.level > 0
    ]
    card.evidence = [
        Evidence(
            evidence_id=f"web-{identity.candidate_id}-{revision[:8]}",
            source="configured",
            summary=summary,
        )
    ]
    return card


class CapabilityResearch:
    def __init__(self, settings: ResearchSettings, *, transport=None, now=time.time):
        self.settings = settings
        self.transport = transport
        self.now = now
        self.prompt_hash = digest(PROMPT)
        self.semaphore = asyncio.Semaphore(settings.concurrency)

    def key(self, identity):
        return digest(
            {
                "identity": identity.model_dump(),
                "model": self.settings.model,
                "base_url": self.settings.base_url,
                "search_base_url": self.settings.search_base_url,
                "search_count": self.settings.search_count,
                "prompt": self.prompt_hash,
                "schema": "1",
                "search_policy": "publisher-first-v1",
                "ttl_hours": self.settings.ttl_hours,
                "unknown_ttl_hours": self.settings.unknown_ttl_hours,
            }
        )

    def load(self, identity):
        path = Path(self.settings.cache_dir) / (self.key(identity) + ".json")
        try:
            if path.stat().st_size > 200000:
                return None
            profile = Profile.model_validate(strict_json(path.read_text()))
            if (
                profile.cache_key != self.key(identity)
                or profile.identity != identity
                or profile.prompt_sha256 != self.prompt_hash
                or profile.expires_at <= self.now()
                or any(not valid_source_url(s.url) for s in profile.sources)
            ):
                return None
            validate_findings(profile.findings, profile.sources)
            if unresolved_alias(identity, profile.findings, profile.sources):
                return None
            return profile
        except (OSError, ValueError):
            return None

    def save(self, profile):
        directory = Path(self.settings.cache_dir)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = directory / (profile.cache_key + ".json")
        temp = directory / (profile.cache_key + "." + uuid4().hex + ".tmp")
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write(profile.model_dump_json(indent=2) + "\n")
            snapshots = directory / "snapshots"
            snapshots.mkdir(exist_ok=True, mode=0o700)
            # Replacing the current pointer preserves the old content-addressed record.
            try:
                os.link(temp, snapshots / (digest(profile.model_dump()) + ".json"))
            except FileExistsError:
                pass
            os.replace(temp, path)
            (directory / "failures" / (profile.cache_key + ".json")).unlink(missing_ok=True)
        finally:
            temp.unlink(missing_ok=True)

    def failure(self, identity):
        path = Path(self.settings.cache_dir) / "failures" / (self.key(identity) + ".json")
        try:
            if path.stat().st_size > 2000:
                return None
            failure = Failure.model_validate(strict_json(path.read_text()))
            if failure.cache_key == self.key(identity) and failure.retry_after > self.now():
                return failure
        except (OSError, ValueError):
            pass
        return None

    def save_failure(self, identity, error):
        Path(self.settings.cache_dir).mkdir(parents=True, exist_ok=True, mode=0o700)
        directory = Path(self.settings.cache_dir) / "failures"
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        key = self.key(identity)
        temp = directory / (key + "." + uuid4().hex + ".tmp")
        failure = Failure(
            cache_key=key,
            error=error,
            retry_after=self.now() + self.settings.failure_retry_seconds,
        )
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write(failure.model_dump_json())
            os.replace(temp, directory / (key + ".json"))
        finally:
            temp.unlink(missing_ok=True)

    async def post(self, client, url, key, body):
        try:
            async with client.stream(
                "POST",
                url,
                headers={"Authorization": "Bearer " + key},
                json=body,
            ) as response:
                if response.status_code != 200:
                    raise ClassifierError(f"RESEARCH_HTTP_{response.status_code}")
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 2_000_000:
                        raise ClassifierError("RESEARCH_RESPONSE_TOO_LARGE")
            result = strict_json(data.decode())
            if not isinstance(result, dict):
                raise ValueError("expected object")
            return result
        except httpx.TimeoutException:
            raise ClassifierError("RESEARCH_TIMEOUT") from None
        except httpx.HTTPError:
            raise ClassifierError("RESEARCH_UNAVAILABLE") from None
        except (ValueError, UnicodeError):
            raise ClassifierError("RESEARCH_INVALID_RESPONSE") from None

    async def research_one(self, client, identity, key, search_key):
        # No user prompt, local path, credentials or session data enters either request.
        query = search_query(identity)
        raw = await self.post(
            client,
            self.settings.search_base_url + "/search",
            search_key,
            {
                "query": query,
                "count": self.settings.search_count,
                "need_content": True,
            },
        )
        results = raw.get("results")
        if not isinstance(results, list):
            raise ClassifierError("RESEARCH_INVALID_RESPONSE")
        sources = []
        for item in results[: self.settings.search_count]:
            if not isinstance(item, dict) or not valid_source_url(item.get("url")):
                continue
            excerpt = "\n".join(
                value[:6000]
                for field in ("summary", "content")
                if isinstance(value := item.get(field), str) and value
            )[:9000]
            if not excerpt.strip():
                continue
            sources.append(
                Source(
                    source_id=f"s{len(sources) + 1}",
                    url=item["url"][:8192],
                    title=str(item.get("title", ""))[:300],
                    excerpt=excerpt,
                    published_at=item.get("date") if isinstance(item.get("date"), str) else None,
                )
            )
        findings, response_model, usage = unknown_findings(), "", {}
        if sources:
            body = {
                "model": self.settings.model,
                "stream": False,
                "temperature": 0,
                "max_tokens": 2400,
                "response_format": {"type": "json_object"},
                "messages": [
                    {
                        "role": "system",
                        "content": PROMPT
                        + "\nJSON Schema:\n"
                        + json.dumps(Findings.model_json_schema(), ensure_ascii=False),
                    },
                    {
                        "role": "user",
                        "content": json.dumps(
                            {
                                "model": identity.model_dump(),
                                "sources": [s.model_dump() for s in sources],
                            },
                            ensure_ascii=False,
                        ),
                    },
                ],
            }
            if urlsplit(self.settings.base_url).hostname == "api.deepseek.com":
                body["thinking"] = {"type": "disabled"}
            response = await self.post(
                client,
                self.settings.base_url + "/chat/completions",
                key,
                body,
            )
            try:
                choice = response["choices"][0]
                if choice.get("finish_reason") != "stop":
                    raise ValueError("truncated or tool response")
                parsed = strict_json(choice["message"]["content"])
                # An unverified identity cannot supply any usable claims. Discard all of
                # them, including speculative levels or malformed ancillary fields.
                findings = (
                    unknown_findings()
                    if isinstance(parsed, dict) and parsed.get("identity_status") == "unverified"
                    else Findings.model_validate(parsed)
                )
                if unresolved_alias(identity, findings, sources):
                    findings = unknown_findings()
                validate_findings(findings, sources)
                response_model = str(response.get("model", ""))[:200]
                # Preserve usage counters only, not arbitrary provider payloads.
                usage = {
                    k: v
                    for k, v in response.get("usage", {}).items()
                    if k in {"prompt_tokens", "completion_tokens", "total_tokens"}
                    and isinstance(v, int)
                    and not isinstance(v, bool)
                    and v >= 0
                }
            except (KeyError, IndexError, TypeError, ValueError):
                raise ClassifierError("RESEARCH_INVALID_FINDINGS") from None
        ttl = (
            self.settings.ttl_hours
            if findings.identity_status == "documented"
            else self.settings.unknown_ttl_hours
        )
        profile = Profile(
            cache_key=self.key(identity),
            identity=identity,
            retrieved_at=self.now(),
            expires_at=self.now() + ttl * 3600,
            researcher=self.settings.model,
            response_model=response_model,
            prompt_sha256=self.prompt_hash,
            findings=findings,
            sources=sources,
            usage=usage,
        )
        self.save(profile)
        return profile

    async def run(self, request: ResearchRequest, progress=lambda *_a, **_k: None):
        if not self.settings.enabled:
            raise ClassifierError("RESEARCH_DISABLED")
        profiles = [self.load(m) for m in request.models]
        failures = [self.failure(m) for m in request.models]
        needs_network = request.action != "status" and (
            request.action == "refresh"
            or any(p is None and f is None for p, f in zip(profiles, failures, strict=True))
        )
        key = search_key = ""
        if needs_network:
            key = credential(self.settings.api_key_env, self.settings.api_key_file)
            search_key = credential(
                self.settings.search_api_key_env,
                self.settings.search_api_key_file,
            )
        finished = 0
        fatal = None
        async with httpx.AsyncClient(
            trust_env=False,
            follow_redirects=False,
            timeout=self.settings.timeout_seconds,
            transport=self.transport,
        ) as client:

            async def one(identity, cached, failure):
                nonlocal finished, fatal
                error = None
                profile = cached
                cache_hit = cached is not None and request.action != "refresh"
                cooldown_hit = (
                    cached is None and failure is not None and request.action != "refresh"
                )
                if cooldown_hit:
                    error = failure.error
                if request.action != "status" and not cache_hit and not cooldown_hit:
                    async with self.semaphore:
                        if fatal:
                            error = fatal
                        else:
                            try:
                                profile = await self.research_one(client, identity, key, search_key)
                            except (ClassifierError, OSError) as exc:
                                error = (
                                    exc.code
                                    if isinstance(exc, ClassifierError)
                                    else "RESEARCH_CACHE_ERROR"
                                )
                                if error in {
                                    "RESEARCH_HTTP_401",
                                    "RESEARCH_HTTP_403",
                                    "RESEARCH_HTTP_429",
                                }:
                                    fatal = error
                        if error and cached is None:
                            try:
                                self.save_failure(identity, error)
                            except OSError:
                                pass  # The original failure remains visible.
                finished += 1
                progress("researching-models", completed=finished, total=len(request.models))
                card = card_from_profile(identity, profile)
                return {
                    "candidate": card.model_dump(),
                    "provider": identity.provider,
                    "name": identity.name,
                    "cache_hit": cache_hit,
                    "cooldown_hit": cooldown_hit,
                    "error": error,
                    "status": (
                        "documented" if card.evidence else "unverified" if profile else "missing"
                    ),
                    "retrieved_at": profile.retrieved_at if profile else None,
                    "expires_at": profile.expires_at if profile else None,
                    "cache_key": profile.cache_key if profile else None,
                    "record_sha256": digest(profile.model_dump()) if profile else None,
                    "source_urls": [s.url for s in profile.sources] if profile else [],
                }

            rows = await asyncio.gather(
                *(
                    one(identity, profile, failure)
                    for identity, profile, failure in zip(
                        request.models, profiles, failures, strict=True
                    )
                )
            )
        return {
            "schema_version": "1",
            "researcher": self.settings.model,
            "cache_dir": self.settings.cache_dir,
            "models": rows,
        }
