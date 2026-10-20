import json
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, field_validator

from .contracts import Contract, Identifier


class Settings(Contract):
    schema_version: str = "1"
    runtime_url: str = "http://127.0.0.1:18080"
    model: str = "cirno-gemma-e4b"
    checkpoint: str = "HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive:Q4_K_M"
    runtime_token_file: str = ".runtime/llama.token"
    api_token_file: str = ".runtime/api.token"
    timeout_seconds: float = Field(default=90.0, gt=0, le=300)
    max_output_tokens: int = Field(default=1536, ge=256, le=4096)
    context_tokens: int = Field(default=8192, ge=4096, le=32768)
    max_input_bytes: int = Field(default=10000, ge=256, le=100000)
    format_retries: int = Field(default=1, ge=0, le=1)
    fallback_order: list[Identifier] = Field(default_factory=list)
    lock_file: str = ".runtime/model-lock.json"

    @field_validator("schema_version")
    @classmethod
    def version(cls, value):
        if value != "1":
            raise ValueError("unsupported settings schema version")
        return value

    @field_validator("runtime_url")
    @classmethod
    def local_endpoint(cls, value):
        url = urlsplit(value)
        if (
            url.scheme != "http"
            or url.hostname not in {"127.0.0.1", "::1"}
            or url.username
            or url.password
            or url.query
            or url.fragment
            or url.path not in {"", "/"}
        ):
            raise ValueError("runtime must use a literal loopback HTTP address without credentials")
        _ = url.port
        return value.rstrip("/")


def load_settings(path: Path) -> Settings:
    settings = Settings.model_validate(json.loads(path.read_text()))
    # Runtime paths are relative to the configuration, never to an arbitrary working folder.
    for name in ("lock_file", "runtime_token_file", "api_token_file"):
        setattr(settings, name, str((path.resolve().parent / getattr(settings, name)).resolve()))
    return settings
