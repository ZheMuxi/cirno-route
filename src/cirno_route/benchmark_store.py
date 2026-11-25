"""Transactional local snapshots; network reads run independently of Gemma."""

import asyncio
import contextlib
import fcntl
import hashlib
import json
import sqlite3
import time
from pathlib import Path

import httpx

from .benchmark_sources import (
    AUTO,
    EPOCH,
    MANUAL,
    POLICY,
    arena,
    arena_manifest,
    epoch,
    get_bytes,
    import_table,
    imported,
)

DAY = 86400


class BoardStore:
    def __init__(self, directory, *, now=time.time):
        self.directory = Path(directory)
        with contextlib.suppress(OSError):
            self.directory.mkdir(exist_ok=True, parents=True, mode=0o700)
        self.file = self.directory / "boards.sqlite3"
        self.now = now
        self.last_valid = {}
        self.recent_supplements = {}
        self.local_locks = {}
        # A damaged existing database must remain recoverable. Scoring can still use
        # in-memory evidence and targeted lookup when local reads fail.
        with contextlib.suppress(sqlite3.DatabaseError), self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS source (id TEXT PRIMARY KEY, checked REAL, error TEXT);
                CREATE TABLE IF NOT EXISTS snapshot (source TEXT, hash TEXT, version TEXT,
                    saved REAL, payload BLOB, PRIMARY KEY(source,hash));
                CREATE TABLE IF NOT EXISTS supplement
                    (key TEXT PRIMARY KEY, expires REAL, data TEXT);
                CREATE TABLE IF NOT EXISTS cohort
                    (source TEXT, evaluation TEXT, version TEXT, members TEXT,
                    PRIMARY KEY(source,evaluation,version));
            """)

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.file, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    @contextlib.asynccontextmanager
    async def lock(self, key):
        digest = hashlib.sha256(key.encode()).hexdigest()
        # Lock stripes bound the number of persistent lock files over many snapshot versions.
        name = "lookup-" + digest[:2] if key.startswith("lookup:") else digest
        try:
            handle = (self.directory / (name + ".lock")).open("a")
        except OSError:
            if not key.startswith("lookup:"):
                raise
            # Read-only/unavailable storage still permits coalescing in this worker.
            async with self.local_locks.setdefault(name, asyncio.Lock()):
                yield
            return
        with handle as stream:
            while True:
                try:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    await asyncio.sleep(0.1)
            yield

    def save(self, source, version, rows):
        if not any(r["raw"] is not None for r in rows):
            raise ValueError("empty score table")
        raw = json.dumps(rows, allow_nan=False, separators=(",", ":")).encode()
        fingerprint = hashlib.sha256(raw).hexdigest()
        with self.connect() as db:
            cohorts = {
                (r["evaluation"], r["references"]["version"]): json.dumps(
                    sorted(r["references"]["models"])
                )
                for r in rows
                if "references" in r
            }
            for (evaluation, group_version), members in cohorts.items():
                db.execute(
                    "INSERT OR IGNORE INTO cohort VALUES(?,?,?,?)",
                    (source, evaluation, group_version, members),
                )
                existing = db.execute(
                    "SELECT members FROM cohort WHERE source=? AND evaluation=? AND version=?",
                    (source, evaluation, group_version),
                ).fetchone()
                if existing[0] != members:
                    raise ValueError("changed reference cohort without new version")
            db.execute(
                "INSERT OR REPLACE INTO snapshot VALUES(?,?,?,?,?)",
                (source, fingerprint, version, self.now(), raw),
            )
            db.execute(
                "DELETE FROM snapshot WHERE source=? AND hash NOT IN "
                "(SELECT hash FROM snapshot WHERE source=? ORDER BY saved DESC,rowid DESC LIMIT 2)",
                (source, source),
            )
            db.execute("INSERT OR REPLACE INTO source VALUES(?,?,NULL)", (source, self.now()))

    def failed(self, source, reason):
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO source VALUES(?,?,?)", (source, self.now(), reason))

    def state(self, with_rows=False):
        try:
            result = self._read_state(with_rows)
        except (sqlite3.Error, OSError):
            result = {}
            for s in (*AUTO, *MANUAL):
                previous = self.last_valid.get(s, {})
                enabled = previous.get("enabled", s in AUTO)
                result[s] = {
                    "source": s,
                    "version": None,
                    "updated": None,
                    "checked": None,
                    "count": 0,
                    **previous,
                    "enabled": enabled,
                    "error": "LOCAL_READ_FAILED" if enabled else None,
                }
                if not with_rows:
                    result[s].pop("rows", None)
            return result
        if with_rows:
            self.last_valid = result
        return result

    def _read_state(self, with_rows):
        result = {}
        with self.connect() as db:
            db.execute("BEGIN")
            checks = {s: (t, e) for s, t, e in db.execute("SELECT * FROM source")}
            for s in (*AUTO, *MANUAL):
                checked, error = checks.get(s, (None, None))
                entry = {
                    "source": s,
                    "enabled": s in AUTO,
                    "checked": checked,
                    "error": error,
                    "version": None,
                    "updated": None,
                    "count": 0,
                }
                for fingerprint, version, saved, raw in db.execute(
                    "SELECT hash,version,saved,payload FROM snapshot WHERE source=? "
                    "ORDER BY saved DESC,rowid DESC",
                    (s,),
                ):
                    entry["enabled"] = True
                    try:
                        if hashlib.sha256(raw).hexdigest() != fingerprint:
                            raise ValueError
                        rows = json.loads(raw)
                        if not rows or not isinstance(rows, list):
                            raise ValueError
                    except (ValueError, TypeError):
                        entry["error"] = "SNAPSHOT_INVALID"
                        continue
                    entry.update(version=version, updated=saved, count=len(rows))
                    if with_rows:
                        entry["rows"] = rows
                    break
                if entry["enabled"] and not entry["version"] and not entry["error"]:
                    entry["error"] = "NO_LOCAL_SNAPSHOT"
                result[s] = entry
        return result

    def cached(self, key):
        with contextlib.suppress(sqlite3.Error, ValueError), self.connect() as db:
            row = db.execute(
                "SELECT data FROM supplement WHERE key=? AND expires>?", (key, self.now())
            ).fetchone()
            return json.loads(row[0]) if row else None
        recent = self.recent_supplements.get(key)
        return recent[1] if recent and recent[0] > self.now() else None

    def cache(self, key, data, ttl):
        expires = self.now() + ttl
        self.recent_supplements.pop(key, None)
        if len(self.recent_supplements) >= 128:
            del self.recent_supplements[next(iter(self.recent_supplements))]
        self.recent_supplements[key] = (expires, data)
        with contextlib.suppress(sqlite3.Error), self.connect() as db:
            db.execute("DELETE FROM supplement WHERE expires<=?", (self.now(),))
            db.execute(
                "INSERT OR REPLACE INTO supplement VALUES(?,?,?)",
                (key, expires, json.dumps(data, allow_nan=False)),
            )

    async def refresh(self, force=False, *, transport=None):
        started = self.now()
        async with httpx.AsyncClient(
            timeout=25, transport=transport, follow_redirects=False
        ) as client:
            manifest = None

            async def sync(source):
                nonlocal manifest
                async with self.lock("sync:" + source):
                    with self.connect() as db:
                        last = db.execute(
                            "SELECT checked FROM source WHERE id=?", (source,)
                        ).fetchone()
                    if last and (
                        last[0] >= started or (not force and 0 <= self.now() - last[0] < DAY)
                    ):
                        return
                    try:
                        async with asyncio.timeout(360):
                            if source == "epoch":
                                data, _ = await get_bytes(client, EPOCH, 64_000_000)
                                version, rows = await asyncio.to_thread(epoch, data)
                            else:
                                if manifest is None:
                                    manifest = asyncio.create_task(arena_manifest(client))
                                version, rows = await arena(client, source, await manifest)
                            await asyncio.to_thread(self.save, source, version, rows)
                    except Exception as exc:
                        kind = (
                            "HTTP_" + str(exc.response.status_code)
                            if isinstance(exc, httpx.HTTPStatusError)
                            else type(exc).__name__
                        )
                        self.failed(source, "READ_FAILED_" + kind)

            await asyncio.gather(*(sync(s) for s in AUTO))
        return self.status()

    def status(self):
        return {"policy": POLICY, "sources": list(self.state().values())}

    def import_file(self, source, path):
        if source not in MANUAL:
            raise ValueError("unsupported import source")
        try:
            p = Path(path)
            if not p.is_file() or p.stat().st_size > 32_000_000:
                raise ValueError("invalid import file")
            document = json.loads(p.read_text(encoding="utf-8-sig"))
            version, rows = imported(source, import_table(document, p.parent))
            self.save(source, version, rows)
        except (OSError, ValueError, TypeError, KeyError):
            self.failed(source, "IMPORT_READ_FAILED")
            raise
        return self.status()
