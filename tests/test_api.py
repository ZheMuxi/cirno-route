import httpx

from cirno_route.api import create_app
from cirno_route.classifier import Classifier

TOKEN = "a" * 40


async def test_auth_json_validation_and_no_task_echo(settings, request_data):
    app = create_app(Classifier(settings), TOKEN)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (await client.get("/health")).status_code == 401
        client.headers["Authorization"] = "Bearer " + TOKEN
        assert (await client.get("/health")).json()["model_readiness"] == "not_checked"
        assert (await client.post("/v1/classify", content="hello")).status_code == 415
        request_data["sensitive_secret"] = "DO-NOT-ECHO"
        response = await client.post("/v1/classify", json=request_data)
        assert response.status_code == 422 and "DO-NOT-ECHO" not in response.text
        response = await client.post(
            "/v1/classify", content="x" * 65537, headers={"Content-Type": "application/json"}
        )
        assert response.status_code == 413


async def test_authenticated_empty_candidates_block(settings):
    app = create_app(Classifier(settings), TOKEN)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={"Authorization": "Bearer " + TOKEN},
    ) as client:
        response = await client.post(
            "/v1/classify",
            json={
                "task": {"text": "hello"},
                "eligible_candidates": [],
            },
        )
        assert response.status_code == 409
        assert response.json()["reason_codes"] == ["NO_ELIGIBLE_MODEL"]
