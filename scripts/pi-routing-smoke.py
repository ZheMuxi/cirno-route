"""Opt-in real Pi routing test: local classifications and four tiny remote replies."""

import asyncio
import json
import os
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


async def main():
    os.umask(0o077)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    path = ROOT / ".runtime" / f"pi-routing-{stamp}"
    preferences = ROOT / ".runtime/router-preferences.json"
    original = preferences.read_bytes() if preferences.exists() else None
    settings = ROOT.parent / "Pi/.state/settings.json"

    def defaults():
        data = json.loads(settings.read_text()) if settings.exists() else {}
        return {k: data.get(k) for k in ("defaultProvider", "defaultModel")}

    before = defaults()
    process = None
    results, routes, labels, assistants, warnings, order = [], [], [], [], [], []
    task = "计算 37 × 19，只回复结果。"
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
            "/bakarouter",
            "/classify " + task,
            task,
            "/bakaprice 接受昂贵",
            "/classify " + task,
            task,
            "/bakarouter off",
            "/bakaprice 希望便宜",
            task,
            "/classify " + task,
            task,
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
                    kind = event.get("type")
                    if kind == "cirno-classification":
                        results.append(event["data"])
                        order.append("classify")
                        print(
                            json.dumps(
                                {
                                    "classification": len(results),
                                    "ms": event["data"].get("latency_ms"),
                                    "recommended": event["data"].get("routing", {}).get("model"),
                                    "error": event["data"].get("error"),
                                },
                                ensure_ascii=False,
                            ),
                            flush=True,
                        )
                    elif kind == "cirno-routing":
                        routes.append(event)
                        order.append("route")
                        print(json.dumps(event, ensure_ascii=False), flush=True)
                    elif kind == "cirno-execution-model":
                        labels.append(event["model"])
                    elif kind == "cirno-classifier-warning":
                        warnings.append(event["error"])
                    elif kind == "cirno-setup" and "查询并整理" not in event["message"]:
                        print(event["message"], flush=True)
                    elif (
                        kind == "message_end"
                        and event.get("message", {}).get("role") == "assistant"
                    ):
                        message = event["message"]
                        assistants.append(message)
                        order.append("answer")
                        print(
                            json.dumps(
                                {
                                    "answer": len(assistants),
                                    "provider": message["provider"],
                                    "model": message["model"],
                                    "stop": message["stopReason"],
                                }
                            ),
                            flush=True,
                        )
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
        and len(routes) == 2
        and len(assistants) == 4
        and not warnings
        and defaults() == before
        and order
        == [
            "classify",
            "route",
            "answer",
            "classify",
            "route",
            "answer",
            "answer",
            "classify",
            "answer",
        ]
        and [r["price_preference"] for r in routes] == ["cheap", "premium"]
        and routes[0]["model"] != routes[1]["model"]
        and labels == [f"{m['provider']}/{m['model']}" for m in assistants]
        and labels == [f"{r['provider']}/{r['model']}" for r in routes] + [labels[1]] * 2
        and all(
            r.get("source") == "gemma"
            and len(r["candidates"]) == r["research"]["total"]
            and r.get("routing", {}).get("price_preference") == mode
            for r, mode in zip(results, ("cheap", "premium", "cheap"), strict=True)
        )
        and all(
            m["stopReason"] == "stop" and "703" in "".join(c.get("text", "") for c in m["content"])
            for m in assistants
        )
    )
    report = {
        "pass": passed,
        "classifications": results,
        "routes": routes,
        "execution_models": labels,
        "warnings": warnings,
        "event_order": order,
        "execution_calls": len(assistants),
        "defaults_unchanged": defaults() == before,
    }
    path.with_suffix(".report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps({"pass": passed, "report": str(path.with_suffix(".report.json"))}), flush=True)
    assert passed


if __name__ == "__main__":
    asyncio.run(main())
