import os
import pytest


def _default_base_url() -> str:
    """Where the live Jetson service can be reached.

    Resolution order:
      1. $JETSON_URL (explicit override, e.g. CI)
      2. $JETSON_HOST + $JETSON_PORT (matches the deploy .env)
      3. http://monster:8080 (dev default)
    """
    if url := os.environ.get("JETSON_URL"):
        return url.rstrip("/")
    host = os.environ.get("JETSON_HOST", "monster")
    port = os.environ.get("JETSON_PORT", "8080")
    return f"http://{host}:{port}"


@pytest.fixture(scope="session")
def base_url() -> str:
    return _default_base_url()
