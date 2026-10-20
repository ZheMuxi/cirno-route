"""Opt-in real Pi tool-loop test plus a classification-only oversized-input check."""

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PI = ROOT.parent / "Pi" / "pi-classifier"
RUNTIME = ROOT / ".runtime"
BASE = [
    str(PI),
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--mode",
    "json",
    "-p",
]


def rows(text):
    result = []
    for line in text.split("\n"):
        try:
            result.append(json.loads(line))
        except ValueError:
            pass
    return result


def main():
    proc = subprocess.run(
        BASE
        + [
            "--tools",
            "bash",
            "--session-dir",
            str(RUNTIME / "pi-tool-sessions"),
            "/bakarouter",
            (
                '请调用 bash 工具，仅执行 python3 -c "print(sum(range(1, 101)))"，'
                "然后只回复计算结果。"
            ),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=1200,
        check=False,
    )
    (RUNTIME / "pi-integration-tool.jsonl").write_text(proc.stdout)
    (RUNTIME / "pi-integration-tool.stderr").write_text(proc.stderr)
    events = rows(proc.stdout) + rows(proc.stderr)
    classifiers = [r["data"] for r in events if r.get("type") == "cirno-classification"]
    tools = [r for r in events if r.get("type") == "tool_execution_end"]
    assistants = [
        r["message"]
        for r in events
        if r.get("type") == "message_end" and r.get("message", {}).get("role") == "assistant"
    ]
    assert proc.returncode == 0
    assert not classifiers
    assert not any(r.get("type") == "cirno-classifier-warning" for r in events)
    assert any(
        r.get("type") == "cirno-setup" and "Gemma 分类" in r.get("message", "") for r in events
    )
    labels = [r["model"] for r in events if r.get("type") == "cirno-execution-model"]
    routes = [r for r in events if r.get("type") == "cirno-routing"]
    assert len(routes) == 1
    chosen = f"{routes[0]['provider']}/{routes[0]['model']}"
    assert labels == [chosen]
    assert len(tools) == 1 and tools[0]["toolName"] == "bash" and not tools[0]["isError"]
    assert "5050" in "".join(c.get("text", "") for c in tools[0]["result"]["content"])
    assert len(assistants) >= 2
    assert all(f"{a['provider']}/{a['model']}" == chosen for a in assistants)
    assert assistants[-1]["stopReason"] == "stop"
    assert "5050" in "".join(c.get("text", "") for c in assistants[-1]["content"])
    report = {
        "tool_loop": "passed",
        "classification_count": len(classifiers),
        "execution_model_labels": labels,
        "assistant_turn_count": len(assistants),
        "actual_model": chosen,
        "routing_count": len(routes),
        "tool_output": "5050",
    }
    print(json.dumps(report, ensure_ascii=False), flush=True)

    oversized = subprocess.run(
        BASE + ["--no-session", "--no-tools", "/classify " + "界" * 4000],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    output = rows(oversized.stdout) + rows(oversized.stderr)
    data = [r["data"] for r in output if r.get("type") == "cirno-classification"]
    assert data == [{"error": "CONTEXT_TOO_LARGE"}]
    assert not any(r.get("type") == "message_end" for r in output)
    report["oversized_input"] = "CONTEXT_TOO_LARGE; no execution"
    (RUNTIME / "pi-tool-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps({"oversized_input": "passed"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
