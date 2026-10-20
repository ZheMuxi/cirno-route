"""Pinned, checksummed local dependencies; downloads never contain task text or API keys."""

import asyncio
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import tarfile
from contextlib import asynccontextmanager
from importlib.resources import files
from pathlib import Path

import httpx

from .contracts import RuntimeLock
from .errors import ClassifierError

MANIFEST = json.loads(files("cirno_route").joinpath("resources/local-runtime-v1.json").read_text())


async def digest(path):
    def read():
        with path.open("rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest()

    return await asyncio.to_thread(read)


@asynccontextmanager
async def provision_lock(directory, progress):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / "provision.lock").open("a") as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                progress("waiting-for-download")
                await asyncio.sleep(0.5)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


async def download(asset, destination, progress, *, client=None):
    """Keep resumable partials, verify the complete digest, then atomically publish."""
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.exists() and await digest(destination) == asset["sha256"]:
        return destination
    partial = destination.with_suffix(destination.suffix + ".part")
    expected = asset.get("size")
    offset = partial.stat().st_size if partial.exists() else 0
    if offset and not expected and await digest(partial) == asset["sha256"]:
        partial.replace(destination)
        return destination
    if expected and offset >= expected:
        if offset == expected and await digest(partial) == asset["sha256"]:
            partial.replace(destination)
            return destination
        partial.unlink()
        offset = 0
    needed = (expected or 100_000_000) - offset + 128_000_000
    if shutil.disk_usage(destination.parent).free < needed:
        raise ClassifierError("DOWNLOAD_DISK_FULL")
    owned_client = client is None
    client = client or httpx.AsyncClient(
        follow_redirects=True, trust_env=False, timeout=httpx.Timeout(60, connect=20)
    )
    try:
        headers = {"Range": f"bytes={offset}-"} if offset else {}
        async with client.stream("GET", asset["url"], headers=headers) as response:
            if response.status_code == 416 and offset:
                # An invalid/oversized partial must not poison every subsequent attempt.
                partial.unlink()
                return await download(asset, destination, progress, client=client)
            response.raise_for_status()
            if response.status_code == 206:
                content_range = response.headers.get("content-range", "")
                if not re.fullmatch(rf"bytes {offset}-\d+/\d+", content_range):
                    raise ClassifierError("DOWNLOAD_INVALID_RANGE")
                if expected and int(content_range.rsplit("/", 1)[1]) != expected:
                    raise ClassifierError("DOWNLOAD_SIZE_MISMATCH")
            elif response.status_code == 200:
                offset = 0  # Server ignored Range; restart safely instead of appending duplicates.
            else:
                raise ClassifierError("DOWNLOAD_HTTP_ERROR")
            total = expected or (offset + int(response.headers.get("content-length", "0")))
            cap = expected or 100_000_000
            received = offset
            last_percent = -1
            with partial.open("ab" if offset else "wb") as stream:
                async for chunk in response.aiter_bytes(1024 * 1024):
                    received += len(chunk)
                    if received > cap:
                        raise ClassifierError("DOWNLOAD_TOO_LARGE")
                    stream.write(chunk)
                    percent = int(received * 100 / total) if total else 0
                    if percent != last_percent:
                        progress(min(percent, 100))
                        last_percent = percent
                stream.flush()
                os.fsync(stream.fileno())
        if expected and received != expected:
            raise ClassifierError("DOWNLOAD_INCOMPLETE")
        if await digest(partial) != asset["sha256"]:
            partial.unlink(missing_ok=True)
            raise ClassifierError("DOWNLOAD_CHECKSUM_MISMATCH")
        partial.replace(destination)
        destination.chmod(0o600)
        return destination
    except httpx.HTTPError as exc:
        raise ClassifierError("DOWNLOAD_NETWORK_ERROR") from exc
    finally:
        if owned_client:
            await client.aclose()


async def compatible_binary(path):
    if not path or not await asyncio.to_thread(Path(path).is_file) or not os.access(path, os.X_OK):
        return False
    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            str(path), "--version", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
        )
        output, _ = await asyncio.wait_for(process.communicate(), 30)
        text = output.decode(errors="replace")
        return process.returncode == 0 and all(
            MANIFEST["runtime"][key] in text for key in ("build", "commit")
        )
    except (OSError, TimeoutError):
        return False
    finally:
        if process and process.returncode is None:
            process.kill()
            await process.wait()


def unpack(archive, destination):
    """Reject paths/symlinks escaping the install root, devices and oversized archives."""
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        if len(members) > 1000 or sum(m.size for m in members) > 500_000_000:
            raise ClassifierError("RUNTIME_ARCHIVE_INVALID")
        try:
            tar.extractall(destination, members=members, filter="data")
        except (tarfile.TarError, ValueError) as exc:
            raise ClassifierError("RUNTIME_ARCHIVE_INVALID") from exc


async def ensure_binary(directory, progress):
    install = directory / "llama.cpp" / MANIFEST["runtime"]["version"]
    candidates = [shutil.which("llama-server"), "/opt/homebrew/bin/llama-server"]
    candidates.extend(install.rglob("llama-server") if install.exists() else [])
    for candidate in candidates:
        if await compatible_binary(candidate):
            return await asyncio.to_thread(Path(candidate).resolve)
    asset = MANIFEST["runtime"]["assets"].get(f"{platform.system()}-{platform.machine()}")
    if not asset:
        raise ClassifierError("AUTO_INSTALL_PLATFORM_UNSUPPORTED")
    progress("downloading-runtime", percent=0)
    archive = await download(
        asset,
        directory / "downloads" / asset["filename"],
        lambda percent: progress("downloading-runtime", percent=percent),
    )
    staging = install.with_name(install.name + ".installing")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    try:
        await asyncio.to_thread(unpack, archive, staging)
        binaries = list(staging.rglob("llama-server"))
        if len(binaries) != 1 or not await compatible_binary(binaries[0]):
            raise ClassifierError("DOWNLOADED_RUNTIME_INVALID")
        relative = binaries[0].relative_to(staging)
        if install.exists():
            shutil.rmtree(install)
        staging.replace(install)
        return install / relative
    finally:
        if staging.exists():
            shutil.rmtree(staging)


async def ensure_model(settings, directory, progress):
    asset = MANIFEST["model"]
    candidates = []
    try:
        lock = RuntimeLock.model_validate_json(
            await asyncio.to_thread(Path(settings.lock_file).read_text)
        )
        old = Path(lock.model_path)
        if await asyncio.to_thread(old.is_file):
            stat = await asyncio.to_thread(old.stat)
            if (lock.model_digest, lock.model_size, lock.model_mtime_ns) == (
                asset["sha256"],
                stat.st_size,
                stat.st_mtime_ns,
            ) and stat.st_size == asset["size"]:
                return await asyncio.to_thread(old.resolve)
            candidates.append(old)
    except (OSError, ValueError):
        pass
    cache = Path(os.environ.get("HF_HOME", str(Path.home() / ".cache/huggingface"))) / "hub"
    candidates.extend(
        [
            cache / asset["hf_repo"] / "blobs" / asset["sha256"],
            directory / "models" / asset["filename"],
        ]
    )
    for path in dict.fromkeys(candidates):
        if path.is_file() and path.stat().st_size == asset["size"]:
            progress("checking-model")
            if await digest(path) == asset["sha256"]:
                return path.resolve()
    progress("downloading-model", percent=0)
    return await download(
        asset,
        directory / "models" / asset["filename"],
        lambda percent: progress("downloading-model", percent=percent),
    )
