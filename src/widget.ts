/**
 * Interaktywny widget "Orzeczenia" (MCP Apps, SEP-1865) dla narzedzia show_sources.
 *
 * Serwowany jako zasob ui://saos/judgments (mimeType text/html;profile=mcp-app).
 * Klient obslugujacy MCP Apps renderuje go w sandboxowanym iframe i przekazuje
 * wynik narzedzia (structuredContent.citations) przez postMessage JSON-RPC.
 * Widget nie wykonuje zadnych wywolan sieciowych; cala tresc wstawia przez
 * textContent (brak innerHTML z danych). Klient bez MCP Apps widzi zwykly
 * tekst z content[] - to samo, co zwraca narzedzie.
 */

export const WIDGET_URI = "ui://saos/judgments";
export const WIDGET_MIME = "text/html;profile=mcp-app";

export const WIDGET_HTML = String.raw`<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orzeczenia SAOS</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1f2328; --mut:#656d76; --bd:#d0d7de; --card:#f6f8fa; --acc:#0969da; --ok:#1a7f37; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --mut:#8b949e; --bd:#30363d; --card:#161b22; --acc:#58a6ff; --ok:#3fb950; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:12px 16px; font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:10px; }
  h1 { font-size:15px; margin:0 8px 0 0; font-weight:600; }
  input[type=search], select { font:inherit; padding:5px 8px; border:1px solid var(--bd); border-radius:6px; background:var(--bg); color:var(--fg); }
  input[type=search] { flex:1 1 180px; min-width:140px; }
  .count { color:var(--mut); font-size:12px; margin-left:auto; }
  ul { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
  li { border:1px solid var(--bd); background:var(--card); border-radius:8px; padding:10px 12px; }
  li.cited { border-left:3px solid var(--ok); }
  .top { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:baseline; }
  .sig { font-weight:600; }
  .badge { font-size:11px; padding:1px 7px; border-radius:10px; border:1px solid var(--bd); color:var(--mut); }
  .badge.ok { color:var(--ok); border-color:var(--ok); }
  .meta { color:var(--mut); font-size:12px; margin-top:2px; }
  .snip { margin-top:6px; font-size:13px; }
  .row { margin-top:8px; display:flex; gap:12px; align-items:center; }
  a, button.lnk { color:var(--acc); text-decoration:none; cursor:pointer; background:none; border:0; padding:0; font:inherit; }
  a:hover, button.lnk:hover { text-decoration:underline; }
  .empty, .miss { color:var(--mut); padding:12px 0; }
  .src { color:var(--mut); font-size:11px; margin-top:10px; }
</style>
</head>
<body>
<header>
  <h1>Orzeczenia SAOS</h1>
  <input id="q" type="search" placeholder="Filtruj: sygnatura, sad, tresc" aria-label="Filtr">
  <select id="ct" aria-label="Typ sadu"><option value="">Wszystkie sady</option></select>
  <select id="sort" aria-label="Sortowanie">
    <option value="given">Kolejnosc z odpowiedzi</option>
    <option value="new">Najnowsze</option>
    <option value="old">Najstarsze</option>
  </select>
  <span class="count" id="cnt"></span>
</header>
<ul id="list"></ul>
<div class="miss" id="miss" hidden></div>
<div class="src" id="src"></div>
<script>
(function () {
  var COURT = { COMMON: "Sady powszechne", SUPREME: "Sad Najwyzszy", CONSTITUTIONAL_TRIBUNAL: "Trybunal Konstytucyjny", NATIONAL_APPEAL_CHAMBER: "KIO" };
  var items = [], missing = [], source = "", nextId = 1, pending = {};
  var $ = function (id) { return document.getElementById(id); };

  function send(msg) { window.parent.postMessage(msg, "*"); }
  function request(method, params) {
    var id = nextId++;
    return new Promise(function (res, rej) { pending[id] = { res: res, rej: rej }; send({ jsonrpc: "2.0", id: id, method: method, params: params }); });
  }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params }); }
  function reportSize() {
    notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
  }

  function openLink(url) {
    request("ui/open-link", { url: url }).catch(function () { window.open(url, "_blank", "noopener"); });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function render() {
    var q = $("q").value.trim().toLowerCase(), ct = $("ct").value, sort = $("sort").value;
    var rows = items.filter(function (c) {
      if (ct && c.court_type !== ct) return false;
      if (!q) return true;
      return [c.case_number, c.court, c.title, c.snippet].join(" ").toLowerCase().indexOf(q) >= 0;
    });
    if (sort !== "given") {
      rows = rows.slice().sort(function (a, b) {
        var d = String(a.judgment_date || "").localeCompare(String(b.judgment_date || ""));
        return sort === "new" ? -d : d;
      });
    }
    var ul = $("list");
    ul.textContent = "";
    rows.forEach(function (c) {
      var li = el("li", c.cited ? "cited" : "");
      var top = el("div", "top");
      top.appendChild(el("span", "sig", c.case_number || c.title));
      if (c.cited) top.appendChild(el("span", "badge ok", "zacytowane"));
      if (c.court_type) top.appendChild(el("span", "badge", COURT[c.court_type] || c.court_type));
      if (c.judgment_type) top.appendChild(el("span", "badge", c.judgment_type));
      li.appendChild(top);
      li.appendChild(el("div", "meta", [c.court, c.judgment_date].filter(Boolean).join(" | ")));
      if (c.snippet) li.appendChild(el("div", "snip", c.snippet + (c.snippet.length >= 200 ? "..." : "")));
      var row = el("div", "row");
      var a = el("a", "", "Otworz w SAOS");
      a.href = c.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.addEventListener("click", function (ev) { ev.preventDefault(); openLink(c.url); });
      row.appendChild(a);
      var cp = el("button", "lnk", "Kopiuj sygnature");
      cp.type = "button";
      cp.addEventListener("click", function () {
        var t = c.case_number || c.title;
        (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { cp.textContent = "Skopiowano"; }, function () { cp.textContent = t; });
      });
      row.appendChild(cp);
      li.appendChild(row);
      ul.appendChild(li);
    });
    if (!rows.length) ul.appendChild(el("li", "empty", items.length ? "Brak orzeczen spelniajacych filtr." : "Brak orzeczen do wyswietlenia."));
    $("cnt").textContent = rows.length + " / " + items.length;
    var m = $("miss");
    if (missing.length) { m.hidden = false; m.textContent = "Nie znaleziono w SAOS (ID): " + missing.join(", "); } else { m.hidden = true; }
    $("src").textContent = source ? "Zrodlo danych: " + source + " | saos.org.pl (Fundacja ePanstwo)" : "";
    reportSize();
  }

  function load(result) {
    var sc = (result && result.structuredContent) || {};
    items = Array.isArray(sc.citations) ? sc.citations : [];
    missing = Array.isArray(sc.not_found_ids) ? sc.not_found_ids : [];
    source = sc.source || "";
    var types = {};
    items.forEach(function (c) { if (c.court_type) types[c.court_type] = 1; });
    var sel = $("ct"), cur = sel.value;
    sel.textContent = "";
    var all = el("option", "", "Wszystkie sady"); all.value = ""; sel.appendChild(all);
    Object.keys(types).forEach(function (t) { var o = el("option", "", COURT[t] || t); o.value = t; sel.appendChild(o); });
    sel.value = types[cur] ? cur : "";
    render();
  }

  window.addEventListener("message", function (ev) {
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method && pending[m.id]) {
      var p = pending[m.id]; delete pending[m.id];
      if (m.error) p.rej(m.error); else p.res(m.result);
      return;
    }
    if (m.method === "ui/notifications/tool-result") load(m.params);
  });
  ["q", "ct", "sort"].forEach(function (id) { $(id).addEventListener("input", render); });

  render();
  request("ui/initialize", {
    protocolVersion: "2025-06-18",
    appInfo: { name: "saos-judgments", version: "1.0.0" },
    appCapabilities: {}
  }).then(function () { notify("ui/notifications/initialized", {}); }, function () {});
})();
</script>
</body>
</html>`;
