"""Task-conditioned scores, calibrated against named reference runs, never the Pi roster."""

import asyncio
import bisect
import hashlib
import json
from collections import Counter, defaultdict

from .benchmark_sources import (
    AUTO,
    DIMENSIONS,
    EPOCH_TASKS,
    MANUAL_TASKS,
    POLICY,
    REFERENCE,
    identity,
    spec,
)
from .errors import ClassifierError

APPLIES = {
    "arena-text": {"text", "chinese", "coding", "math", "reasoning"},
    "arena-webdev": {"frontend"},
    "epoch": {d for d, _ in EPOCH_TASKS.values()},
    **{s: set(m.values()) for s, m in MANUAL_TASKS.items()},
}


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def percentile(raw, anchors, direction="higher"):
    """Interpolate empirical midranks. Tied observations share a rank."""
    if direction == "lower":
        raw, anchors = -raw, [-a for a in anchors]
    values = sorted(anchors)
    if len(set(values)) < 2:
        return None
    unique = sorted(set(values))
    ranks = [
        (bisect.bisect_left(values, v) + bisect.bisect_right(values, v) - 1) * 5 / (len(values) - 1)
        for v in unique
    ]
    i = bisect.bisect_left(unique, raw)
    if i < len(unique) and unique[i] == raw:
        return ranks[i]
    if i == 0:
        return 0.0
    if i == len(unique):
        return 10.0
    return ranks[i - 1] + (ranks[i] - ranks[i - 1]) * (raw - unique[i - 1]) / (
        unique[i] - unique[i - 1]
    )


def task_metric(evaluation, dim, needs):
    source, _, section = evaluation.partition(":")
    section = section.split("/", 1)[0]
    task = needs["task_profile"]
    specialty = needs.get("specialty", "general")
    if source == "arena-webdev":
        return section == needs.get("webdev_focus", "overall")
    if source == "livebench":
        if section == "agentic":
            return task["kind"] == "plan" or "tools" in task["requirements"]
        if section == "browser_use":
            return "web" in task["requirements"]
        if section == "research":
            return task["kind"] == "research"
        if section == "data_analysis":
            return specialty == "data_analysis"
        if dim == "text":
            focus = (
                "instruction_following"
                if "structured_output" in task["requirements"]
                else "language"
            )
            return section == focus
    if source == "superclue":
        if section == "science_reasoning":
            return specialty == "science"
        if section == "task_planning":
            return task["kind"] == "plan"
        if section == "instruction_following":
            return "structured_output" in task["requirements"]
    if source == "decathlon":
        if dim == "math" and task["kind"] in {"math_calculate", "math_prove"}:
            return section == "math" or (section == "proof" and task["kind"] == "math_prove")
        if dim == "coding":
            if specialty in {"optimization", "algorithm_contest", "game_development", "physics"}:
                return section == ("game_ai" if specialty == "game_development" else specialty)
            return section == ("systems" if task["kind"] == "code_design" else "coding")
        if section in {"spatial", "geometry", "rendering"}:
            return section == specialty
    if source == "arena-text" and dim == "text":
        if task["kind"] in {"write_create", "write_edit"}:
            return section == "creative_writing"
        if "structured_output" in task["requirements"]:
            return section == "instruction_following"
        return section == "overall"
    if source == "epoch" and dim == "math" and task["kind"] in {"math_prove", "math_calculate"}:
        if task["difficulty"] == "routine":
            return section == "math_level_5"
        return section in {"frontiermath_tiers_1_3_v2", "otis_mock_aime_2024_2025"}
    return True


class Tables:
    def __init__(self, state):
        self.state = state
        self.members = set()
        self.protocols = defaultdict(list)
        self.by_model = defaultdict(list)
        groups = defaultdict(dict)
        ambiguous = defaultdict(set)
        for board in state.values():
            for r in board.get("rows", []):
                self.members.add(r["model"])
                if not r["dimension"]:
                    continue
                key = (
                    r["evaluation"],
                    r["version"],
                    r["environment"],
                    r["variant"],
                    r["unit"],
                    r["details"].get("metric", "rating"),
                    r.get("direction", "higher"),
                )
                model = (r["model"], r["effort"], r["variant"])
                old = groups[key].get(model)
                if (
                    old
                    and r["source"].startswith("arena-")
                    and None not in (old["raw"], r["raw"])
                    and old["raw"] != r["raw"]
                ):
                    ambiguous[key].add(model)
                # Replicates contribute once. Prefer the latest run, never the highest result.
                if old is None or (r["details"].get("started", ""), r["details"].get("run", "")) > (
                    old["details"].get("started", ""),
                    old["details"].get("run", ""),
                ):
                    groups[key][model] = r
        for group, rows in groups.items():
            for model in ambiguous[group]:
                rows.pop(model)
            if not rows:
                continue
            r = next(iter(rows.values()))
            cohort = r.get(
                "references",
                {"version": POLICY + "/" + r["group"], "models": REFERENCE[r["group"]]},
            )
            ref = [identity(n) for n in cohort["models"]]
            anchors = (
                [rows[k]["raw"] for k in ref]
                if all(k in rows and rows[k]["raw"] is not None for k in ref)
                else []
            )
            protocol = self.protocol(
                r["evaluation"],
                r["version"],
                r["environment"],
                r["variant"],
                r["unit"],
                group[-2],
                group[-1],
                cohort,
            )
            self.protocols[r["dimension"]].append((protocol, anchors))
            if len(set(anchors)) < 2:
                continue
            for model, item in rows.items():
                if item["raw"] is not None:
                    self.by_model[model].append((item, anchors, protocol))

        # A cold or damaged source can still be calibrated if Search returns the exact
        # model and the entire fixed cohort in one comparable first-party results table.
        existing = {p["evaluation"] for entries in self.protocols.values() for p, _ in entries}
        sections = {
            "arena-text": [
                "overall",
                "coding",
                "chinese",
                "math",
                "hard_prompts",
                "creative_writing",
                "instruction_following",
            ],
            "arena-webdev": ["overall", "webdev_react", "webdev_html", "image_to_webdev"],
            "epoch": list(EPOCH_TASKS),
        }
        for source, names in sections.items():
            for name in names:
                evaluation = source + ":" + name
                if evaluation in existing:
                    continue
                dim, key, unit = spec(source, name)
                cohort = {"version": POLICY + "/" + key, "models": REFERENCE[key]}
                env = (
                    "epoch/inspect/" + name
                    if source == "epoch"
                    else "arena/" + source.split("-")[1] + "/raw"
                )
                metric = "mean_score" if source == "epoch" else "rating"
                p = self.protocol(
                    evaluation, "from-source", env, "", unit, metric, "higher", cohort
                )
                self.protocols[dim].append((p, []))

    @staticmethod
    def protocol(evaluation, version, environment, variant, unit, metric, direction, cohort):
        source, section = evaluation.split(":", 1)
        if source == "epoch":
            witness = [section.replace("_", " "), "mean_score", "inspect"]
        elif source in AUTO:
            witness = [source.split("-")[1], section, "rating"]
            if version != "from-source":
                witness.append(version)
        else:
            witness = [section, version, environment, metric, unit]
        return {
            "id": digest(
                [evaluation, version, environment, variant, unit, metric, direction, cohort]
            )[:18],
            "evaluation": evaluation,
            "source": source,
            "version": version,
            "unit": unit,
            "environment": environment,
            "variant": variant,
            "witness": witness,
            "reference_version": cohort["version"],
            "reference_models": cohort["models"],
            "direction": direction,
            "metric": metric,
        }

    def sources(self, dim):
        return [s for s, b in self.state.items() if b["enabled"] and dim in APPLIES[s]]

    def selected(self, dim, needs, variant, environment):
        available = {
            p["id"]: (p, anchors)
            for p, anchors in self.protocols[dim]
            if self.state[p["source"]]["enabled"]
            and task_metric(p["evaluation"], dim, needs)
            and p["variant"] == variant
            and (not environment or p["environment"] == environment)
        }
        published = {
            k: (p, a)
            for k, (p, a) in available.items()
            if p["version"] != "from-source" or self.state[p["source"]]["error"]
        }
        selected = published or available
        specific = {
            p["source"] for p, _ in selected.values() if not p["evaluation"].endswith(":overall")
        }
        parents = {
            p["evaluation"].split("/", 1)[0] for p, _ in selected.values() if "/" in p["evaluation"]
        }
        if any(p["evaluation"] == "decathlon:proof" for p, _ in selected.values()):
            parents.add("decathlon:math")
        return {
            k: (p, a)
            for k, (p, a) in selected.items()
            if (p["source"] not in specific or not p["evaluation"].endswith(":overall"))
            and p["evaluation"] not in parents
        }

    def case(self, model, dim, measured):
        enabled = [s for s, b in self.state.items() if b["enabled"]]
        relevant = self.sources(dim)
        failed = [s for s in relevant if self.state[s]["error"]]
        if not measured and model not in self.members:
            uncertain = [s for s in enabled if self.state[s]["error"]]
            if uncertain:
                return "read_failed", sorted(set(uncertain + failed))
            return "not_listed", relevant
        if failed:
            return "read_failed", failed
        return (None, []) if measured else ("missing", relevant)


class TaskScores:
    def __init__(self, store, search, *, concurrency=2, ttl=604800, unknown_ttl=3600, retry=300):
        self.store, self.search = store, search
        self.slots = asyncio.Semaphore(concurrency)
        self.ttl, self.unknown_ttl, self.retry = ttl, unknown_ttl, retry

    async def supplement(self, query):
        key = digest(
            [
                POLICY,
                query["model"],
                query["effort"],
                query["variant"],
                query["dimension"],
                query["sources"],
                query["protocols"],
            ]
        )
        async with self.store.lock("lookup:" + key):
            cached = self.store.cached(key)
            if cached is not None:
                return cached, True
            try:
                async with self.slots:
                    facts = await self.search(query)
                value = {"facts": facts, "error": None}
                ttl = self.ttl if facts else self.unknown_ttl
            except (
                ClassifierError,
                OSError,
                TimeoutError,
                ValueError,
                KeyError,
                IndexError,
                TypeError,
            ) as exc:
                value = {"facts": [], "error": getattr(exc, "code", "SEARCH_UNAVAILABLE")}
                ttl = self.retry
            self.store.cache(key, value, ttl)
            return value, False

    async def score(self, needs, models):
        state = await asyncio.to_thread(self.store.state, True)
        tables = Tables(state)
        primary, secondary = needs["primary"], needs["secondary"]
        if primary not in DIMENSIONS or secondary not in (*DIMENSIONS, "none"):
            raise ValueError("invalid task dimensions")
        weights = {primary: 1} if secondary in (primary, "none") else {primary: 0.7, secondary: 0.3}

        async def one(m):
            model, effort, variant = identity(m.get("canonical") or m["model"])
            effort = m.get("effort", "") or effort
            opts = m.get("hard", {})
            row = {k: m[k] for k in ("candidate_id", "provider", "model")}
            row.update(
                quality_level=None,
                coverage=0,
                basis="unknown",
                evidence_ids=[],
                components=[],
                lookups=[],
                inferred=[],
                hard_ok=False,
                missing_requirements=[],
            )
            if needs["input_status"] != "ready":
                return row

            async def lookup(dim, case, sources, protocols):
                query = {
                    "model": model,
                    "effort": effort,
                    "variant": variant,
                    "dimension": dim,
                    "case": case,
                    "sources": sorted(sources),
                    "protocols": protocols,
                }
                value, cached = await self.supplement(query)
                row["lookups"].append(
                    {
                        "dimension": dim,
                        "case": case,
                        "sources": sources,
                        "cache_hit": cached,
                        "error": value["error"],
                    }
                )
                return value["facts"]

            requirements = needs["task_profile"]["requirements"]
            denied = [req for req in requirements if opts.get(req) is False]
            if denied:
                row["missing_requirements"] = denied
                return row
            for req in requirements:
                if opts.get(req) is True:
                    continue
                case, sources = tables.case(model, req, False)
                facts = await lookup(req, case, sources, [])
                if not any(f.get("kind") == "inferred" for f in facts):
                    row["missing_requirements"].append(req)
            if row["missing_requirements"]:
                return row
            row["hard_ok"] = True
            weighted = 0.0
            plan = {
                dim: tables.selected(dim, needs, variant, m.get("environment")) for dim in weights
            }
            specific_sources = {
                p["source"]
                for protocols in plan.values()
                for p, _ in protocols.values()
                if not p["evaluation"].endswith(":overall")
            }
            for dim, weight in weights.items():
                selected = {
                    k: (p, a)
                    for k, (p, a) in plan[dim].items()
                    if p["source"] not in specific_sources
                    or not p["evaluation"].endswith(":overall")
                }
                expected = {p["evaluation"] for p, _ in selected.values()}
                samples = {}
                for r, anchors, protocol in tables.by_model[(model, effort, variant)]:
                    if protocol["id"] in selected:
                        samples[protocol["id"]] = {
                            **r,
                            "points": percentile(r["raw"], anchors, protocol["direction"]),
                            "via": "snapshot",
                            "reference_version": protocol["reference_version"],
                        }
                counts = Counter(s["evaluation"] for s in samples.values())
                missing = {e for e in expected if counts[e] != 1}
                case, sources = tables.case(model, dim, bool(expected) and not missing)
                if case:
                    failed = {s for s in sources if tables.state[s]["error"]}
                    protocols = {
                        k: (p, a)
                        for k, (p, a) in selected.items()
                        if p["evaluation"] in missing or p["source"] in failed
                    }
                    if protocols:
                        sources = sorted(failed | {p["source"] for p, _ in protocols.values()})
                    facts = await lookup(dim, case, sources, [p for p, _ in protocols.values()])
                    for f in facts:
                        if f["kind"] == "inferred":
                            row["inferred"].append(f)
                        elif f["kind"] == "measurement" and f["protocol"] in protocols:
                            p, anchors = protocols[f["protocol"]]
                            if len(set(anchors)) < 2:
                                anchors = f.get("reference_scores", [])
                                if (
                                    len(anchors) != len(p["reference_models"])
                                    or len(set(anchors)) < 2
                                ):
                                    continue
                            samples.setdefault(
                                p["id"],
                                {
                                    **p,
                                    **f,
                                    "points": percentile(f["raw"], anchors, p["direction"]),
                                    "via": "search",
                                },
                            )
                # Multiple harnesses/formats of one evaluation cannot give it extra votes.
                # Without a specified environment, conflicting protocols remain unknown.
                by_eval = defaultdict(list)
                for sample in samples.values():
                    if not m.get("environment") or m["environment"] == sample["environment"]:
                        by_eval[sample["evaluation"]].append(sample)
                evidence = [items[0] for items in by_eval.values() if len(items) == 1]
                points = sum(e["points"] for e in evidence) / len(evidence) if evidence else None
                missing = sorted(expected - {e["evaluation"] for e in evidence})
                coverage = len(evidence) / len(expected) if expected else 0
                row["components"].append(
                    {
                        "dimension": dim,
                        "weight": weight,
                        "score": points,
                        "evidence": evidence,
                        "missing_evaluations": missing,
                        "coverage": coverage,
                    }
                )
                if points is not None:
                    row["coverage"] += weight * coverage
                    weighted += points * weight * coverage
                    row["evidence_ids"].extend(e["evaluation"] for e in evidence)
            if row["coverage"]:
                row["quality_level"] = round(weighted / row["coverage"], 1)
                row["basis"] = "measured" if row["coverage"] >= 0.9999 else "partial"
            elif set(weights) <= {f["dimension"] for f in row["inferred"]}:
                row["basis"] = "inferred"
                row["evidence_ids"] = sorted({f["url"] for f in row["inferred"]})
            return row

        candidates = await asyncio.gather(*(one(m) for m in models))
        return {
            "score_scale": 10,
            "pipeline_version": POLICY,
            "source": "gemma",
            "status": "ok" if any(m["evidence_ids"] for m in candidates) else "abstain",
            "input_status": needs["input_status"],
            "task_profile": needs["task_profile"],
            "weights": weights,
            "boards": [{k: v for k, v in b.items() if k != "rows"} for b in state.values()],
            "candidates": candidates,
            "reason_codes": [],
        }
