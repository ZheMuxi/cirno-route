"""Opt-in real Gemma comparison using frozen research snapshots; no research/execution API."""

import argparse
import asyncio
import importlib.util
import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path

from cirno_route.classifier import Classifier
from cirno_route.config import load_settings
from cirno_route.contracts import ClassifyRequest
from cirno_route.research import Profile, card_from_profile, digest
from cirno_route.runtime import sha256
from cirno_route.worker import ManagedClassifier

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("rubric", ROOT / "scripts/evaluate-prompts.py")
rubric = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rubric)


async def run(args):
    os.umask(0o077)
    output = ROOT / args.output
    if output.exists():
        raise SystemExit("Report exists; choose a new output path.")
    report = {"started_at": datetime.now(UTC).isoformat(), "catalog": [], "fixtures": []}
    output.parent.mkdir(parents=True, exist_ok=True)

    def save():
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

    manager = ManagedClassifier(load_settings(ROOT / "config.json"), ROOT / ".runtime")
    previous = {"full": {}, "compact": {}}
    try:
        start = time.monotonic()
        await manager.ensure(lambda stage, **_: print(stage, flush=True))
        report["startup_ms"] = round((time.monotonic() - start) * 1000)
        classifiers = {
            mode: Classifier(
                manager.settings.model_copy(
                    update={"compact_protocol": mode == "compact", "max_input_bytes": 30000}
                ),
                manager.runtime,
            )
            for mode in ("full", "compact")
        }
        if args.catalog_report:
            reference = json.loads((ROOT / args.catalog_report).read_text())["classifications"][-1]
            cards = []
            for row in reference["capability_records"]:
                path = (
                    ROOT
                    / ".runtime/model-capabilities/snapshots"
                    / (row["record_sha256"] + ".json")
                )
                raw = path.read_text()
                if digest(json.loads(raw)) != row["record_sha256"]:
                    raise ValueError("Snapshot checksum mismatch")
                profile = Profile.model_validate_json(raw)
                cards.append(card_from_profile(profile.identity, profile))
            cards.sort(key=lambda c: c.candidate_id)
            known = [c for c in cards if c.evidence]
            report["frozen_records"] = reference["capability_records"]
            for repeat in range(args.repeats):
                task = (
                    [
                        args.task,
                        "为一家咖啡店写一段温暖、简短的中文开业文案。",
                        "给出严谨证明：前 n 个奇数之和等于 n 的平方。不要写代码。",
                    ][repeat % 3]
                    if args.vary_tasks
                    else args.task
                )
                for mode in args.modes if repeat % 2 == 0 else list(reversed(args.modes)):
                    size = 3 if mode == "full" else args.batch_size
                    batches = []
                    start = time.monotonic()
                    for index in range(0, len(known), size):
                        request = ClassifyRequest.model_validate(
                            {
                                "task": {"text": task},
                                "eligible_candidates": known[index : index + size],
                            }
                        )
                        batches.append((await classifiers[mode].classify(request)).model_dump())
                    row = {
                        "repeat": repeat,
                        "task_sha256": sha256(task),
                        "mode": mode,
                        "total_candidates": len(cards),
                        "unknown_candidates": len(cards) - len(known),
                        "ms": round((time.monotonic() - start) * 1000),
                        "batches": batches,
                        "scores": {k: v for b in batches for k, v in rubric.scores(b).items()},
                    }
                    report["catalog"].append(row)
                    save()
                    print(json.dumps({k: v for k, v in row.items() if k != "batches"}), flush=True)
        if args.fixtures:
            fixture = (ROOT / "evals/prompt-cases/task-fit-v1.json").read_text()
            report["fixture_sha256"] = sha256(fixture)
            for index, case in enumerate(json.loads(fixture)["cases"]):
                request = ClassifyRequest.model_validate(case["request"])
                for mode in args.modes if index % 2 == 0 else list(reversed(args.modes)):
                    result = (await classifiers[mode].classify(request)).model_dump()
                    checks = rubric.assess(case, result, previous[mode])
                    previous[mode][case["id"]] = result
                    row = {
                        "case": case["id"],
                        "mode": mode,
                        "checks": checks,
                        "pass": all(checks.values()),
                        "result": result,
                    }
                    report["fixtures"].append(row)
                    save()
                    print(
                        json.dumps(
                            {
                                "case": case["id"],
                                "mode": mode,
                                "pass": row["pass"],
                                "scores": rubric.scores(result),
                                "ms": result["metadata"]["latency_ms"],
                            }
                        ),
                        flush=True,
                    )
        report["completed_at"] = datetime.now(UTC).isoformat()
        save()
    finally:
        await manager.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--catalog-report")
    parser.add_argument(
        "--task", default="用 Python 实现归并排序，包含空列表和重复元素的单元测试。"
    )
    parser.add_argument("--batch-size", type=int, choices=range(1, 9), default=8)
    parser.add_argument("--repeats", type=int, choices=range(1, 6), default=2)
    parser.add_argument("--fixtures", action="store_true")
    parser.add_argument(
        "--vary-tasks", action="store_true", help="Cycle coding, writing and proof tasks"
    )
    parser.add_argument(
        "--modes", nargs="+", choices=["full", "compact"], default=["full", "compact"]
    )
    asyncio.run(run(parser.parse_args()))
