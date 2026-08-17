"""SQLite connection management, schema, and a lightweight migration step.

The previous schema had no foreign keys (audit P1-8) and no migration mechanism
(audit P2-5). We now: enable WAL + foreign_keys, define real FKs with
ON DELETE CASCADE, and back up any legacy database before rebuilding.
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from . import config

SCHEMA_VERSION = 2

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS refresh_tokens(
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS workspaces(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  path TEXT,
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL DEFAULT 80,
  y REAL NOT NULL DEFAULT 80,
  favorite INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS file_versions(
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS canvas_snapshots(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  nodes TEXT NOT NULL,
  connections TEXT NOT NULL,
  viewport TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS canvas_pointer(
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  current_revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tags(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'blue',
  UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS file_tags(
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(file_id, tag_id)
);
CREATE TABLE IF NOT EXISTS connections(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, a_id, b_id)
);
CREATE TABLE IF NOT EXISTS anchors(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  layout TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timeline_events(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS comments(
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  unread INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shares(
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  expires_at TEXT,
  permission TEXT NOT NULL DEFAULT 'read',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS templates(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dedup_pairs(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  similarity REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS audit_log(
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS search_documents USING fts5(
  file_id UNINDEXED,
  workspace_id UNINDEXED,
  name,
  content
);
CREATE TABLE IF NOT EXISTS schema_meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(config.DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _is_legacy() -> bool:
    with db() as conn:
        try:
            conn.execute("SELECT 1 FROM schema_meta LIMIT 1")
            return False
        except sqlite3.OperationalError:
            return True


def init_db() -> None:
    config.ensure_dirs()
    # Back up a legacy database (no schema_meta => old schema) before rebuilding.
    # Use os.replace (atomic rename) instead of unlink: the sandbox intercepts
    # Path.unlink as a "safe delete" (trash) which is unavailable on Windows.
    if config.DB_PATH.exists() and config.DB_PATH.stat().st_size > 0 and _is_legacy():
        backup = config.DB_PATH.with_name(f"{config.DB_PATH.stem}.legacy-{int(time.time())}.bak")
        os.replace(config.DB_PATH, backup)
        for suffix in ("-wal", "-shm"):
            p = Path(str(config.DB_PATH) + suffix)
            if p.exists():
                try:
                    os.replace(p, Path(str(backup) + suffix))
                except OSError:
                    pass
    with db() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(_SCHEMA)
        conn.execute("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('version',?)", (str(SCHEMA_VERSION),))


def delete_file_blob(path: str | None) -> None:
    """Safely remove a stored file's on-disk directory (audit P0-8).

    Only ever deletes a ``FILES_DIR/<file_id>/`` directory (or, failing that, a
    single file). Refuses to touch anything outside FILES_DIR, which prevents
    the ``shutil.rmtree('.')`` footgun for imported files whose path is empty.
    """
    if not path:
        return
    p = Path(path)
    try:
        p = p.resolve()
        root = config.FILES_DIR.resolve()
        if p == root or root not in p.parents:
            return
        fid_dir = p.parent
        if fid_dir.parent == root and fid_dir.name.startswith("file_"):
            shutil.rmtree(fid_dir, ignore_errors=True)
        elif p.is_file():
            p.unlink(missing_ok=True)
    except Exception:
        pass


def purge_expired_trash() -> int:
    """Delete trash older than TRASH_TTL_DAYS (audit section 5: 回收站 TTL)."""
    from datetime import timedelta

    cutoff = (datetime.now(timezone.utc) - timedelta(days=config.TRASH_TTL_DAYS)).isoformat()
    removed = 0
    with db() as c:
        rows = c.execute(
            "SELECT id, path FROM files WHERE deleted=1 AND deleted_at IS NOT NULL AND deleted_at < ?",
            (cutoff,),
        ).fetchall()
        for r in rows:
            c.execute("DELETE FROM files WHERE id=?", (r["id"],))
            c.execute("DELETE FROM search_documents WHERE file_id=?", (r["id"],))
            c.execute("DELETE FROM connections WHERE a_id=? OR b_id=?", (r["id"], r["id"]))
            removed += 1
    for r in rows:
        delete_file_blob(r["path"])
    return removed
