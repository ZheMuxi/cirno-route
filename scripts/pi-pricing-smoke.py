"""Opt-in real Pi/Gemma price preference test; no execution model calls."""

import asyncio
import json
import os
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


async def main():
    os.umask(0o077)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    path = ROOT / ".runtime" / f"pi-pricing-{stamp}"
    preferences = ROOT / ".runtime/router-preferences.json"
    original = preferences.read_bytes() if preferences.exists() else None
    process = None
    results, notices, assistants = [], [], []
    task = "/classify 用 Python 实现归并排序，包含空列表和重复元素的单元测试。"
    try:
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
            "/bakaprice 希望便宜",
            task,
            "/bakaprice 均衡",
            task,
            "/bakaprice 接受昂贵",
            task,
            "/bakaprice status",
            cwd=ROOT,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=2_097_152,
        )
        async with asyncio.timeout(1200):
            with path.with_suffix(".jsonl").open("w") as log:
                async for line in process.stdout:
                    text = line.decode()
                    log.write(text)
                    log.flush()
                    try:
                        event = json.loads(text)
                    except ValueError:
                        continue
                    if event.get("type") == "cirno-classification":
                        data = event["data"]
                        results.append(data)
                        print(
                            json.dumps(
                                {
                                    "classification": len(results),
                                    "ms": data.get("latency_ms"),
                                    "candidates": len(data.get("candidates", [])),
                                    "routing": data.get("routing"),
                                    "error": data.get("error"),
                                },
                                ensure_ascii=False,
                            ),
                            flush=True,
                        )
                    elif event.get("type") == "cirno-price-preference":
                        notices.append(event["message"])
                    elif event.get("type") == "cirno-setup":
                        print(event["message"], flush=True)
                    elif (
                        event.get("type") == "message_end"
                        and event.get("message", {}).get("role") == "assistant"
                    ):
                        assistants.append(event["message"])
                await process.wait()
    finally:
        if process and process.returncode is None:
            process.terminate()
            await process.wait()
        if original is None:
            preferences.unlink(missing_ok=True)
        else:
            preferences.write_bytes(original)
    passed = (
        process.returncode == 0
        and len(results) == 3
        and len(notices) == 4
        and "接受昂贵" in notices[-1]
        and not assistants
        and [r.get("routing", {}).get("price_preference") for r in results]
        == ["cheap", "balanced", "premium"]
        and len({r.get("candidate_cards_sha256") for r in results}) == 1
        and len({r.get("prompt_sha256") for r in results}) == 1
        and all(
            r.get("source") == "gemma"
            and r.get("wire_format") == "compact-v1"
            and len(r["candidates"]) == r["research"]["total"]
            and r["routing"]["known_prices"] > 0
            and r["routing"]["recommended_candidate_id"] is not None
            for r in results
        )
    )
    report = {"pass": passed, "classifications": results, "execution_calls": len(assistants)}
    path.with_suffix(".report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps({"pass": passed, "report": str(path.with_suffix(".report.json"))}), flush=True)
    assert passed


if __name__ == "__main__":
    asyncio.run(main())
