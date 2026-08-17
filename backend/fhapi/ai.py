"""AI helpers: LLM access, lightweight retrieval, citations, and streaming.

Real Qdrant/RAG is intentionally deferred (documented in BACKEND_TODO.md); here
we provide a deterministic lexical retrieval so citations always correspond to
the files actually fed into the prompt (audit P1-12 — no more fake citations).
"""
from __future__ import annotations

import logging
import re
from typing import Any

from . import config

logger = logging.getLogger("filehub.ai")

_CJK = re.compile(r"[\u4e00-\u9fff]")
_WORD = re.compile(r"[a-z0-9_]+")


def _terms(text: str) -> set[str]:
    lowered = (text or "").lower()
    terms: set[str] = set()
    if _CJK.search(lowered):
        # CJK: use bigrams for a usable match granularity.
        cjk = "".join(_CJK.findall(lowered))
        terms.update(cjk[i:i + 2] for i in range(len(cjk) - 1))
        if len(cjk) == 1:
            terms.add(cjk)
    terms.update(_WORD.findall(lowered))
    return {t for t in terms if len(t) > 1}


def get_llm():
    key = config.OPENAI_API_KEY
    if not key or key in ("", "replace-me"):
        return None
    try:
        from langchain_openai import ChatOpenAI
    except Exception:  # pragma: no cover - depends on optional install
        logger.exception("langchain_openai unavailable")
        return None
    kwargs: dict[str, Any] = {
        "api_key": key,
        "model": config.OPENAI_MODEL,
        "temperature": 0.2,
        "timeout": config.OPENAI_TIMEOUT_SEC,
    }
    if config.OPENAI_BASE_URL:
        kwargs["base_url"] = config.OPENAI_BASE_URL
    try:
        return ChatOpenAI(**kwargs)
    except Exception:
        logger.exception("failed to construct LLM")
        return None


def _snippet(text: str, terms: set[str], width: int = 80) -> str | None:
    low = (text or "").lower()
    best = -1
    for t in terms:
        i = low.find(t)
        if i >= 0 and (best == -1 or i < best):
            best = i
    if best < 0:
        return None
    start = max(0, best - width // 2)
    end = min(len(text), best + width)
    return (text[start:best] + "<mark>" + text[best:best + width // 2] + "</mark>" + text[best + width // 2:end]).strip()


def retrieve(files: list[dict], question: str, k: int = 5) -> list[dict]:
    qterms = _terms(question)
    scored: list[tuple[dict, float]] = []
    for f in files:
        text = (f.get("content") or "") + " " + (f.get("summary") or "") + " " + (f.get("name") or "")
        fterms = _terms(text)
        overlap = len(qterms & fterms)
        # Bonus for matches in the title.
        title_hit = 1.0 if qterms & _terms(f.get("name") or "") else 0.0
        scored.append((f, overlap + title_hit))
    scored.sort(key=lambda x: x[1], reverse=True)
    ranked = [f for f, _ in scored]
    # Prefer files with any overlap; otherwise fall back to top-k by recency.
    with_hits = [f for f, s in scored if s > 0]
    return (with_hits or ranked)[:k]


def build_context(files: list[dict], budget: int = 4000) -> str:
    parts: list[str] = []
    used = 0
    for f in files:
        body = (f.get("content") or f.get("summary") or "")[:1500]
        chunk = f"[{f.get('id')}] {f.get('name')}: {body}\n"
        if used + len(chunk) > budget:
            break
        parts.append(chunk)
        used += len(chunk)
    return "\n".join(parts)


def chat(question: str, files: list[dict], workspace_id: str | None = None) -> dict[str, Any]:
    """Answer a question; returns {answer, citations, usedFiles, mode}."""
    ranked = retrieve(files, question, k=6)
    context = build_context(ranked)
    citations = [
        {"fileId": f.get("id"), "name": f.get("name"), "snippet": _snippet(f.get("content") or "", _terms(question))}
        for f in ranked
    ]
    llm = get_llm()
    if llm is not None and (context or question):
        try:
            answer = llm.invoke(
                "仅依据下方资料回答，若资料不足请明确说明。回答后附引用文件 ID。\n"
                f"资料：\n{context}\n\n问题：{question}"
            ).content
            return {"answer": answer, "citations": citations, "usedFiles": [c["fileId"] for c in citations], "mode": "langchain"}
        except Exception:
            logger.exception("LLM chat failed; falling back")
    answer = (
        f"（离线）AI 服务未配置或不可用。已依据关键词检索到 {len(ranked)} 个相关文件，"
        f"但无法生成摘要式回答。问题：「{question}」"
    )
    return {"answer": answer, "citations": citations, "usedFiles": [c["fileId"] for c in citations], "mode": "fallback"}


def summarize(content: str) -> tuple[str, str]:
    llm = get_llm()
    if llm is not None:
        try:
            text = llm.invoke("请用中文输出要点、待办、结论三部分：\n" + content).content
            return text, "langchain"
        except Exception:
            logger.exception("LLM summarize failed")
    fallback = (content or "")[:300] + ("..." if len(content or "") > 300 else "")
    return fallback, "fallback"


def extract_capsule(content: str) -> tuple[list[str], list[str], str]:
    """Deterministic entity/todo/conclusion extraction (real, not fake)."""
    text = content or ""
    todos = re.findall(r"(?:^|\n)\s*(?:[-*]\s*\[[ x]\]\s*|TODO[:：]?\s*)(.+)$", text, re.MULTILINE)
    entities = sorted({m.group(1) for m in re.finditer(r"\[\[([^\]]+)\]\]", text)})
    conclusion = ""
    for line in text.splitlines():
        s = line.strip()
        if s and not s.startswith(("#", "-", "*", ">", "`")):
            conclusion = s
            break
    return entities[:20], todos[:20], conclusion


def health_score(content: str, updated_at: str | None, links: int, has_tags: bool) -> dict[str, Any]:
    length = len(content or "")
    complete = min(100, 20 + (20 if length > 100 else 0) + (30 if length > 500 else 0) + (30 if has_tags else 0))
    fresh = 70
    if updated_at:
        try:
            from datetime import datetime, timezone
            age_days = (datetime.now(timezone.utc) - datetime.fromisoformat(updated_at)).days
            fresh = max(10, 90 - age_days * 5)
        except Exception:
            pass
    link = min(100, links * 15)
    score = round(0.4 * fresh + 0.3 * link + 0.3 * complete)
    return {"score": score, "fresh": fresh, "link": link, "complete": complete}


def dedup_score(text_a: str, text_b: str) -> int:
    if not text_a and not text_b:
        return 0
    if not text_a or not text_b:
        return 0
    try:
        from difflib import SequenceMatcher
        return round(SequenceMatcher(None, text_a.lower(), text_b.lower()).ratio() * 100)
    except Exception:
        return 0
