"""Opt-in local Gemma A/B checks; fixtures assess rubric adherence, not provider accuracy."""

import argparse
import asyncio
import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path

from cirno_route.classifier import Classifier
from cirno_route.config import load_settings
from cirno_route.contracts import ClassifyRequest
from cirno_route.worker import ManagedClassifier

ROOT = Path(__file__).resolve().parents[1]


def scores(result):
    return {c["candidate_id"]: c["quality_level"] for c in result["prediction"]["candidates"]}


def assess(case, result, previous):
    levels = scores(result)
    candidates = result["prediction"]["candidates"]
    known = all(v is not None for v in levels.values())
    checks = {
        "gemma_contract": result["source"] == "gemma",
        "no_preferences": all(
            c["preference_fit_level"] is None and "PREFERENCE_MATCH" not in c["reason_codes"]
            for c in candidates
        ),
    }
    expect = case["expect"]
    if winner := expect.get("strict_winner"):
        checks["strict_winner"] = known and all(
            levels[winner] > value for cid, value in levels.items() if cid != winner
        )
    if expect.get("equal_scores"):
        checks["equal_scores"] = known and len(set(levels.values())) == 1
    if expect.get("no_insufficient"):
        checks["no_insufficient"] = all(
            "EVIDENCE_INSUFFICIENT" not in c["reason_codes"] for c in candidates
        )
    if expect.get("all_unknown"):
        checks["all_unknown"] = result["status"] == "abstain" and all(
            v is None for v in levels.values()
        )
    if expect.get("all_known"):
        checks["all_known"] = result["status"] == "ok" and known
    for cid in expect.get("unknown_candidates", []):
        checks[f"{cid}:unknown"] = result["status"] == "abstain" and levels[cid] is None
    for cid, value in expect.get("exact_scores", {}).items():
        checks[f"{cid}:score"] = levels[cid] == value
    for higher, lower in expect.get("greater", []):
        checks[f"{higher}>{lower}"] = (
            levels[higher] is not None
            and levels[lower] is not None
            and levels[higher] > levels[lower]
        )
    if reference := expect.get("same_as"):
        checks["same_scores"] = levels == scores(previous[reference])
        if expect.get("same_prediction"):

            def ordered(value):
                return sorted(value["prediction"]["candidates"], key=lambda c: c["candidate_id"])

            checks["same_prediction"] = result["status"] == previous[reference][
                "status"
            ] and ordered(result) == ordered(previous[reference])
    return checks


async def run(args):
    os.umask(0o077)
    fixture_path = ROOT / args.fixture
    fixture = fixture_path.read_bytes()
    cases = [
        c for c in json.loads(fixture)["cases"] if args.split == "all" or c["split"] == args.split
    ]
    # Validate every selected input before starting inference.
    requests = {c["id"]: ClassifyRequest.model_validate(c["request"]) for c in cases}
    prompts = {}
    for name in args.versions:
        path = ROOT / f"src/cirno_route/resources/router-system-{name}.txt"
        prompts[name] = path.read_text()
    report = {
        "started_at": datetime.now(UTC).isoformat(),
        "split": args.split,
        "fixture_path": str(fixture_path),
        "fixture_sha256": hashlib.sha256(fixture).hexdigest(),
        "prompt_sha256": {
            name: hashlib.sha256(prompt.encode()).hexdigest() for name, prompt in prompts.items()
        },
        "description": "Single seeded paired run; synthetic evidence and rubric checks only.",
        "results": [],
    }
    output = ROOT / args.output
    if output.exists():
        raise SystemExit(f"Refusing to replace an existing evaluation: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)

    def save():
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

    manager = ManagedClassifier(load_settings(ROOT / "config.json"), ROOT / ".runtime")
    previous = {name: {} for name in prompts}
    try:
        await manager.ensure(lambda stage, **details: print(stage, details, flush=True))
        classifiers = {
            name: Classifier(
                manager.settings,
                manager.runtime,
                system_prompt=prompt,
                prompt_version=f"router-system-{name}",
                pipeline_version="v2",
            )
            for name, prompt in prompts.items()
        }
        report["backend_mode"] = manager.mode
        save()
        for index, case in enumerate(cases):
            # Alternate order, sequential inference on the same verified model/settings.
            order = args.versions if index % 2 == 0 else list(reversed(args.versions))
            for name in order:
                result = (await classifiers[name].classify(requests[case["id"]])).model_dump()
                checks = assess(case, result, previous[name])
                row = {
                    "case": case["id"],
                    "prompt": name,
                    "checks": checks,
                    "pass": all(checks.values()),
                    "result": result,
                }
                report["results"].append(row)
                previous[name][case["id"]] = result
                save()
                print(
                    json.dumps(
                        {
                            "case": case["id"],
                            "prompt": name,
                            "pass": row["pass"],
                            "scores": scores(result),
                            "status": result["status"],
                            "failed": [key for key, value in checks.items() if not value],
                            "ms": result["metadata"]["latency_ms"],
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
        report["summary"] = {
            name: {
                "passed": sum(row["pass"] for row in report["results"] if row["prompt"] == name),
                "total": len(cases),
            }
            for name in prompts
        }
        report["completed_at"] = datetime.now(UTC).isoformat()
        save()
        print(json.dumps(report["summary"]), flush=True)
    finally:
        await manager.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--split", choices=("dev", "validation", "order", "all"), required=True)
    parser.add_argument("--output", required=True, help="New report file relative to project root")
    parser.add_argument("--versions", nargs="+", choices=("v1", "v2"), default=["v1", "v2"])
    parser.add_argument("--fixture", default="evals/prompt-cases/task-fit-v1.json")
    asyncio.run(run(parser.parse_args()))
