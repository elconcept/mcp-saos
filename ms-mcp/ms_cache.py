"""Separate write-through SQLite cache for MS portal discoveries.

Not the SAOS dump and never modifies its incremental-sync tables.
Records enter this database only after a successful response from the MS source;
a search snippet is not treated as full-text evidence.
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS ms_judgments (
    id TEXT PRIMARY KEY,
    sygnatura TEXT,
    sad TEXT,
    typ TEXT,
    data_orzeczenia TEXT,
    data_publikacji TEXT,
    url TEXT NOT NULL,
    fragment TEXT,
    tresc TEXT,
    details_json TEXT,
    last_seen_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS ms_fts USING fts5(
    id UNINDEXED, sygnatura, sad, fragment, tresc,
    tokenize='unicode61 remove_diacritics 2'
);
"""


class MsCache:
    def __init__(self, path: str):
        self.path = Path(path)

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=15000")
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript(_SCHEMA)
        return db

    def upsert(self, records: list[dict[str, Any]]) -> int:
        saved = 0
        if not records:
            return saved
        with self._connect() as db:
            for rec in records:
                ident = rec.get("id")
                url = rec.get("url")
                if not isinstance(ident, str) or not ident or not isinstance(url, str) or not url.startswith(
                    "https://orzeczenia.ms.gov.pl/"
                ):
                    continue
                now = datetime.now(UTC).isoformat()
                db.execute(
                    """INSERT INTO ms_judgments
                       (id, sygnatura, sad, typ, data_orzeczenia, data_publikacji,
                        url, fragment, tresc, details_json, last_seen_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET
                         sygnatura=COALESCE(excluded.sygnatura, ms_judgments.sygnatura),
                         sad=COALESCE(excluded.sad, ms_judgments.sad),
                         typ=COALESCE(excluded.typ, ms_judgments.typ),
                         data_orzeczenia=COALESCE(excluded.data_orzeczenia, ms_judgments.data_orzeczenia),
                         data_publikacji=COALESCE(excluded.data_publikacji, ms_judgments.data_publikacji),
                         url=excluded.url,
                         fragment=COALESCE(excluded.fragment, ms_judgments.fragment),
                         tresc=COALESCE(excluded.tresc, ms_judgments.tresc),
                         details_json=COALESCE(excluded.details_json, ms_judgments.details_json),
                         last_seen_at=excluded.last_seen_at""",
                    (
                        ident, rec.get("sygnatura"), rec.get("sad"), rec.get("typ"),
                        rec.get("data_orzeczenia"), rec.get("data_publikacji"), url,
                        rec.get("fragment"), rec.get("tresc"),
                        json.dumps(rec, ensure_ascii=False) if "wyniki" not in rec else None,
                        now,
                    ),
                )
                data = db.execute(
                    "SELECT sygnatura,sad,fragment,tresc FROM ms_judgments WHERE id=?",
                    (ident,),
                ).fetchone()
                db.execute("DELETE FROM ms_fts WHERE id=?", (ident,))
                db.execute(
                    "INSERT INTO ms_fts(id,sygnatura,sad,fragment,tresc) VALUES (?,?,?,?,?)",
                    (ident, data["sygnatura"], data["sad"], data["fragment"], data["tresc"]),
                )
                saved += 1
        return saved

    def search(self, query: str, *, case_number: bool = False, limit: int = 10) -> list[dict[str, Any]]:
        limit = min(50, max(1, limit))
        with self._connect() as db:
            if case_number:
                rows = db.execute(
                    """SELECT * FROM ms_judgments WHERE lower(sygnatura)=lower(?)
                       ORDER BY data_orzeczenia DESC LIMIT ?""",
                    (query.strip(), limit),
                ).fetchall()
            else:
                tokens = re.findall(r"[^\W_]+", query, flags=re.UNICODE)[:12]
                if not tokens:
                    return []
                match = " AND ".join('"' + token.replace('"', '""') + '"' for token in tokens)
                rows = db.execute(
                    """SELECT j.* FROM ms_fts f JOIN ms_judgments j ON j.id=f.id
                       WHERE ms_fts MATCH ? ORDER BY bm25(ms_fts), j.data_orzeczenia DESC
                       LIMIT ?""",
                    (match, limit),
                ).fetchall()
            return [
                {k: row[k] for k in row.keys() if k != "details_json"}
                | {"has_full_text": bool(row["tresc"])}
                for row in rows
            ]

    def get(self, ident: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM ms_judgments WHERE id=?", (ident,)).fetchone()
            return (
                {k: row[k] for k in row.keys() if k != "details_json"}
                | {"has_full_text": bool(row["tresc"])}
                if row else None
            )

    def count(self) -> int:
        with self._connect() as db:
            return int(db.execute("SELECT count(*) FROM ms_judgments").fetchone()[0])
