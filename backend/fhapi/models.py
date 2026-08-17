"""Pydantic request models with validation (audit P1-15: email format, min length)."""
from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, Field, field_validator

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class RegisterIn(BaseModel):
    email: str
    password: str = Field(min_length=8, max_length=128)
    displayName: str = Field(min_length=1, max_length=80)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("invalid email address")
        return v


class LoginIn(BaseModel):
    email: str
    password: str

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return v.strip().lower()


class UpdateMeIn(BaseModel):
    displayName: str = Field(min_length=1, max_length=80)


class ChangePasswordIn(BaseModel):
    currentPassword: str
    newPassword: str = Field(min_length=8, max_length=128)


class WorkspaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class CanvasIn(BaseModel):
    revision: int = 0
    nodes: list[dict[str, Any]] = []
    connections: list[list[str]] = []
    viewport: dict[str, Any] = {}


class FilePatchIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    favorite: bool | None = None
    x: float | None = None
    y: float | None = None


class ContentIn(BaseModel):
    content: str


class VersionIn(BaseModel):
    content: str


class TagIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    color: str = Field(default="blue", max_length=32)


class CommentIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class AnchorIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    layout: dict[str, Any]


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    payload: dict[str, Any] = {}


class ChatIn(BaseModel):
    question: str = Field(min_length=1)
    workspaceId: str | None = None
    files: list[dict[str, Any]] = []
    filters: dict[str, Any] = {}


class SummaryIn(BaseModel):
    fileId: str | None = None
    content: str | None = None


class TagsIn(BaseModel):
    name: str = ""
    content: str = ""


class LinksIn(BaseModel):
    source: dict[str, Any] = {}
    candidates: list[dict[str, Any]] = []


class CoverIn(BaseModel):
    fileId: str | None = None
    title: str = ""
    content: str = ""


class ShareIn(BaseModel):
    expiresAt: str | None = None
    permission: str = "read"

    @field_validator("permission")
    @classmethod
    def _perm(cls, v: str) -> str:
        if v not in ("read", "edit"):
            raise ValueError("permission must be 'read' or 'edit'")
        return v


class ConnectionIn(BaseModel):
    aId: str
    bId: str


class SyncChange(BaseModel):
    fileId: str | None = None
    name: str | None = None
    content: str | None = None
    x: float | None = None
    y: float | None = None
    favorite: bool | None = None
    deleted: bool | None = None
    baseUpdatedAt: str | None = None
    workspaceId: str | None = None
    type: str | None = None


class SyncChangesIn(BaseModel):
    changes: list[dict[str, Any]] = []
    workspaceId: str | None = None


class SyncResolveIn(BaseModel):
    resolution: str = "server"
    fileId: str | None = None
    content: str | None = None


class ImportIn(BaseModel):
    files: list[dict[str, Any]] = []


class ExportIn(BaseModel):
    format: str = "json"
