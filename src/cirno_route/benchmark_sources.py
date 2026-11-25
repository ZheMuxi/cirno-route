"""Primary-source leaderboard adapters and the versioned comparison protocol."""

import csv
import hashlib
import io
import json
import math
import re
import zipfile
from datetime import date
from urllib.parse import urlsplit

ARENA = "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset"
HUB = "https://huggingface.co/api/datasets/lmarena-ai/leaderboard-dataset/revision/main"
EPOCH = "https://epoch.ai/data/benchmark_data.zip"
AUTO = ("arena-text", "arena-webdev", "epoch")
MANUAL = ("livebench", "superclue", "decathlon")
POLICY = "task-percentiles-v1"
DIMENSIONS = ("frontend", "coding", "math", "reasoning", "knowledge", "text", "chinese")
SPECIALTIES = (
    "general",
    "optimization",
    "algorithm_contest",
    "spatial",
    "geometry",
    "game_development",
    "physics",
    "rendering",
    "data_analysis",
    "science",
)
EXCLUDED = re.compile(
    r"artificial[\W_]*analysis|人工分析(?:榜|指数)|\bAA(?:II| Intelligence Index)\b", re.I
)
EFFORT = r"none|off|minimal|low|medium|high|xhigh|max|ultra|thinking|non-thinking"
REFERENCE = {
    "arena": ["GLM-5.1", "Claude Opus 4.6 (High)", "GPT-6 Luna (Max)", "Grok 4.5"],
    "classic": [
        "gpt-4o-mini-2024-07-18",
        "gpt-4o-2024-08-06",
        "DeepSeek-R1-0528",
        "gpt-5-2025-08-07_high",
    ],
    "frontier": [
        "gpt-4o-mini-2024-07-18",
        "gemini-2.5-pro",
        "gpt-5-2025-08-07_high",
        "gpt-5.5_xhigh",
    ],
    "software": [
        "gpt-4o-2024-11-20",
        "gemini-2.5-pro",
        "gpt-5-mini-2025-08-07_medium",
        "gpt-5-2025-08-07_high",
    ],
    "facts": [
        "gpt-4o-mini-2024-07-18",
        "gpt-4o-2024-08-06",
        "gpt-5-2025-08-07_high",
        "gpt-5.5_xhigh",
    ],
    "mirror": [
        "gpt-5-2025-08-07_high",
        "gpt-5.4-2026-03-05_high",
        "gpt-5.5_xhigh",
        "gpt-5.6-luna_max",
    ],
}
# Only first-party run files. The ZIP also contains third-party and composite data.
EPOCH_TASKS = {
    "math_level_5": ("math", "classic"),
    "frontiermath_tiers_1_3_v2": ("math", "frontier"),
    "otis_mock_aime_2024_2025": ("math", "classic"),
    "gpqa_diamond": ("reasoning", "classic"),
    "swe_bench_verified": ("coding", "software"),
    "mirrorcode": ("coding", "mirror"),
    "simpleqa_verified": ("knowledge", "facts"),
}
MANUAL_TASKS = {
    "livebench": {
        "overall": "reasoning",
        "agentic": "reasoning",
        "browser_use": "reasoning",
        "research": "knowledge",
        "design": "frontend",
        "math": "math",
        "reasoning": "reasoning",
        "coding": "coding",
        "language": "text",
        "instruction_following": "text",
        "data_analysis": "reasoning",
    },
    "superclue": {
        "overall": "chinese",
        "chinese": "chinese",
        "math": "math",
        "reasoning": "reasoning",
        "coding": "coding",
        "knowledge": "knowledge",
        "writing": "text",
        "webdev": "frontend",
        "science_reasoning": "reasoning",
        "task_planning": "reasoning",
        "instruction_following": "text",
        "hallucination_control": "knowledge",
    },
    "decathlon": {
        "overall": "reasoning",
        "webdev": "frontend",
        "math": "math",
        "proof": "math",
        "coding": "coding",
        "optimization": "coding",
        "systems": "coding",
        "game_ai": "coding",
        "algorithm_contest": "coding",
        "spatial": "reasoning",
        "geometry": "reasoning",
        "physics": "coding",
        "rendering": "frontend",
    },
}
HOSTS = {
    "livebench": ("livebench.ai", "github.com/livebench/", "huggingface.co/datasets/livebench/"),
    "superclue": ("superclueai.com", "cluebenchmarks.com", "github.com/cluebenchmark/superclue"),
    "decathlon": (
        "octathlon.wendystars.com/decathlon/",
        "github.com/wendystar0628/ai-all-round-bench",
    ),
    "arena-text": (
        "arena.ai/leaderboard/chat/text",
        "huggingface.co/datasets/lmarena-ai/leaderboard-dataset",
    ),
    "arena-webdev": (
        "arena.ai/leaderboard/code/webdev",
        "huggingface.co/datasets/lmarena-ai/leaderboard-dataset",
    ),
    "epoch": ("epoch.ai", "logs.epoch.ai"),
}


def clean(value, limit=240):
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > limit
        or re.search(r"[\x00-\x1f\x7f]", value)
    ):
        raise ValueError("invalid leaderboard field")
    return value.strip()


def official(board, url):
    parts = urlsplit(clean(url, 2048))
    if parts.scheme != "https" or parts.username or parts.password or parts.port not in (None, 443):
        return False
    host = (parts.hostname or "").removeprefix("www.").lower()
    path = parts.path.lower().rstrip("/")
    if "%" in path or ".." in path:
        return False
    for allowed in HOSTS[board]:
        domain, _, prefix = allowed.rstrip("/").partition("/")
        if host == domain and (
            not prefix or path == "/" + prefix or path.startswith("/" + prefix + "/")
        ):
            return True
    return False


def identity(label):
    # Only presentation delimiters, never family prefixes, version numbers or quantization.
    label = clean(label).casefold()
    effort, environment = "", ""
    paren = re.fullmatch(r"(.+?)\s*\(([^()]+)\)", label)
    if paren:
        label, qualifiers = paren.groups()
        for item in map(str.strip, qualifiers.split(",")):
            if re.fullmatch(EFFORT, item):
                effort = item
            elif re.fullmatch(r"\d{8}", item):
                label += "-" + item
            else:
                environment += ("; " if environment else "") + item
    suffix = re.fullmatch(r"(.+?)[_](" + EFFORT + r")", label)
    if suffix:
        label, effort = suffix.groups()
    return (
        re.sub(r"[\s_]+", "-", label.strip()),
        ("none" if effort == "off" else effort),
        environment,
    )


def spec(board, section):
    if board == "epoch" and section in EPOCH_TASKS:
        return (*EPOCH_TASKS[section], "fraction")
    if board in MANUAL and re.fullmatch(r"[a-z][a-z0-9_]*(/[a-z0-9_-]+)?", section):
        category = section.split("/", 1)[0]
        if category in MANUAL_TASKS[board]:
            return MANUAL_TASKS[board][category], "arena", "points"
    if board == "arena-webdev":
        supported = {"overall", "webdev_react", "webdev_html", "image_to_webdev"}
        return ("frontend" if section in supported else None), "arena", "rating"
    if board == "arena-text":
        dim = {
            "overall": "text",
            "chinese": "chinese",
            "chinese_language": "chinese",
            "math": "math",
            "coding": "coding",
            "hard_prompt": "reasoning",
            "hard_prompts": "reasoning",
            "creative_writing": "text",
            "instruction_following": "text",
        }.get(section)
        return dim, "arena", "rating"
    raise ValueError("unsupported evaluation")


def record(board, section, label, raw, version, url, *, effort="", environment="", details=None):
    dim, group, unit = spec(board, section)
    model, named_effort, qualifier = identity(label)
    missing = raw is None or (
        isinstance(raw, str) and raw.strip().casefold() in {"", "n/a", "na", "null", "—", "-"}
    )
    value = None if missing else float(raw)
    if isinstance(raw, bool) or (
        value is not None
        and (not math.isfinite(value) or (unit == "fraction" and not 0 <= value <= 1))
    ):
        raise ValueError("invalid measurement")
    if effort and named_effort and effort != named_effort:
        raise ValueError("conflicting effort")
    return {
        "evaluation": board + ":" + section,
        "source": board,
        "dimension": dim,
        "unit": unit,
        "group": group,
        "model": model,
        "original_model": label,
        "effort": effort or named_effort,
        "environment": environment,
        "variant": qualifier,
        "raw": value,
        "version": clean(version),
        "url": url,
        "details": details or {},
    }


async def get_bytes(client, url, limit, **kwargs):
    async with client.stream("GET", url, **kwargs) as response:
        response.raise_for_status()
        data = bytearray()
        async for block in response.aiter_bytes():
            data.extend(block)
            if len(data) > limit:
                raise ValueError("oversized source")
        return bytes(data), response.headers


async def arena_manifest(client):
    data, _ = await get_bytes(client, HUB, 4_000_000)
    info = json.loads(data)
    if not re.fullmatch(r"[a-f0-9]{40,64}", info["sha"]):
        raise ValueError("invalid dataset revision")
    return info


def arena_shards(info, board):
    config = board.split("-")[1]
    pattern = re.compile(config + r"/latest-(\d{5})-of-(\d{5})\.parquet")
    parts = []
    for f in info["siblings"]:
        path = f["rfilename"]
        if found := pattern.fullmatch(path):
            parts.append((int(found[1]), int(found[2]), path))
    parts.sort()
    if not parts or any(i != index or n != len(parts) for index, (i, n, _) in enumerate(parts)):
        raise ValueError("missing Arena latest shard")
    return [p for _, _, p in parts]


def arena_rows(data, board):
    # Import only in the independent sync worker. Gemma/scoring does not load Arrow.
    import pyarrow.parquet as pq

    pf = pq.ParquetFile(io.BytesIO(data))
    if not 0 < pf.metadata.num_rows <= 100000 or "rating" not in pf.schema.names:
        raise ValueError("invalid Arena parquet")
    rows = []
    for batch in pf.iter_batches(batch_size=1024, use_threads=False):
        for row in batch.to_pylist():
            if EXCLUDED.search(json.dumps(row, ensure_ascii=False, default=str)):
                continue
            section = clean(row["category"]).lower().replace(" ", "_").replace("-", "_")
            day = date.fromisoformat(str(row["leaderboard_publish_date"])[:10]).isoformat()
            rows.append(
                record(
                    board,
                    section,
                    row["model_name"],
                    row["rating"],
                    day,
                    ARENA,
                    environment="arena/" + board.split("-")[1] + "/raw",
                    details={
                        "votes": row.get("vote_count"),
                        "rank": row.get("rank"),
                        "rating_lower": row.get("rating_lower"),
                        "rating_upper": row.get("rating_upper"),
                        "organization": row.get("organization"),
                        "published": day,
                    },
                )
            )
    return rows


async def arena(client, board, info):
    import asyncio

    rows = []
    for path in arena_shards(info, board):
        raw, _ = await get_bytes(
            client,
            ARENA + "/resolve/" + info["sha"] + "/" + path,
            32_000_000,
            follow_redirects=True,
        )
        rows.extend(await asyncio.to_thread(arena_rows, raw, board))
    dates = {}
    for r in rows:
        if dates.setdefault(r["evaluation"], r["version"]) != r["version"]:
            raise ValueError("mixed Arena vintages")
    if board + ":overall" not in dates:
        raise ValueError("missing overall category")
    return info["sha"], rows


def epoch(data):
    version = hashlib.sha256(data).hexdigest()[:16]
    out = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for section in EPOCH_TASKS:
            member = z.getinfo(section + ".csv")
            if member.file_size > 15_000_000:
                raise ValueError("oversized Epoch CSV")
            with z.open(member) as stream:
                reader = csv.DictReader(io.TextIOWrapper(stream, encoding="utf-8-sig"))
                if not {"Model version", "mean_score", "Started at", "id"} <= set(
                    reader.fieldnames or []
                ):
                    raise ValueError("invalid Epoch header")
                count = 0
                for row in reader:
                    if EXCLUDED.search(
                        " ".join(
                            row.get(k, "") or ""
                            for k in ("Source", "Notes", "Log viewer", "Logs", "Harness")
                        )
                    ):
                        continue
                    out.append(
                        record(
                            "epoch",
                            section,
                            row["Model version"],
                            row["mean_score"],
                            version,
                            EPOCH,
                            environment="epoch/inspect/" + section,
                            details={
                                "run": clean(row["id"]),
                                "started": row["Started at"],
                                "log": row.get("Log viewer"),
                                "metric": "mean_score",
                            },
                        )
                    )
                    count += 1
                if not count:
                    raise ValueError("missing Epoch component")
    return version, out


def imported(board, document):
    if (
        board not in MANUAL
        or document.get("source") != board
        or not official(board, document["source_url"])
    ):
        raise ValueError("invalid official snapshot")
    version = clean(document["version"])
    metadata = {k: v for k, v in document.items() if k not in {"rows", "table", "reference_groups"}}
    if EXCLUDED.search(json.dumps(metadata, ensure_ascii=False)):
        raise ValueError("excluded upstream evaluator")
    groups = document.get("reference_groups", {})
    if not isinstance(groups, dict):
        raise ValueError("invalid reference groups")
    for section, group in groups.items():
        spec(board, section)
        names = group["models"]
        clean(group["version"])
        if (
            not isinstance(names, list)
            or not 3 <= len(names) <= 64
            or len({identity(n) for n in names}) != len(names)
        ):
            raise ValueError("invalid fixed reference cohort")
    seen, out = set(), []
    for row in document["rows"]:
        if EXCLUDED.search(json.dumps(row, ensure_ascii=False)) or EXCLUDED.search(
            str(document.get("attribution", ""))
        ):
            continue
        # Imports transcribe first-party measurements only.
        if row.get("origin", board) != board:
            raise ValueError("unverified evaluation origin")
        url = row.get("source_url", document["source_url"])
        if not official(board, url):
            raise ValueError("invalid row source")
        section = clean(row["section"])
        effort = clean(row["effort"]).lower() if row.get("effort") else ""
        env = clean(row["environment"])
        raw = row["score"]
        if isinstance(raw, str) and raw.strip().endswith("%") and row["unit"] == "percent":
            raw = raw.strip()[:-1]
        r = record(
            board,
            section,
            row["model"],
            raw,
            version,
            url,
            effort=effort,
            environment=env,
            details={"metric": clean(row["metric"]), "unit": clean(row["unit"]), "origin": board},
        )
        # Same benchmark name with different units, dates or harnesses cannot share anchors.
        r["unit"] = r["details"]["unit"]
        direction = row.get("direction", "higher")
        if direction not in {"higher", "lower"} or r["unit"] not in {
            "points",
            "percent",
            "fraction",
            "rating",
            "rank",
            "error",
        }:
            raise ValueError("invalid metric protocol")
        if (
            r["raw"] is not None
            and r["unit"] in {"fraction", "percent"}
            and not 0 <= r["raw"] <= (1 if r["unit"] == "fraction" else 100)
        ):
            raise ValueError("score outside declared scale")
        r["direction"] = direction
        if section in groups:
            r["references"] = groups[section]
        k = (
            r["evaluation"],
            r["model"],
            r["effort"],
            r["variant"],
            env,
            r["unit"],
            r["details"]["metric"],
        )
        if k in seen:
            raise ValueError("duplicate imported evaluation")
        seen.add(k)
        out.append(r)
    if not out:
        raise ValueError("empty official snapshot")
    return version, out


def import_table(document, directory):
    """Map an official wide CSV/JSON export without requiring the user to retype scores."""
    if "table" not in document:
        return document
    table = document["table"]
    filename = (directory / clean(table["file"])).resolve()
    if (
        not filename.is_relative_to(directory.resolve())
        or not filename.is_file()
        or filename.stat().st_size > 32_000_000
    ):
        raise ValueError("invalid local table")
    with filename.open(encoding="utf-8-sig", newline="") as stream:
        if filename.suffix.lower() == ".csv":
            native = list(csv.DictReader(stream))
        elif filename.suffix.lower() == ".json":
            native = json.load(stream)
            for key in table.get("rows_path", []):
                native = native[clean(key)]
        else:
            raise ValueError("expected CSV or JSON table")
    if not isinstance(native, list) or not native or not table["columns"]:
        raise ValueError("empty export")
    rows = []
    for item in native:
        if EXCLUDED.search(json.dumps(item, ensure_ascii=False)):
            continue
        for section, column in table["columns"].items():
            value = item[clean(column)]
            rows.append(
                {
                    "section": section,
                    "model": item[table["model_column"]],
                    "score": value,
                    "effort": item.get(table.get("effort_column"), ""),
                    "environment": item[table["environment_column"]]
                    if "environment_column" in table
                    else table["environment"],
                    "unit": table["unit"],
                    "metric": column,
                    "direction": table.get("direction", "higher"),
                }
            )
    return {**document, "rows": rows}
