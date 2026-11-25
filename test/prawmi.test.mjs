import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCaseSignature, lookupPrawMi, CaseSignatureError,
} from "../dist/prawmi.js";

const variants = [
  "II K 123/25", " II_K_123_25 ", "II-K-123-2025", "II\\K\\123\\25",
  "II.K.123.25", "II,K,123,25", "II:K:123:25", "II / K / 123 / 2025",
  "I I K 1 2 3 / 2 5", "I I K 1 2 3 2 0 2 5", "IIK123/2025",
  "IIK12325", "sygn. akt: II K 123/2025", "sygnatura akt II K 123/25",
  "Ⅱ K １２３／２５",
];
for (const input of variants) {
  test("signature equivalent: " + input, () => {
    assert.equal(normalizeCaseSignature(input).slug, "ii-k-123-25");
  });
}

const other = [
  ["III CZP 6/21", "iii-czp-6-21"],
  ["I ACa 772/2013", "i-aca-772-13"],
  ["KIO/UZP 100/12", "kio-uzp-100-12"],
  ["II W 1342/26/N", "ii-w-1342-26-n"],
  ["III SA/Wa 79/24", "iii-sa-wa-79-24"],
  ["I I I C S K 1 2 3 / 2 5", "iii-csk-123-25"],
  ["IV CSK 123/15", "iv-csk-123-15"],
];
for (const [input, slug] of other) {
  test("signature classification: " + input, () => {
    assert.equal(normalizeCaseSignature(input).slug, slug);
  });
}

for (const input of [
  "../../etc/passwd", "https://evil.com/1/25", "II K ../../2025",
  "II K 123/%0a25", "II K", "II K 123/2",
]) {
  test("invalid signature rejected: " + input, () => {
    assert.throws(() => normalizeCaseSignature(input), CaseSignatureError);
  });
}

test("explicit century retained even when PrawMi slug collides", () => {
  const a = normalizeCaseSignature("II K 123/1925");
  const b = normalizeCaseSignature("II K 123/2025");
  assert.equal(a.slug, b.slug);
  assert.equal(a.explicitYear, 1925);
  assert.equal(b.explicitYear, 2025);
});

test("PrawMi adapter gets original four-digit year and verifies source", async () => {
  const previous = process.env.ORZECZENIA_FALLBACK;
  process.env.ORZECZENIA_FALLBACK = "1";
  try {
    let received = "";
    const fakeFetch = async (url) => {
      received = new URL(url).searchParams.get("signature");
      return new Response(JSON.stringify({
        status: "found", source: "prawmi",
        signature: "II K 123/25",
        url: "https://prawmi.pl/orzeczenie/ii-k-123-25",
        court: "Sąd Testowy", judgment_date: "2025-01-31",
        judgment_type: "wyrok",
        text: "Pełna treść orzeczenia pozostaje oddzielona od opracowania. ".repeat(10),
        cached: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const document = await lookupPrawMi("II K 123/2025", fakeFetch);
    assert.equal(received, "II K 123/2025");
    assert.equal(document?.signature, "II K 123/25");
  } finally {
    if (previous === undefined) delete process.env.ORZECZENIA_FALLBACK;
    else process.env.ORZECZENIA_FALLBACK = previous;
  }
});

test("HTTP 404 is distinct from adapter error", async () => {
  const previous = process.env.ORZECZENIA_FALLBACK;
  process.env.ORZECZENIA_FALLBACK = "1";
  try {
    assert.equal(await lookupPrawMi("II K 123/25",
      async () => new Response("", { status: 404 })), null);
    await assert.rejects(() => lookupPrawMi("II K 123/25",
      async () => new Response("", { status: 503 })), CaseSignatureError);
  } finally {
    if (previous === undefined) delete process.env.ORZECZENIA_FALLBACK;
    else process.env.ORZECZENIA_FALLBACK = previous;
  }
});
