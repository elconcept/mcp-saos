"""Independent, read-only MCP adapter for the Polish Portal Orzeczeń MS.

Uses the MIT-licensed, source-validated HTML/RSS parser in vendor/.
Unlike SAOS this is NOT an index of every judgment, and absence is not proof
that a judgment does not exist. No external search or proxy bypass is used.
"""
from __future__ import annotations

import os
import re
import threading
from typing import Any

from mcp.server.fastmcp import FastMCP
from vendor import orzeczenia_ms as portal
from ms_cache import MsCache

mcp = FastMCP(
    "mcp-orzeczenia-ms",
    host="0.0.0.0",
    port=8000,
    streamable_http_path="/mcp",
    stateless_http=True,
    json_response=True,
)

# The helper enforces a 600ms interval *per Client*. Reuse the same Client
# and serialize all tool calls, otherwise concurrent LLM calls evade the limit.
_lock = threading.Lock()
_client = portal.Client()
_ORIGIN = "https://orzeczenia.ms.gov.pl"
_cache = MsCache(os.environ.get("MS_CACHE_DB", "/tmp/ms-discovered.sqlite"))


def _result(status: str, **data: Any) -> dict[str, Any]:
    return {
        "status": status,
        "source": "portal_orzeczen_ms",
        "source_url": _ORIGIN,
        "coverage": "published_selection_only",
        **data,
    }


def _invoke(arguments: list[str]) -> dict[str, Any]:
    with _lock:
        try:
            parsed = portal.parser().parse_args(arguments)
            value = portal.run(parsed, _client)
            # Cache only items observed directly at MS; the source remains
            # authoritative. Failed cache writes do not destroy fetched results.
            output = _result("ok", result=value)
            if isinstance(value, dict):
                command = parsed.command
                if command in ("szukaj", "sygnatura", "rss"):
                    records = value.get("wyniki", [])
                elif command in ("metryka", "orzeczenie", "przepisy"):
                    records = [value]
                else:
                    records = []
                try:
                    output["cached_records"] = _cache.upsert(records)
                except Exception:
                    output["cache_warning"] = "MS result returned, but local discovery cache could not be updated"
            return output
        except portal.Empty as exc:
            # This is ONLY a confirmed "no results" on a recognized MS page.
            return _result("not_found", message=str(exc))
        except (portal.Unknown, portal.PortalError, OSError) as exc:
            # Challenges, HTTP 400/403, network errors, missing body etc.
            # must not be reported as an empty search result.
            return _result("upstream_error", message=str(exc))
        except (ValueError, SystemExit) as exc:
            return _result("invalid_arg", message=str(exc))


def _safe_text(value: str, *, limit: int = 240) -> str:
    value = value.strip()
    if not value or len(value) > limit or any(ord(c) < 32 for c in value):
        raise ValueError("Wymagana niepusta fraza (maks. 240 znaków, bez znaków sterujących)")
    return value


def _optional_date(date: str | None, flag: str) -> list[str]:
    if date is None:
        return []
    try:
        portal.date_arg(date)
    except (ValueError, Exception) as exc:
        raise ValueError("Data musi być istniejącą datą w formacie YYYY-MM-DD") from exc
    return [flag, date]


def _optional_court(court_code: str | None) -> list[str]:
    if court_code is None:
        return []
    if not re.fullmatch(r"\d{8}", court_code):
        raise ValueError("court_code musi być ośmiocyfrowym kodem sądu z /rss/courts")
    return ["--sad", court_code]


@mcp.tool()
def ms_search_by_case(case_number: str, court_code: str | None = None, page: int = 1) -> dict[str, Any]:
    """Find published common-court judgments by sygnatura. Distinguish courts and publication dates.

    If no match, source only confirms the absence in the searchable, selected
    public corpus, NOT the nonexistence of a judgment. May include a broken full
    text on records published after 2026-09-23.
    """
    try:
        if not isinstance(page, int) or page < 1:
            raise ValueError("page musi być >= 1")
        args = ["sygnatura", _safe_text(case_number, limit=80), *_optional_court(court_code), "--strona", str(page)]
        return _invoke(args)
    except ValueError as exc:
        return _result("invalid_arg", message=str(exc))


@mcp.tool()
def ms_search(
    query: str,
    court_code: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    page: int = 1,
) -> dict[str, Any]:
    """Search published SA/SO/SR judgments by text; public portal, not SAOS mirror.

    Date filters are dates of judgment, not publication. Results are partial
    and may have inaccessible full text, always inspect warnings.
    """
    try:
        if not isinstance(page, int) or page < 1:
            raise ValueError("page musi być >= 1")
        args = [
            "szukaj", _safe_text(query), *_optional_court(court_code),
            *_optional_date(date_from, "--od"), *_optional_date(date_to, "--do"),
            "--strona", str(page),
        ]
        return _invoke(args)
    except ValueError as exc:
        return _result("invalid_arg", message=str(exc))


@mcp.tool()
def ms_get_metadata(judgment_id: str) -> dict[str, Any]:
    """Read the actual metadata, source URL and finality indicators for an MS record ID."""
    try:
        return _invoke(["metryka", _safe_text(judgment_id, limit=190)])
    except ValueError as exc:
        return _result("invalid_arg", message=str(exc))


@mcp.tool()
def ms_get_judgment(judgment_id: str) -> dict[str, Any]:
    """Read full MS judgment text; upstream HTTP 400 returns upstream_error, never reconstructed text."""
    try:
        return _invoke(["orzeczenie", _safe_text(judgment_id, limit=190)])
    except ValueError as exc:
        return _result("invalid_arg", message=str(exc))


@mcp.tool()
def ms_get_regulations(judgment_id: str) -> dict[str, Any]:
    """Read the MS 'cited regulations' tab, which may be incomplete."""
    try:
        return _invoke(["przepisy", _safe_text(judgment_id, limit=190)])
    except ValueError as exc:
        return _result("invalid_arg", message=str(exc))


@mcp.tool()
def ms_recent_rss(limit: int = 10, court_code: str | None = None) -> dict[str, Any]:
    """Retrieve a small RSS window of recently published judgments (NOT a full feed archive)."""
    try:
        if not isinstance(limit, int) or not 1 <= limit <= 20:
            raise ValueError("limit musi być w zakresie 1..20")
        return _invoke(["rss", "--limit", str(limit), *_optional_court(court_code)])
    except ValueError as exc:
        return _result("invalid_arg", message=str(exc))



@mcp.tool()
def ms_search_cached(query: str, case_number: bool = False, limit: int = 10) -> dict[str, Any]:
    """Search ONLY the separate local MS-discovered FTS index, without network access.

    These are records encountered on previous queries, NOT the full MS corpus.
    The result distinguishes the presence of full text from a mere snippet.
    """
    try:
        _safe_text(query)
        if not isinstance(limit, int) or not 1 <= limit <= 50:
            raise ValueError("limit must be 1..50")
        with _lock:
            rows = _cache.search(query, case_number=case_number, limit=limit)
        return _result(
            "ok", storage="ms_discovery_cache", results=rows,
            count=len(rows), exhaustive=False,
        )
    except ValueError as exc:
        return _result("invalid_arg", message=str(exc))
    except Exception:
        return _result("cache_error", message="MS local discovery index is unavailable")


@mcp.tool()
def ms_get_cached(judgment_id: str) -> dict[str, Any]:
    """Read a previously discovered MS record, possibly with full cached text.

    Does not assert the public portal is currently reachable or that the
    document is the final/current version.
    """
    try:
        _safe_text(judgment_id, limit=190)
        with _lock:
            row = _cache.get(judgment_id)
        return _result(
            "ok" if row else "not_found",
            storage="ms_discovery_cache",
            record=row,
            exhaustive=False,
        )
    except ValueError as exc:
        return _result("invalid_arg", message=str(exc))
    except Exception:
        return _result("cache_error", message="MS local discovery index is unavailable")

if __name__ == "__main__":
    mcp.run(transport="streamable-http")
