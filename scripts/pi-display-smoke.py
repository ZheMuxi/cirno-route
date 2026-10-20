"""Opt-in real Pi test: three classifications and two small gateway replies, no tools."""

import asyncio
import json
import os
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


async def main():
    os.umask(0o077)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    path = ROOT / ".runtime" / f"pi-display-{stamp}"
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
        "/classify 用 Python 实现归并排序，包含空列表和重复元素的单元测试。",
        "/classify 为一家咖啡店写一段温暖、简短的中文开业文案。",
        "/classify 给出严谨证明：前 n 个奇数之和等于 n 的平方。不要写代码。",
        "/bakarouter",
        "计算 37 × 19，只回复结果。",
        "/bakarouter off",
        "计算 2+2，只回复结果。",
        cwd=ROOT,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        limit=2_097_152,
    )
    results, labels, assistants, warnings, routes = [], [], [], [], []
    automatic_progress = 0
    try:
        async with asyncio.timeout(1200):
            with path.with_suffix(".jsonl").open("w") as log:
                async for line in process.stdout:
                    text = line.decode()
                    log.write(text)
                    log.flush()
                    try:
                        row = json.loads(text)
                    except ValueError:
                        continue
                    kind = row.get("type")
                    if kind == "cirno-classification":
                        results.append(row["data"])
                        print(
                            json.dumps(
                                {
                                    "classification": len(results),
                                    "ms": row["data"].get("latency_ms"),
                                    "candidates": len(row["data"].get("candidates", [])),
                                    "wire_format": row["data"].get("wire_format"),
                                }
                            ),
                            flush=True,
                        )
                    if kind == "cirno-setup":
                        print(row["message"], flush=True)
                        if len(results) == 3 and not assistants and "Gemma 分类" in row["message"]:
                            automatic_progress += 1
                    if kind == "cirno-classifier-warning":
                        warnings.append(row["error"])
                    if kind == "cirno-execution-model":
                        labels.append(row["model"])
                    if kind == "cirno-routing":
                        routes.append(row)
                    if kind == "message_end" and row.get("message", {}).get("role") == "assistant":
                        assistants.append(row["message"])
                await process.wait()
    finally:
        if process.returncode is None:
            process.terminate()
            await process.wait()
    passed = (
        process.returncode == 0
        and len(results) == 3
        and len(assistants) == 2
        and automatic_progress > 0
        and not warnings
        and len(routes) == 1
        and labels == [f"{m['provider']}/{m['model']}" for m in assistants]
        and labels == [f"{routes[0]['provider']}/{routes[0]['model']}"] * 2
        and all(m["stopReason"] == "stop" for m in assistants)
        and all(
            r.get("source") == "gemma"
            and r.get("wire_format") == "compact-v1"
            and len(r["candidates"]) == r["research"]["total"]
            for r in results
        )
    )
    report = {
        "pass": passed,
        "classifications": results,
        "execution_models": labels,
        "automatic_progress": automatic_progress,
        "warnings": warnings,
        "execution_calls": len(assistants),
    }
    path.with_suffix(".report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps({"pass": passed, "report": str(path.with_suffix(".report.json"))}), flush=True)
    assert passed


if __name__ == "__main__":
    asyncio.run(main())
