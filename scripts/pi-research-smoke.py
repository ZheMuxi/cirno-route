"""Opt-in paid public-model research and local Gemma smoke; never calls execution models."""

import argparse
import asyncio
import json
import os
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


async def main(refresh=False):
    os.umask(0o077)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    output = ROOT / ".runtime" / f"pi-research-{stamp}.jsonl"
    task = "/classify 用 Python 实现归并排序，包含空列表和重复元素的单元测试。"
    process = await asyncio.create_subprocess_exec(
        str(ROOT.parent / "Pi/pi-classifier"),
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--no-session",
        "--no-tools",
        "--mode",
        "json",
        "-p",
        *(["/bakamodels refresh"] if refresh else []),
        task,
        task,
        "/bakamodels",
        cwd=ROOT,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        limit=2_097_152,
    )
    classifications, messages, execution_calls = [], [], 0
    try:
        async with asyncio.timeout(1200):
            with output.open("w") as log:
                async for line in process.stdout:
                    text = line.decode()
                    log.write(text)
                    log.flush()
                    try:
                        row = json.loads(text)
                    except ValueError:
                        continue
                    if row.get("type") == "cirno-setup":
                        print(row["message"], flush=True)
                    if row.get("type") == "cirno-research":
                        messages.append(row["message"])
                    if row.get("type") == "cirno-classification":
                        result = row["data"]
                        classifications.append(result)
                        print(
                            json.dumps(
                                {
                                    "classification": len(classifications),
                                    "status": result.get("status"),
                                    "source": result.get("source"),
                                    "candidates": len(result.get("candidates", [])),
                                    "research": result.get("research"),
                                    "error": result.get("error"),
                                    "batch_count": result.get("batch_count"),
                                },
                                ensure_ascii=False,
                            ),
                            flush=True,
                        )
                    if (
                        row.get("type") == "message_end"
                        and row.get("message", {}).get("role") == "assistant"
                    ):
                        execution_calls += 1
                await process.wait()
    finally:
        if process.returncode is None:
            process.terminate()
            await process.wait()
    assert process.returncode == 0, process.returncode
    assert execution_calls == 0
    assert len(classifications) == 2, classifications
    for result in classifications:
        assert not result.get("error"), result
        assert result["source"] == "gemma", result
        assert result["pipeline_version"] == "v2"
        assert len(result["candidates"]) > 8
        assert result["batch_count"] > 1
        assert all(c["preference_fit_level"] is None for c in result["candidates"])
    second = classifications[1]["research"]
    assert second["cache_hits"] + second["cooldown_hits"] == second["total"], second
    assert messages, "manual cache status command returned nothing"
    if refresh:
        assert len(messages) == 2, "manual refresh command returned nothing"
    scores = [
        {c["candidate_id"]: c["quality_level"] for c in r["candidates"]} for r in classifications
    ]
    report = {
        "pass": True,
        "execution_calls": execution_calls,
        "repeat_scores_equal": scores[0] == scores[1],
        "manual_refresh": refresh,
        "classifications": classifications,
        "cache_status": messages,
    }
    report_path = ROOT / ".runtime" / f"pi-research-{stamp}-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(
        json.dumps(
            {
                "pass": True,
                "report": str(report_path),
                "repeat_scores_equal": scores[0] == scores[1],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="先通过 Pi 手动刷新所有能力资料")
    asyncio.run(main(parser.parse_args().refresh))
