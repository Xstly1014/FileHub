"""FileHub application factory."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import config, db
from .http import install_middleware, register_exception_handlers


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    try:
        db.purge_expired_trash()
    except Exception:
        logging.getLogger("filehub").exception("trash purge failed")
    yield


def create_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    app = FastAPI(
        title="FileHub API",
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/api/v1/docs",
        openapi_url="/api/v1/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.CORS_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=True,
    )

    from .routes import router
    app.include_router(router, prefix="/api/v1")
    # Legacy alias kept for a smooth transition; the canonical prefix is /api/v1.
    app.include_router(router, prefix="/api", include_in_schema=False)

    # Liveness probe without auth (docker healthcheck / LB).
    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    install_middleware(app)
    register_exception_handlers(app)
    return app


app = create_app()
