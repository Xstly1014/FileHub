"""camelCase serialization helpers (audit P1-1: unify response field naming)."""
from __future__ import annotations

from typing import Any


def _camel(s: str) -> str:
    parts = s.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def camelize(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {_camel(str(k)): camelize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [camelize(x) for x in obj]
    return obj


# Fields exposed to the client for a file (never the internal `path`).
_FILE_FIELDS = [
    "id", "name", "type", "mime", "size", "sha256", "summary", "x", "y",
    "favorite", "deleted", "deleted_at", "version", "created_at", "updated_at",
]


def serialize_file(row, *, include_content: bool = False, tags: list[dict] | None = None) -> dict:
    out: dict[str, Any] = {}
    for k in _FILE_FIELDS:
        if k in row.keys():
            out[k] = row[k]
    if include_content:
        out["content"] = row["content"] if "content" in row.keys() else ""
    out["tags"] = tags if tags is not None else []
    return camelize(out)


def serialize_user(row) -> dict:
    return camelize({"id": row["id"], "email": row["email"], "display_name": row["display_name"], "created_at": row["created_at"]})
