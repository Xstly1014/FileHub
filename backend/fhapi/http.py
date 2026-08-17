"""Unified response envelope, request logging, trace IDs and exception handling.

Success:  ``{"code": 0, "message": "ok", "data": <payload>, "traceId": <id>}``
Error:    HTTP status + ``{"code": <business>, "message": <text>, "data": null, "traceId": <id>}``
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from contextvars import ContextVar

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("filehub.http")

_trace_id: ContextVar[str] = ContextVar("trace_id", default="")

_STATUS_CODE = {
    400: 40001, 401: 40101, 403: 40301, 404: 40401, 409: 40901,
    413: 41301, 415: 41501, 422: 42201, 429: 42901, 500: 50000,
}


def ok(data=None) -> dict:
    return {"code": 0, "message": "ok", "data": data, "traceId": _trace_id.get() or None}


def install_middleware(app: FastAPI) -> None:
    @app.middleware("http")
    async def trace_and_log(request: Request, call_next):
        tid = uuid.uuid4().hex[:12]
        token = _trace_id.set(tid)
        start = time.time()
        try:
            response = await call_next(request)
        finally:
            _trace_id.reset(token)
        response.headers["X-Trace-Id"] = tid
        logger.info(
            "%s %s -> %s (%.1fms)",
            request.method, request.url.path, response.status_code, (time.time() - start) * 1000,
        )
        return response


def register_exception_handlers(app: FastAPI) -> None:
    from fastapi.exceptions import RequestValidationError
    from starlette.exceptions import HTTPException as StarletteHTTPException

    def _body(status: int, message: str) -> JSONResponse:
        return JSONResponse(
            status_code=status,
            content={
                "code": _STATUS_CODE.get(status, status * 100),
                "message": message,
                "data": None,
                "traceId": _trace_id.get() or None,
            },
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_exc(request: Request, exc):
        msg = exc.detail if isinstance(exc.detail, str) else json.dumps(exc.detail, ensure_ascii=False)
        return _body(exc.status_code, msg)

    @app.exception_handler(RequestValidationError)
    async def _validation_exc(request: Request, exc):
        detail = "; ".join(e.get("msg", "") for e in exc.errors())
        return _body(422, "validation error: " + detail)

    @app.exception_handler(Exception)
    async def _unhandled_exc(request: Request, exc):
        logger.exception("unhandled error on %s", request.url.path)
        return _body(500, "internal server error")
