"""FileHub backend configuration.

All settings come from environment variables (optionally via a local ``.env``).
This module fails fast at import time when a critical secret is missing or weak
(security audit P0-9). All runtime artifacts stay on the D: drive.
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

# Local .env lives next to the backend package (backend/.env).
_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=_ENV_PATH, override=False)

_WEAK_SECRETS = {"", "filehub-local-change-me", "replace-me", "change-me", "secret", "changeme"}


def _require_secret() -> str:
    value = os.getenv("FILEHUB_JWT_SECRET", "").strip()
    if value in _WEAK_SECRETS:
        if os.getenv("FILEHUB_DEV", "") == "1":
            return "dev-only-insecure-secret-please-ignore"
        raise RuntimeError(
            "FILEHUB_JWT_SECRET is missing or uses a weak default value. "
            "Set a strong random secret (e.g. python -c \"import secrets;print(secrets.token_urlsafe(48))\") "
            "and refuse to start without it (audit P0-9)."
        )
    return value


JWT_SECRET: str = _require_secret()

# Token lifetimes (audit P0-10: short access + long rotating refresh).
ACCESS_TTL_MIN: int = int(os.getenv("FILEHUB_ACCESS_TTL_MIN", "15"))
REFRESH_TTL_DAYS: int = int(os.getenv("FILEHUB_REFRESH_TTL_DAYS", "30"))
WS_TICKET_TTL_SEC: int = int(os.getenv("FILEHUB_WS_TICKET_TTL_SEC", "60"))

# Runtime paths — kept on D: drive.
ROOT: Path = Path(
    os.getenv("FILEHUB_RUNTIME_DIR", str(Path(__file__).resolve().parent.parent.parent / "runtime"))
)
FILES_DIR: Path = ROOT / "files"
EXPORTS_DIR: Path = ROOT / "exports"
DB_PATH: Path = ROOT / "filehub.db"

# Upload limits and type whitelist (audit P1-11).
MAX_UPLOAD_BYTES: int = int(os.getenv("FILEHUB_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
TRASH_TTL_DAYS: int = int(os.getenv("FILEHUB_TRASH_TTL_DAYS", "30"))

# Text extensions we index into the FTS table.
TEXT_EXT = {
    ".md", ".markdown", ".txt", ".json", ".py", ".java", ".js", ".ts", ".tsx", ".jsx",
    ".go", ".rs", ".c", ".cpp", ".h", ".css", ".html", ".xml", ".yaml", ".yml",
    ".toml", ".sh", ".sql", ".csv", ".log", ".ini", ".conf",
}

# Executable extensions we refuse to accept.
BLOCKED_EXT = {".exe", ".dll", ".bat", ".cmd", ".msi", ".com", ".scr", ".vbs", ".ps1", ".pif"}

ALLOWED_MIME = {
    "text/plain", "text/markdown", "text/csv", "text/html", "text/x-python",
    "application/json", "application/pdf", "application/xml", "text/xml",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
    "application/octet-stream",
}

# CORS — includes the user's preferred dev ports (audit P2-10).
CORS_ORIGINS: list[str] = [
    x.strip()
    for x in os.getenv(
        "FILEHUB_CORS_ORIGINS",
        "http://localhost:8080,http://127.0.0.1:8080,http://localhost:8888,http://127.0.0.1:8888",
    ).split(",")
    if x.strip()
]

# LLM (optional). base_url has no insecure public default anymore (audit P2-12).
OPENAI_API_KEY: str | None = os.getenv("OPENAI_API_KEY") or None
OPENAI_BASE_URL: str | None = os.getenv("OPENAI_BASE_URL") or None
OPENAI_MODEL: str = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_TIMEOUT_SEC: int = int(os.getenv("OPENAI_TIMEOUT_SEC", "30"))


def ensure_dirs() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    FILES_DIR.mkdir(exist_ok=True)
    EXPORTS_DIR.mkdir(exist_ok=True)
