"""MS portal discovery-cache persistence; fully offline, never touches SAOS DB."""
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server
from ms_cache import MsCache
from vendor import orzeczenia_ms as portal


_ID = "152010000000503_I_C_002715_2021_Uz_2021-09-29_001"


class TestMSCache(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.cache = MsCache(str(Path(self.temp.name) / "ms-discovered.sqlite"))
        self.cache_patch = patch.object(server, "_cache", self.cache)
        self.cache_patch.start()

    def tearDown(self):
        self.cache_patch.stop()
        self.temp.cleanup()

    def sample(self, **fields):
        return dict(
            id=_ID,
            sygnatura="I C 2715/21",
            sad="Sąd Okręgowy w Krakowie",
            typ="wyrok z uzasadnieniem",
            data_orzeczenia="2021-09-29",
            data_publikacji="2024-08-22",
            url="https://orzeczenia.ms.gov.pl/details/$N/" + _ID,
            fragment="odpowiedzialność cywilna",
            **fields,
        )

    def test_cache_remains_separate_and_reusable(self):
        self.assertEqual(self.cache.upsert([self.sample()]), 1)
        self.assertEqual(self.cache.count(), 1)
        self.assertEqual(len(self.cache.search("odpowiedzialnosc cywilna")), 1)
        self.assertEqual(len(self.cache.search("I C 2715/21", case_number=True)), 1)
        self.assertEqual(self.cache.search("no-such-phrase"), [])
        self.assertFalse(self.cache.get(_ID)["has_full_text"])

    def test_partial_update_does_not_discard_verified_full_text(self):
        self.cache.upsert([self.sample(tresc="Pelny tekst orzeczenia 2021.")])
        self.cache.upsert([self.sample(fragment="nowy fragment")])
        saved = self.cache.get(_ID)
        self.assertEqual(saved["tresc"], "Pelny tekst orzeczenia 2021.")
        self.assertEqual(saved["fragment"], "nowy fragment")
        self.assertTrue(saved["has_full_text"])

    def test_live_ms_search_writes_local_discovery(self):
        with patch.object(portal, "run", return_value={"wyniki": [self.sample()], "uwagi": ["source may be incomplete"]}):
            found = server.ms_search_by_case("I C 2715/21")
        self.assertEqual(found["cached_records"], 1)
        local = server.ms_search_cached("I C 2715/21", case_number=True)
        self.assertEqual(local["status"], "ok")
        self.assertEqual(local["count"], 1)
        self.assertEqual(local["results"][0]["id"], _ID)

    def test_failed_source_does_not_create_citation_or_cache_record(self):
        with patch.object(portal, "run", side_effect=portal.Unknown("HTTP 400 Błąd danych")):
            found = server.ms_search_by_case("I C 2715/21")
        self.assertEqual(found["status"], "upstream_error")
        self.assertEqual(self.cache.count(), 0)

    def test_id_and_source_url_are_required_for_store(self):
        self.assertEqual(self.cache.upsert([
            {"id": "", "url": "https://orzeczenia.ms.gov.pl/details/other"},
            {"id": "123", "url": "https://other.invalid/"},
        ]), 0)
        self.assertEqual(self.cache.count(), 0)


if __name__ == "__main__":
    unittest.main()
