import test from "node:test";
import assert from "node:assert/strict";
import { TurnState, callerKeyFromHeaders, turnTtlMs } from "../dist/turnstate.js";

const c = (id) => ({ saos_id: id, title: "T" + id });

test("TurnState: records, dedupes by id, keeps recency order", () => {
  const st = new TurnState(1000, () => 0);
  st.record("k", [c(1), c(2)]);
  st.record("k", [c(1), c(3)]);
  assert.deepEqual(st.peek("k").map((x) => x.saos_id), [2, 1, 3]);
});

test("TurnState: isolates callers and ignores null key", () => {
  const st = new TurnState(1000, () => 0);
  st.record("a", [c(1)]);
  st.record(null, [c(9)]);
  assert.deepEqual(st.peek("b"), []);
  assert.deepEqual(st.peek(null), []);
  assert.equal(st.get("a", 1).saos_id, 1);
});

test("TurnState: TTL expiry and clear", () => {
  let t = 0;
  const st = new TurnState(1000, () => t);
  st.record("a", [c(1)]);
  t = 1001;
  assert.deepEqual(st.peek("a"), []);
  st.record("a", [c(2)]);
  st.clear("a");
  assert.deepEqual(st.peek("a"), []);
});

test("TurnState: caps items per key", () => {
  const st = new TurnState(1000, () => 0);
  st.record("a", Array.from({ length: 150 }, (_, i) => c(i + 1)));
  const ids = st.peek("a").map((x) => x.saos_id);
  assert.equal(ids.length, 100);
  assert.equal(ids[0], 51);
});

test("callerKeyFromHeaders: identity precedence, hashing, disabled without identity", () => {
  assert.equal(callerKeyFromHeaders({}, {}), null);
  assert.equal(callerKeyFromHeaders({}, { SAOS_STATE_SHARED: "1" }), "shared");
  const s = callerKeyFromHeaders({ "mcp-session-id": "abc" }, {});
  assert.match(s, /^s:[0-9a-f]{24}$/);
  assert.ok(!s.includes("abc"));
  const u1 = callerKeyFromHeaders({ "cf-access-authenticated-user-email": "A@x.pl" }, {});
  const u2 = callerKeyFromHeaders({ "cf-access-authenticated-user-email": "a@x.pl" }, {});
  assert.equal(u1, u2);
  assert.notEqual(callerKeyFromHeaders({ authorization: "Bearer 1" }, {}), callerKeyFromHeaders({ authorization: "Bearer 2" }, {}));
});

test("turnTtlMs: env override with safe default", () => {
  assert.equal(turnTtlMs({}), 15 * 60 * 1000);
  assert.equal(turnTtlMs({ SAOS_STATE_TTL_S: "60" }), 60000);
  assert.equal(turnTtlMs({ SAOS_STATE_TTL_S: "abc" }), 15 * 60 * 1000);
});
