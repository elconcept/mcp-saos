"""Offline acceptance tests: distinguish actual missing data from provider failures."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server
from vendor import orzeczenia_ms as source


class TestMSAdapter(unittest.TestCase):
    def test_tools_have_provenance_and_keep_upstream_warnings(self):
        with patch.object(source, "run", return_value={
            "wyniki": [{"sygnatura": "I ACa 1/24", "url": "https://orzeczenia.ms.gov.pl/details/$N/test"}],
            "uwagi": ["nieprawomocność niepotwierdzona"],
        }):
            result = server.ms_search_by_case("I ACa 1/24", page=1)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["source"], "portal_orzeczen_ms")
        self.assertEqual(result["coverage"], "published_selection_only")
        self.assertEqual(result["result"]["uwagi"], ["nieprawomocność niepotwierdzona"])

    def test_negative_result_is_distinct_from_portal_error(self):
        with patch.object(source, "run", side_effect=source.Empty("brak trafień")):
            missing = server.ms_search("monitoring")
        with patch.object(source, "run", side_effect=source.Unknown("Portal HTTP 400 Błąd danych")):
            broken = server.ms_search("monitoring")
        self.assertEqual(missing["status"], "not_found")
        self.assertEqual(broken["status"], "upstream_error")

    def test_does_not_invent_text_when_portal_fails(self):
        with patch.object(source, "run", side_effect=source.Unknown("Brak pełnej treści")):
            result = server.ms_get_judgment("152010000000503_I_C_002715_2021_Uz_2021-09-29_001")
        self.assertEqual(result["status"], "upstream_error")
        self.assertNotIn("result", result)

    def test_rejects_unsafe_or_invalid_filters_before_request(self):
        for args in [
            lambda: server.ms_search_by_case("", page=1),
            lambda: server.ms_search("test", court_code="123"),
            lambda: server.ms_search("test", date_from="2026-02-31"),
            lambda: server.ms_recent_rss(limit=200),
            lambda: server.ms_search_by_case("I ACa 1/24", page=-1),
        ]:
            with self.subTest(args=args):
                self.assertEqual(args()["status"], "invalid_arg")

    def test_helper_blocks_off_domain_requests(self):
        with self.assertRaises(source.Unknown):
            source.safe_url("http://attacker.example/secret")


if __name__ == "__main__":
    unittest.main()
