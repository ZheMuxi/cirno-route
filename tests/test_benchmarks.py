import asyncio
import csv
import io
import json
import zipfile

import httpx
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from cirno_route.benchmark_scoring import Tables, TaskScores, percentile
from cirno_route.benchmark_search import DeepSeekSupplement, verify
from cirno_route.benchmark_sources import (
    ARENA,
    EPOCH_TASKS,
    REFERENCE,
    epoch,
    identity,
    imported,
    record,
)
from cirno_route.benchmark_store import BoardStore
from cirno_route.research import CapabilityResearch, ResearchSettings, Source


def table(source, target=None):
    section = "overall"
    labels = list(REFERENCE["arena"])
    values = [1000, 1100, 1200, 1300]
    if target:
        labels += [target]
        values += [1150]
    return [
        record(source, section, label, value, "2026-06-01", ARENA, environment="arena/webdev/raw")
        for label, value in zip(labels, values, strict=True)
    ]


def epoch_zip():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        for name, (_, group) in EPOCH_TASKS.items():
            text = io.StringIO()
            w = csv.writer(text)
            w.writerow(["Model version", "mean_score", "Started at", "id", "Source"])
            for i, label in enumerate(REFERENCE[group]):
                w.writerow([label, i / 4, "2026-06-01", str(i), "Epoch AI"])
            w.writerow(["excluded", 1, "2026-06-01", "bad", "Reprinted from Artificial Analysis"])
            z.writestr(name + ".csv", text.getvalue())
        z.writestr("artificial_analysis_external.csv", "Model version,Score\nother,100")
    return buffer.getvalue()


@pytest.fixture
def store(tmp_path):
    s = BoardStore(tmp_path)
    s.save("arena-webdev", "w1", table("arena-webdev", "demo-1.0"))
    s.save("arena-text", "t1", table("arena-text", "text-only"))
    s.save(
        "epoch",
        "e1",
        [
            record(
                "epoch", "gpqa_diamond", "other", 0.4, "v", "https://epoch.ai", environment="epoch"
            )
        ],
    )
    return s


def needs(primary="frontend", secondary="none", requirements=()):
    return {
        "input_status": "ready",
        "primary": primary,
        "secondary": secondary,
        "task_profile": {
            "kind": "code_implement",
            "difficulty": "routine",
            "requirements": list(requirements),
            "reusable": True,
        },
    }


def model(name, **props):
    return {"candidate_id": name, "model": name, "provider": "demo", **props}


class Search:
    def __init__(self):
        self.calls = []

    async def __call__(self, q):
        self.calls.append(q)
        await asyncio.sleep(0)
        proto = next((p for p in q["protocols"] if p["source"] == "arena-webdev"), None)
        if proto is None:
            return []
        return [
            {
                "kind": "measurement",
                "protocol": proto["id"],
                "raw": 1150,
                "url": ARENA,
                "dimension": q["dimension"],
                "model": q["model"],
                "quote": "offline evidence",
            }
        ]


@pytest.mark.parametrize(
    ("name", "failure", "expected"),
    [
        ("demo-1.0", False, None),
        ("text-only", False, "missing"),
        ("absent-pro", False, "not_listed"),
        ("demo-1.0", True, "read_failed"),
    ],
)
async def test_four_lookup_paths(store, name, failure, expected):
    if failure:
        store.failed("arena-webdev", "READ_FAILED_TIMEOUT")
    search = Search()
    service = TaskScores(store, search)
    result = await service.score(
        needs(), [model(name), model(name, candidate_id="alias", provider="other")]
    )
    row = result["candidates"][0]
    assert row["quality_level"] == 5.0
    assert len(row["components"][0]["evidence"]) == 1
    assert len(search.calls) == int(expected is not None)
    if expected:
        assert search.calls[0]["case"] == expected
        assert search.calls[0]["dimension"] == "frontend"
        assert search.calls[0]["sources"] == ["arena-webdev"]
        assert sum(r["lookups"][0]["cache_hit"] for r in result["candidates"]) == 1
        assert (await service.score(needs(), [model(name)]))["candidates"][0]["lookups"][0][
            "cache_hit"
        ]
        assert len(search.calls) == 1
    if failure:
        assert row["components"][0]["evidence"][0]["via"] == "snapshot"
        assert any(
            b["error"] == "READ_FAILED_TIMEOUT" and b["version"] == "w1" for b in result["boards"]
        )


async def test_fixed_panel_missing_context_and_exact_identity(store):
    assert percentile(1250, [1000, 1100, 1200, 1300]) == pytest.approx(25 / 3)
    assert percentile(1000, [1000, 1000, 1100]) == 2.5
    assert percentile(90, [40, 70, 100], "lower") == pytest.approx(5 / 3)
    assert identity("GPT-6 Luna (Max)") == identity("gpt-6-luna_max")
    assert identity("GPT-6 Luna (High, 20261017)")[0] == "gpt-6-luna-20261017"
    assert identity("abc-preview") != identity("abc")
    assert identity("Demo (High, Codex Harness)") != identity("Demo (High)")

    async def no_data(q):
        return []

    service = TaskScores(store, no_data)
    candidates = [
        model("demo-1.0-pro"),
        model("demo-1.0", effort="high"),
        model("documented-alias", canonical="demo-1.0"),
        model("demo-1.0"),
    ]
    r = await service.score(needs("frontend", "math"), candidates)
    assert [x["quality_level"] for x in r["candidates"]] == [None, None, 5.0, 5.0]
    assert r["candidates"][2]["basis"] == "partial" and r["candidates"][2]["coverage"] == 0.7
    before = await service.score(needs(), candidates[::-1])
    assert before["candidates"][0]["quality_level"] == 5
    store.save("arena-webdev", "short", table("arena-webdev", "demo-1.0")[1:])
    assert (await service.score(needs(), [model("demo-1.0")]))["candidates"][0][
        "quality_level"
    ] is None


async def test_sync_pinned_shards_ttl_and_transactional_recovery(tmp_path):
    clock = [1000000]
    s = BoardStore(tmp_path, now=lambda: clock[0])
    calls, broken = [], []

    def handler(request):
        calls.append(request.url.path)
        if "epoch.ai" in request.url.host:
            return httpx.Response(200, content=b"partial" if "epoch" in broken else epoch_zip())
        sha = "b" * 40
        if request.url.path.endswith("/revision/main"):
            files = [
                "text/latest-00000-of-00002.parquet",
                "text/latest-00001-of-00002.parquet",
                "webdev/latest-00000-of-00001.parquet",
                "text/full-00000-of-00001.parquet",
            ]
            return httpx.Response(
                200, json={"sha": sha, "siblings": [{"rfilename": f} for f in files]}
            )
        assert "/resolve/" + sha in request.url.path and "/latest-" in request.url.path
        if "text" in broken and "/text/latest-00001" in request.url.path:
            return httpx.Response(200, content=b"partial parquet")
        second = "/text/latest-00001" in request.url.path
        rows = [
            {
                "model_name": f"demo-{i}",
                "category": "overall",
                "rating": 1000 + i,
                "leaderboard_publish_date": "2026-06-01",
            }
            for i in (range(100, 103) if second else range(100))
        ]
        data = io.BytesIO()
        pq.write_table(pa.Table.from_pylist(rows), data)
        return httpx.Response(200, content=data.getvalue())

    transport = httpx.MockTransport(handler)
    await s.refresh(transport=transport)
    assert len(calls) == 5
    first = s.state(True)
    assert first["arena-text"]["count"] == 103 and first["epoch"]["count"] == 4 * len(EPOCH_TASKS)
    assert all("excluded" != r["model"] for r in first["epoch"]["rows"])
    clock[0] += 86399
    await s.refresh(transport=transport)
    assert len(calls) == 5
    broken.extend(["text", "epoch"])
    await s.refresh(True, transport=transport)
    for name in ["epoch", "arena-text"]:
        b = s.state(True)[name]
        assert b["error"].startswith("READ_FAILED") and b["rows"] == first[name]["rows"]
    clock[0] += 86401
    broken.clear()
    await s.refresh(transport=transport)
    assert s.state()["epoch"]["error"] is None


async def test_import_provenance_pinning_and_local_read_failure(store, tmp_path):
    csvfile = tmp_path / "export.csv"
    csvfile.write_text("Model,Math\na,10\nb,30\nc,50\ntarget,40\n")
    doc = {
        "source": "superclue",
        "version": "v1",
        "source_url": "https://www.superclueai.com/",
        "reference_groups": {"math": {"version": "panel-1", "models": ["a", "b", "c"]}},
        "table": {
            "file": "export.csv",
            "model_column": "Model",
            "columns": {"math": "Math"},
            "environment": "official-board",
            "unit": "points",
        },
    }
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps(doc))
    store.import_file("superclue", manifest)
    service = TaskScores(store, Search())
    row = (await service.score(needs("math"), [model("target")]))["candidates"][0]
    assert row["quality_level"] == 7.5 and not row["lookups"]
    doc["reference_groups"]["math"]["models"] = ["b", "c", "target"]
    manifest.write_text(json.dumps(doc))
    with pytest.raises(ValueError):
        store.import_file("superclue", manifest)
    assert store.state()["superclue"]["version"] == "v1"
    with pytest.raises(ValueError):
        imported(
            "superclue",
            {**doc, "source_url": "https://superclueai.com.example.org/results", "rows": []},
        )
    store.save("arena-webdev", "new", table("arena-webdev", "new-model"))
    with store.connect() as db:
        db.execute("UPDATE snapshot SET payload='damaged' WHERE version='new'")
    assert store.state(True)["arena-webdev"]["error"] == "SNAPSHOT_INVALID"
    assert store.state(True)["arena-webdev"]["version"] == "w1"


async def test_hard_gate_and_vendor_only_fallback(store):
    touched = []

    async def search(q):
        touched.append(q)
        return [
            {
                "kind": "inferred",
                "dimension": q["dimension"],
                "url": "https://openai.com/",
                "quote": "offline",
            }
        ]

    service = TaskScores(store, search)
    r = await service.score(
        needs(requirements=["vision"]),
        [model("demo-1.0", hard={"vision": False}), model("new", hard={"vision": True})],
    )
    assert not r["candidates"][0]["hard_ok"] and not r["candidates"][0]["lookups"]
    assert r["candidates"][1]["basis"] == "inferred" and r["candidates"][1]["quality_level"] is None
    assert len(touched) == 1


async def test_deepseek_transport_and_attribution(monkeypatch, store):
    monkeypatch.setenv("CIRNO_BENCH_TEST_TOKEN", "offline-placeholder-only")
    conf = ResearchSettings(
        enabled=True,
        api_key_env="CIRNO_BENCH_TEST_TOKEN",
        search_api_key_env="CIRNO_BENCH_TEST_TOKEN",
    )
    calls = []
    quote = "GPT-Example supports frontend development."

    def handler(request):
        calls.append((request.url.path, json.loads(request.content)))
        if request.url.path.endswith("/search"):
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "url": "https://openai.com/models/gpt-example",
                            "title": "GPT-Example",
                            "content": quote,
                        }
                    ]
                },
            )
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": json.dumps(
                                {
                                    "facts": [
                                        {
                                            "kind": "description",
                                            "source_id": "bench1",
                                            "quote": quote,
                                            "evaluated_model": "GPT-Example",
                                        }
                                    ]
                                }
                            )
                        },
                    }
                ]
            },
        )

    lookup = DeepSeekSupplement(CapabilityResearch(conf, transport=httpx.MockTransport(handler)))
    q = {
        "model": "gpt-example",
        "effort": "",
        "variant": "",
        "dimension": "frontend",
        "case": "not_listed",
        "sources": ["arena-webdev"],
        "protocols": [],
    }
    assert (await lookup(q))[0]["kind"] == "inferred" and len(calls) == 2
    p, _ = Tables(store.state(True)).protocols["frontend"][0]
    quote = "GPT-Example overall rating 1150 on 2026-06-01"
    fact = {
        "kind": "measurement",
        "source_id": "s",
        "quote": quote,
        "protocol": p["id"],
        "evaluated_model": "GPT-Example",
        "number": "1150",
    }
    src = Source(
        source_id="s",
        title="WebDev",
        url="https://arena.ai/leaderboard/code/webdev",
        excerpt=quote,
        published_at=None,
    )
    assert verify({"facts": [fact]}, [src], {**q, "protocols": [p]})[0]["raw"] == 1150
    for bad in [
        src.model_copy(update={"excerpt": quote + " according to Artificial Analysis"}),
        src.model_copy(update={"url": "https://reprint.example/report"}),
    ]:
        assert verify({"facts": [fact]}, [bad], {**q, "protocols": [p]}) == []
    assert verify({"facts": [{**fact, "number": "115"}]}, [src], {**q, "protocols": [p]}) == []


async def test_cold_source_can_calibrate_a_verified_official_table(tmp_path):
    store = BoardStore(tmp_path)
    text = (
        "WebDev overall rating 2026-06-01\n"
        "| model | rating |\n| --- | --- |\n| GLM-5.1 | 1000 |\n"
        "| Claude Opus 4.6 (High) | 1100 |\n| GPT-6 Luna (Max) | 1200 |\n"
        "| Grok 4.5 | 1300 |\n| GPT-Example | 1150 |"
    )
    source = Source(
        source_id="b",
        title="WebDev overall rating 2026-06-01",
        url="https://arena.ai/leaderboard/code/webdev",
        excerpt=text,
        published_at=None,
    )

    async def lookup(q):
        protocol = next(p for p in q["protocols"] if p["evaluation"] == "arena-webdev:overall")
        return verify(
            {
                "facts": [
                    {
                        "kind": "measurement",
                        "protocol": protocol["id"],
                        "evaluated_model": "GPT-Example",
                        "number": "1150",
                        "source_id": "b",
                        "quote": "| GPT-Example | 1150 |",
                        "published": "2026-06-01",
                    }
                ]
            },
            [source],
            q,
        )

    r = await TaskScores(store, lookup).score(needs(), [model("gpt-example")])
    row = r["candidates"][0]
    assert row["quality_level"] == 5 and row["lookups"][0]["case"] == "read_failed"
    e = row["components"][0]["evidence"][0]
    assert e["via"] == "search" and e["version"] == "2026-06-01" and len(e["reference_scores"]) == 4


async def test_conflicting_arena_labels_remain_unknown_and_weighting_uses_distinct_dimensions(
    store,
):
    async def empty(_q):
        return []

    web = table("arena-webdev", "target")
    text = table("arena-text", "target")
    text[-1]["raw"] = 1300
    store.save("arena-webdev", "v2", web)
    store.save("arena-text", "v2", text)
    s = TaskScores(store, empty)
    row = (await s.score(needs("frontend", "text"), [model("target")]))["candidates"][0]
    assert row["quality_level"] == 6.5 and row["coverage"] == 1
    store.save("arena-webdev", "v3", [*web, {**web[-1], "raw": 1200}])
    row = (await s.score(needs(), [model("target")]))["candidates"][0]
    assert row["quality_level"] is None and row["lookups"][0]["case"] == "missing"


async def test_price_refresh_alone_cannot_start_capability_search(tmp_path, monkeypatch):
    from cirno_route.research import ModelIdentity, ResearchRequest

    monkeypatch.setenv("CIRNO_BENCH_PRICE", "offline-price-fixture")
    queries = []

    def handler(request):
        assert request.url.path.endswith("/search")
        queries.append(json.loads(request.content)["query"])
        return httpx.Response(200, json={"results": []})

    settings = ResearchSettings(
        enabled=True,
        api_key_env="CIRNO_BENCH_PRICE",
        search_api_key_env="CIRNO_BENCH_PRICE",
        cache_dir=str(tmp_path),
    )
    researcher = CapabilityResearch(settings, transport=httpx.MockTransport(handler))
    m = ModelIdentity(
        candidate_id="one", provider="openai", model="gpt-example", name="gpt-example"
    )
    result = await researcher.run(ResearchRequest(models=[m], action="prices"))
    assert len(queries) == 1 and "pric" in queries[0].lower()
    assert not result["models"][0]["candidate"]["evidence"]


async def test_blank_cells_are_listed_but_unknown(store):
    rows = table("arena-webdev")
    rows.append(
        record(
            "arena-webdev",
            "overall",
            "version-7",
            None,
            "2026-06-01",
            ARENA,
            environment="arena/webdev/raw",
        )
    )
    store.save("arena-webdev", "blanks", rows)
    search = Search()
    result = await TaskScores(store, search).score(needs(), [model("version-7")])
    assert result["candidates"][0]["lookups"][0]["case"] == "missing"
    assert result["candidates"][0]["components"][0]["evidence"][0]["via"] == "search"


async def test_unreadable_store_keeps_last_scores_and_coalesces_off_disk(store, tmp_path):
    store.state(True)
    store.directory = tmp_path / "blocked"
    store.directory.write_text("fixture")
    store.file = store.directory / "unreadable.sqlite3"
    search = Search()
    service = TaskScores(store, search)
    rows = (
        await service.score(needs(), [model("demo-1.0"), model("demo-1.0", candidate_id="two")])
    )["candidates"]
    assert all(r["quality_level"] == 5.0 and r["lookups"][0]["case"] == "read_failed" for r in rows)
    assert sum(r["lookups"][0]["cache_hit"] for r in rows) == 1
    assert len(search.calls) == 1


async def test_only_missing_math_subtest_is_queried(store):
    version, raw = epoch(epoch_zip())

    def measured(section):
        sample = next(r for r in raw if r["evaluation"] == "epoch:" + section)
        return {
            **sample,
            "model": "proof-model",
            "original_model": "Proof Model",
            "effort": "",
            "raw": 0.5,
        }

    rows = [*raw, measured("otis_mock_aime_2024_2025")]
    store.save("epoch", version, rows)
    query = needs("math")
    query["task_profile"].update(kind="math_prove", difficulty="complex")
    search = Search()
    service = TaskScores(store, search)
    row = (await service.score(query, [model("proof-model")]))["candidates"][0]
    assert row["basis"] == "partial" and row["coverage"] == 0.5
    assert row["components"][0]["missing_evaluations"] == ["epoch:frontiermath_tiers_1_3_v2"]
    assert len(search.calls) == 1 and search.calls[0]["case"] == "missing"
    assert [p["evaluation"] for p in search.calls[0]["protocols"]] == [
        "epoch:frontiermath_tiers_1_3_v2"
    ]
    store.save("epoch", "complete", [*rows, measured("frontiermath_tiers_1_3_v2")])
    row = (await service.score(query, [model("proof-model")]))["candidates"][0]
    assert row["basis"] == "measured" and row["coverage"] == 1 and not row["lookups"]
    assert len(search.calls) == 1


@pytest.mark.parametrize(
    ("board", "url", "dimension", "specialty", "columns", "expected"),
    [
        (
            "livebench",
            "https://livebench.ai/",
            "frontend",
            "general",
            ["overall", "design", "design/layout"],
            "design/layout",
        ),
        (
            "decathlon",
            "https://octathlon.wendystars.com/decathlon/categories/",
            "coding",
            "optimization",
            ["overall", "optimization", "game_ai"],
            "optimization",
        ),
    ],
)
async def test_official_category_import_prefers_relevant_subtask(
    store, tmp_path, board, url, dimension, specialty, columns, expected
):
    doc = {
        "source": board,
        "version": "edition-one",
        "source_url": url,
        "rows": [],
        "reference_groups": {s: {"version": "panel-1", "models": ["a", "b", "c"]} for s in columns},
    }
    for section in columns:
        for name, raw in zip(["a", "b", "c", "candidate-x"], [10, 20, 30, 15], strict=True):
            doc["rows"].append(
                {
                    "section": section,
                    "model": name,
                    "score": raw,
                    "unit": "points",
                    "environment": "official fixture",
                    "metric": "score",
                }
            )
    path = tmp_path / "import.json"
    path.write_text(json.dumps(doc))
    store.import_file(board, path)
    query = {**needs(dimension), "specialty": specialty}
    search = Search()
    row = (await TaskScores(store, search).score(query, [model("candidate-x")]))["candidates"][0]
    imported_evals = [
        e["evaluation"] for e in row["components"][0]["evidence"] if e["source"] == board
    ]
    assert imported_evals == [board + ":" + expected]
    assert not any(board in q["sources"] for q in search.calls)
