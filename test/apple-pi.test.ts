import assert from "node:assert/strict";
import { test } from "node:test";
import { chunks, daysBetween, estTokens, fit, grounded, locate, parseAnswer, parseEntries, stripLeadIn, weekOf } from "../src/lib.ts";

test("estTokens counts digits and symbols as whole tokens", () => {
  assert.equal(estTokens("1234"), 4);
  assert.equal(estTokens("abcdefgh"), 3);
  assert.ok(estTokens("2026-10-03T14:22:09 port 48213") > 20);
});

test("fit keeps short text and cuts long text by tokens", () => {
  assert.equal(fit("abc", 10), "abc");
  const cut = fit("1".repeat(100) + "2".repeat(100), 100);
  assert.ok(estTokens(cut) <= 100 && cut.startsWith("1") && cut.endsWith("2") && cut.includes("chars cut"));
});

test("chunks split on lines under the token budget", () => {
  const cs = chunks(["x".repeat(6), "y".repeat(6), "z".repeat(6)].join("\n"), 6);
  assert.deepEqual(cs, ["xxxxxx\nyyyyyy", "zzzzzz"]);
});

test("parseAnswer reads answer, quotes, and NOT_FOUND", () => {
  assert.equal(parseAnswer("NOT_FOUND"), null);
  const p = parseAnswer('ANSWER: port 48213\nQUOTES:\n- "CANARY port=48213"\nNOT_FOUND');
  assert.equal(p?.answer, "port 48213");
  assert.deepEqual(p?.quotes, ["CANARY port=48213"]);
});

test("locate keeps only real lines and adds true line numbers", () => {
  const file = "alpha\n  ERROR   disk full\ngamma";
  assert.deepEqual(locate(["ERROR disk full", "made up line"], file), ["L2: ERROR   disk full"]);
  assert.deepEqual(locate(["L9: ERROR disk full", "17-gamma"], file), ["L2: ERROR   disk full", "L3: gamma"]);
});

test("stripLeadIn returns the bare payload", () => {
  assert.equal(stripLeadIn("The payload of the QR code is: https://example.com/x."), "https://example.com/x");
  assert.equal(stripLeadIn('The decoded content is: "WIFI:S:home;;"'), "WIFI:S:home;;");
});

test("grounded rejects invented paths, numbers, and identifiers", () => {
  const src = "TOOL CALL: bash {\"command\":\"npm test\"}\nRESULT: 12 passed in src/app.ts";
  assert.ok(grounded("DONE: ran `npm test`, 12 passed in src/app.ts", src).ok);
  const bad = grounded("DONE: fixed src/other.ts, 45 passed, updated parseConfig", src);
  assert.equal(bad.ok, false);
  for (const a of ["45", "parseConfig", "src/other.ts"]) assert.ok(bad.missing.includes(a), a);
});

test("parseEntries splits dated sections", () => {
  const es = parseEntries("## 2026-10-04 10:00 | ~/a\nnote one\n\n## 2026-10-05 09:00 | ~/b\nnote two\n");
  assert.deepEqual(es.map((e) => [e.date, e.body]), [["2026-10-04", "note one"], ["2026-10-05", "note two"]]);
});

test("date helpers", () => {
  assert.equal(weekOf("2026-10-08"), "2026-10-05");
  assert.equal(daysBetween("2026-09-28", "2026-10-05"), 7);
});
