"""Password hashing, standard HS256 JWT, and refresh-token rotation/revocation.

Replaces the bespoke ``user.kind.exp.hmac`` token (audit P0-2, P0-10) with:
- standard JWT (header.payload.signature) carrying sub/typ/ver/iat/exp/iss/aud/jti
- DB-backed refresh tokens that rotate on every refresh and can be revoked
- a per-user ``token_version`` so access tokens can be invalidated instantly
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone

from . import config, db


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64d(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def hash_password(value: str) -> str:
    salt = secrets.token_bytes(16)
    return salt.hex() + ":" + hashlib.pbkdf2_hmac("sha256", value.encode(), salt, 210_000).hex()


def verify_password(value: str, stored: str) -> bool:
    try:
        salt, digest = stored.split(":", 1)
        return hmac.compare_digest(
            hashlib.pbkdf2_hmac("sha256", value.encode(), bytes.fromhex(salt), 210_000).hex(), digest
        )
    except ValueError:
        return False


def _sign(signing_input: str) -> str:
    return _b64(hmac.new(config.JWT_SECRET.encode(), signing_input.encode(), hashlib.sha256).digest())


def _encode(header: dict, payload: dict) -> str:
    h = _b64(json.dumps(header, separators=(",", ":")).encode())
    p = _b64(json.dumps(payload, separators=(",", ":")).encode())
    return f"{h}.{p}.{_sign(f'{h}.{p}')}"


def _base_payload(user_id: str, typ: str, ttl_seconds: int, aud: str) -> dict:
    now = int(time.time())
    return {
        "sub": user_id, "typ": typ, "aud": aud, "iss": "filehub",
        "iat": now, "exp": now + ttl_seconds, "jti": uuid.uuid4().hex,
    }


def make_access_token(user_id: str, token_version: int) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    payload = _base_payload(user_id, "access", config.ACCESS_TTL_MIN * 60, "filehub")
    payload["ver"] = token_version
    return _encode(header, payload)


def make_refresh_token(user_id: str) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    payload = _base_payload(user_id, "refresh", config.REFRESH_TTL_DAYS * 24 * 3600, "filehub")
    return _encode(header, payload)


def make_ws_ticket(user_id: str, workspace_id: str) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    payload = _base_payload(user_id, "ws", config.WS_TICKET_TTL_SEC, workspace_id)
    return _encode(header, payload)


def decode_token(token: str) -> dict | None:
    try:
        h, p, sig = token.split(".")
        signing = f"{h}.{p}"
        if not hmac.compare_digest(sig, _sign(signing)):
            return None
        payload = json.loads(_b64d(p))
        if payload.get("iss") != "filehub":
            return None
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload
    except Exception:
        return None


def store_refresh_token(user_id: str) -> str:
    """Issue and persist a refresh token, pruning old/revoked ones per user."""
    token = make_refresh_token(user_id)
    expires = (datetime.now(timezone.utc) + timedelta(days=config.REFRESH_TTL_DAYS)).isoformat()
    with db.db() as c:
        c.execute(
            "DELETE FROM refresh_tokens WHERE user_id=? AND (revoked_at IS NOT NULL OR expires_at < ?)",
            (user_id, db.now()),
        )
        c.execute(
            "INSERT INTO refresh_tokens(token,user_id,expires_at,created_at,revoked_at) VALUES(?,?,?,?,NULL)",
            (token, user_id, expires, db.now()),
        )
    return token


def rotate_refresh_token(raw: str) -> str | None:
    """Validate a refresh token, revoke it (rotation), return user_id or None."""
    payload = decode_token(raw)
    if not payload or payload.get("typ") != "refresh":
        return None
    user_id = payload.get("sub")
    with db.db() as c:
        row = c.execute(
            "SELECT user_id, expires_at, revoked_at FROM refresh_tokens WHERE token=?", (raw,)
        ).fetchone()
        if not row or row["revoked_at"] is not None:
            return None
        if row["expires_at"] < db.now():
            return None
        c.execute("UPDATE refresh_tokens SET revoked_at=? WHERE token=?", (db.now(), raw))
    return user_id


def revoke_all_refresh_tokens(user_id: str) -> None:
    with db.db() as c:
        c.execute("UPDATE refresh_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (db.now(), user_id))
