import asyncio
import hashlib
import io
import tarfile
from pathlib import Path

import httpx
import pytest

from cirno_route import provision
from cirno_route.errors import ClassifierError

DATA = b"GGUF-test-content"
ASSET = {
    "url": "https://models.example/weight",
    "size": len(DATA),
    "sha256": hashlib.sha256(DATA).hexdigest(),
    "filename": "weight.gguf",
}


@pytest.mark.parametrize("range_supported", [True, False])
async def test_partial_download_resume_or_safe_restart(tmp_path, range_supported):
    output = tmp_path / "model.gguf"
    partial = tmp_path / "model.gguf.part"
    partial.write_bytes(DATA[:4])

    def handler(request):
        assert request.headers["range"] == "bytes=4-"
        if range_supported:
            return httpx.Response(
                206,
                headers={"Content-Range": f"bytes 4-{len(DATA) - 1}/{len(DATA)}"},
                content=DATA[4:],
            )
        return httpx.Response(200, content=DATA)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await provision.download(ASSET, output, lambda _: None, client=client)
    assert output.read_bytes() == DATA
    assert not partial.exists()


async def test_checksum_failure_never_publishes_or_overwrites_existing(tmp_path):
    output = tmp_path / "model.gguf"
    output.write_bytes(b"old-data")
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b"x" * len(DATA)))
    ) as client:
        with pytest.raises(ClassifierError, match="DOWNLOAD_CHECKSUM_MISMATCH"):
            await provision.download(ASSET, output, lambda _: None, client=client)
    assert output.read_bytes() == b"old-data"
    assert not output.with_suffix(".gguf.part").exists()


async def test_verified_download_reused_without_network(tmp_path):
    output = tmp_path / "model.gguf"
    output.write_bytes(DATA)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: pytest.fail("verified file should not be downloaded")
        )
    ) as client:
        assert await provision.download(ASSET, output, lambda _: None, client=client) == output


async def test_bad_range_does_not_corrupt_partial(tmp_path):
    output = tmp_path / "model.gguf"
    partial = output.with_suffix(".gguf.part")
    partial.write_bytes(DATA[:4])
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(206, headers={"Content-Range": "bytes 0-3/4"}, content=b"oops")
        )
    ) as client:
        with pytest.raises(ClassifierError, match="DOWNLOAD_INVALID_RANGE"):
            await provision.download(ASSET, output, lambda _: None, client=client)
    assert partial.read_bytes() == DATA[:4]


async def test_missing_model_downloads_into_owned_directory(tmp_path, settings, monkeypatch):
    monkeypatch.setitem(provision.MANIFEST, "model", {**ASSET, "hf_repo": "test-repo"})
    monkeypatch.setenv("HF_HOME", str(tmp_path / "absent-cache"))
    calls = []

    async def fake_download(asset, destination, _progress):
        calls.append((asset, destination))
        return destination

    monkeypatch.setattr(provision, "download", fake_download)
    result = await provision.ensure_model(settings, tmp_path, lambda *_a, **_kw: None)
    assert result == tmp_path / "models" / "weight.gguf"
    assert len(calls) == 1


async def test_model_in_hf_cache_is_reused(tmp_path, settings, monkeypatch):
    monkeypatch.setitem(provision.MANIFEST, "model", {**ASSET, "hf_repo": "test-repo"})
    monkeypatch.setenv("HF_HOME", str(tmp_path / "cache"))
    blob = tmp_path / "cache/hub/test-repo/blobs" / ASSET["sha256"]
    blob.parent.mkdir(parents=True)
    blob.write_bytes(DATA)
    assert await provision.ensure_model(settings, tmp_path, lambda *_a, **_kw: None) == blob


@pytest.mark.parametrize("kind", ["parent-path", "escaping-symlink"])
def test_runtime_archive_cannot_escape_install_root(tmp_path, kind):
    archive = tmp_path / "bad.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        item = tarfile.TarInfo("../outside" if kind == "parent-path" else "bad-link")
        if kind == "escaping-symlink":
            item.type = tarfile.SYMTYPE
            item.linkname = "../../outside"
        else:
            item.size = 4
        tar.addfile(item, io.BytesIO(b"evil"))
    with pytest.raises(ClassifierError, match="RUNTIME_ARCHIVE_INVALID"):
        provision.unpack(archive, tmp_path / "install")
    assert not (tmp_path / "outside").exists()


async def test_missing_binary_uses_pinned_download(tmp_path, monkeypatch):
    monkeypatch.setattr(provision.shutil, "which", lambda _: None)
    monkeypatch.setattr(provision.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(provision.platform, "machine", lambda: "arm64")

    async def compatible(path):
        return (
            path is not None
            and str(path).startswith(str(tmp_path))
            and await asyncio.to_thread(Path(path).is_file)
        )

    monkeypatch.setattr(provision, "compatible_binary", compatible)
    calls = []

    async def fake_download(asset, path, _progress):
        calls.append(asset)
        return path

    def fake_unpack(_archive, target):
        (target / "llama-server").write_text("fake")

    monkeypatch.setattr(provision, "download", fake_download)
    monkeypatch.setattr(provision, "unpack", fake_unpack)
    installed = await provision.ensure_binary(tmp_path, lambda *_a, **_kw: None)
    assert installed.is_file()
    assert calls[0] == provision.MANIFEST["runtime"]["assets"]["Darwin-arm64"]
    assert await provision.ensure_binary(tmp_path, lambda *_a, **_kw: None) == installed
    assert len(calls) == 1


async def test_complete_runtime_partial_is_verified_without_network(tmp_path):
    output = tmp_path / "runtime.tar.gz"
    output.with_suffix(".gz.part").write_bytes(DATA)
    asset = {k: v for k, v in ASSET.items() if k != "size"}
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: pytest.fail("complete partial should be reused"))
    ) as client:
        await provision.download(asset, output, lambda _: None, client=client)
    assert output.read_bytes() == DATA


async def test_unsatisfiable_range_restarts_once(tmp_path):
    output = tmp_path / "runtime.tar.gz"
    output.with_suffix(".gz.part").write_bytes(b"wrong partial")
    asset = {k: v for k, v in ASSET.items() if k != "size"}
    calls = []

    def handler(request):
        calls.append(request)
        if "range" in request.headers:
            return httpx.Response(416)
        return httpx.Response(200, content=DATA)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await provision.download(asset, output, lambda _: None, client=client)
    assert len(calls) == 2 and output.read_bytes() == DATA
