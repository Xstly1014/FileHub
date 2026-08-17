"""FileHub API entrypoint.

Run directly for local development, or via ``uvicorn server:app``.
The app object is created by ``fhapi.create_app()``; no DB side effects happen
at import time (they are deferred to the lifespan startup hook — audit P2-6).
"""
from __future__ import annotations

import os

from fhapi import app  # noqa: F401  (re-export the ASGI app for uvicorn)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="127.0.0.1", port=int(os.getenv("PORT", "8787")), reload=False)
