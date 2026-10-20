"""Opt-in real Pi V3 prompt check: local classifications only; no execution-model requests."""

import json
import subprocess
from pathlib import Path

from cirno_route.classifier import (
    EVIDENCE_PROMPT,
    INPUT_PROMPT,
    LIMIT_PROMPT,
    PROMPT,
    PROMPT_VERSION,
)
from cirno_route.runtime import sha256

root = Path(__file__).resolve().parents[1]
report_name = "pi-prompt-" + PROMPT_VERSION.rsplit("-", 1)[-1]
tasks = [
    "/classify 计算37乘19，只需要结果。",
    (
        "/classify 为跨服务缓存设计并发一致性方案，"
        "分析重试与失效消息乱序、部分失败的反例，并给出可验证的不变量。"
    ),
    "/classify 识别我未提供的照片中具体人物的姓名，要求确切身份。",
]
proc = subprocess.run(
    [
        str(root.parent / "Pi/pi-classifier"),
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
        *tasks,
    ],
    cwd=root,
    capture_output=True,
    text=True,
    timeout=180,
)
(root / f".runtime/{report_name}.stdout").write_text(proc.stdout)
(root / f".runtime/{report_name}.stderr").write_text(proc.stderr)
rows = []
for line in (proc.stdout + "\n" + proc.stderr).splitlines():
    try:
        rows.append(json.loads(line))
    except ValueError:
        pass
classifications = [r["data"] for r in rows if r.get("type") == "cirno-classification"]
assert proc.returncode == 0, proc.returncode
assert len(classifications) == 3, len(classifications)
assert not any(
    r.get("type") == "message_end" and r.get("message", {}).get("role") == "assistant" for r in rows
)
for c in classifications:
    assert c.get("source") == "gemma", c.get("error")
    assert c.get("pipeline_version") == "v3"
    assert c["prompt_sha256"] == sha256(PROMPT)
    assert c["input_check_prompt_sha256"] == sha256(INPUT_PROMPT)
    assert c["evidence_check_prompt_sha256"] == sha256(EVIDENCE_PROMPT)
    assert c["limit_check_prompt_sha256"] == sha256(LIMIT_PROMPT)
    assert all(x["preference_fit_level"] is None for x in c["candidates"])
levels = [{x["candidate_id"]: x["quality_level"] for x in c["candidates"]} for c in classifications]
assert len(set(levels[0].values())) == 1, levels[0]
assert levels[1]["opus-4-6"] > levels[1]["gemini-3-flash"], levels[1]
assert all(c["status"] == "ok" for c in classifications[:2])
assert classifications[2]["status"] == "abstain"
assert classifications[2]["input_status"] == "missing"
assert all(value is None for value in levels[2].values())
report = {
    "prompt_version": PROMPT_VERSION,
    "pass": True,
    "execution_calls": 0,
    "classifications": classifications,
}
(root / f".runtime/{report_name}-report.json").write_text(
    json.dumps(report, ensure_ascii=False, indent=2) + "\n"
)
print(
    json.dumps(
        {
            "prompt_version": PROMPT_VERSION,
            "pass": True,
            "scores": levels,
            "prompt_sha256": sha256(PROMPT),
        },
        ensure_ascii=False,
    )
)
