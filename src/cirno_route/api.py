import asyncio
import secrets
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from .classifier import Classifier
from .contracts import ClassifyRequest
from .validation import strict_json


def create_app(classifier: Classifier, token: str):
    if len(token) < 32:
        raise ValueError("API token must contain at least 32 characters")
    gate = asyncio.Lock()

    @asynccontextmanager
    async def lifespan(_app):
        yield
        if classifier.runtime:
            await classifier.runtime.close()

    app = FastAPI(title="CirnoRoute local classifier", version="0.1.0", lifespan=lifespan)

    @app.middleware("http")
    async def authenticate(request: Request, call_next):
        provided = request.headers.get("authorization", "")
        if not secrets.compare_digest(provided.encode(), ("Bearer " + token).encode()):
            return JSONResponse({"error": "UNAUTHORIZED"}, status_code=401)
        return await call_next(request)

    @app.get("/health")
    async def health():
        # Liveness only: model readiness and version checks run on every classification.
        return {"status": "ok", "component": "classifier", "model_readiness": "not_checked"}

    @app.post("/v1/classify")
    async def classify(request: Request):
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            return JSONResponse({"error": "JSON_REQUIRED"}, status_code=415)
        data = bytearray()
        try:
            async with asyncio.timeout(10):
                async for chunk in request.stream():
                    data.extend(chunk)
                    if len(data) > 65536:
                        return JSONResponse({"error": "REQUEST_TOO_LARGE"}, status_code=413)
            parsed = ClassifyRequest.model_validate(strict_json(data.decode()))
        except (ValueError, ValidationError, RecursionError):
            # Do not echo validation input, which can contain the complete private task.
            return JSONResponse({"error": "INVALID_REQUEST"}, status_code=422)
        except TimeoutError:
            return JSONResponse({"error": "REQUEST_TIMEOUT"}, status_code=408)
        if gate.locked():
            return JSONResponse({"error": "CLASSIFIER_BUSY"}, status_code=429)
        async with gate:
            result = await classifier.classify(parsed)
        return JSONResponse(
            result.model_dump(), status_code=409 if result.status == "blocked" else 200
        )

    return app
