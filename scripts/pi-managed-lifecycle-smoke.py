"""Opt-in real-model lifecycle check: warm reuse and cleanup after abrupt parent death."""

import json
import os
import select
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    os.umask(0o077)
    module = (ROOT / "packages/pi-extension/local-backend.mjs").as_uri()
    code = f"""
      import {{ LocalBackend }} from {json.dumps(module)};
      import {{ readFileSync }} from 'node:fs';
      const backend = new LocalBackend({json.dumps(str(ROOT))});
      const input = JSON.parse(readFileSync('examples/coding.json', 'utf8'));
      for (let i=0; i<2; i++) {{
        const result=await backend.classify(input);
        process.stdout.write(JSON.stringify({{source:result.source,status:result.status,
          backend:result.metadata.local_backend}})+'\\n');
      }}
      setInterval(() => {{}},1000);
    """
    process = subprocess.Popen(
        ["node", "--input-type=module", "-e", code],
        cwd=ROOT,
        env={**os.environ, "CIRNO_RUNTIME_REUSE": "0"},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    rows = []
    try:
        for _ in range(2):
            assert select.select([process.stdout], [], [], 120)[0], "worker deadline"
            line = process.stdout.readline()
            assert line, "worker exited"
            row = json.loads(line)
            assert row["source"] == "gemma" and row["status"] == "ok", row
            rows.append(row)
            print(json.dumps(row), flush=True)
        assert rows[0]["backend"]["pid"] == rows[1]["backend"]["pid"]
        pid = rows[0]["backend"]["pid"]
        os.kill(pid, 0)
        process.kill()  # Simulate Pi being killed without session_shutdown.
        process.wait(timeout=5)
        deadline = time.monotonic() + 15
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            assert time.monotonic() < deadline, "orphaned model process"
            time.sleep(0.1)
        report = {"warm_reuse": True, "parent_death_cleanup": True, "requests": rows}
        (ROOT / ".runtime/pi-managed-lifecycle-report.json").write_text(
            json.dumps(report, indent=2) + "\n"
        )
        print("Warm reuse and parent-death cleanup: passed", flush=True)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        process.stdout.close()
        process.stderr.close()


if __name__ == "__main__":
    main()
