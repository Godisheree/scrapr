import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dec,
  pickChrome,
  normalizeWsUrl,
  normalizeIg,
  extFor,
  toOutput,
  readyToInteract,
  classifyResult,
  waitUntil,
  resolveCommand,
  req,
  reqJson,
} from "../snapinsta.js";

test("resolveCommand: bare URL defaults to info", () => {
  assert.deepEqual(resolveCommand(["https://www.instagram.com/reel/DelnxMyMI-U/"]), {
    cmd: "info",
    raw: "https://www.instagram.com/reel/DelnxMyMI-U/",
  });
  assert.deepEqual(resolveCommand(["http://instagram.com/p/ABC/"]), {
    cmd: "info",
    raw: "http://instagram.com/p/ABC/",
  });
});

test("resolveCommand: explicit subcommand wins", () => {
  assert.deepEqual(resolveCommand(["info", "URL1"]), { cmd: "info", raw: "URL1" });
  assert.deepEqual(resolveCommand(["download", "URL2"]), { cmd: "download", raw: "URL2" });
});

test("resolveCommand: unknown token stays unknown, empty stays null", () => {
  assert.deepEqual(resolveCommand(["bogus"]), { cmd: "bogus", raw: undefined });
  assert.deepEqual(resolveCommand(["bogus", "URL3"]), { cmd: "bogus", raw: "URL3" });
  assert.equal(resolveCommand([]), null);
  assert.equal(resolveCommand(undefined), null);
});

test("dec: decode HTML entities", () => {
  assert.equal(dec("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;"), `a & b <c> "d" 'e'`);
  assert.equal(dec("no entities"), "no entities");
  assert.equal(dec(null), "null");
});

test("pickChrome: return first existing binary or empty", () => {
  const r = pickChrome();
  assert.equal(typeof r, "string");
});

test("normalizeWsUrl: inject port when missing (Host-header bug)", () => {
  assert.equal(
    normalizeWsUrl("ws://127.0.0.1/devtools/browser/abc", 9333),
    "ws://127.0.0.1:9333/devtools/browser/abc",
  );
  assert.equal(
    normalizeWsUrl("ws://127.0.0.1:9999/devtools/browser/abc", 9333),
    "ws://127.0.0.1:9999/devtools/browser/abc",
  );
  assert.equal(normalizeWsUrl("not a url", 9333), "not a url");
});

test("normalizeIg: accept post/reel/reels/tv with locale and query", () => {
  assert.equal(normalizeIg("https://www.instagram.com/p/C2VFqJMtui4/").shortcode, "C2VFqJMtui4");
  assert.equal(normalizeIg("https://www.instagram.com/reel/DelnxMyMI-U/").shortcode, "DelnxMyMI-U");
  assert.equal(normalizeIg("https://instagram.com/reel/DelnxMyMI-U").shortcode, "DelnxMyMI-U");
  assert.equal(normalizeIg("https://www.instagram.com/reels/Abc_123-/?vrfl=NTc4MTIwNjQ2YQ==").shortcode, "Abc_123-");
  assert.equal(normalizeIg("https://www.instagram.com/tv/Cdef-456/").shortcode, "Cdef-456");
  assert.equal(normalizeIg("https://www.instagram.com/id/reel/Xy_12/").shortcode, "Xy_12");
});

test("normalizeIg: reject empty / non-http / non-instagram", () => {
  assert.throws(() => normalizeIg(""), /kosong/);
  assert.throws(() => normalizeIg(null), /kosong/);
  assert.throws(() => normalizeIg("instagram.com/reel/abc"), /http/);
  assert.throws(() => normalizeIg("https://youtube.com/watch?v=x"), /valid/);
  assert.throws(() => normalizeIg("https://www.instagram.com/"), /valid/);
});

test("extFor: map label / path to extension", () => {
  assert.equal(extFor("https://x/get?token=1", "Download Photo 1440x1440"), ".jpg");
  assert.equal(extFor("https://x/get?token=1", "Download Photo"), ".jpg");
  assert.equal(extFor("https://x/a.png", "Download Photo"), ".png");
  assert.equal(extFor("https://x/a.webp", "Download Photo"), ".webp");
  assert.equal(extFor("https://x/video.mp4", "Download Video"), ".mp4");
  assert.equal(extFor("https://dl.snapcdn.app/get?token=1", "Download Video"), "");
  assert.equal(extFor("::::", "Download Video"), "");
});

test("toOutput: dedupe, index, kind, primary", () => {
  const out = toOutput({
    shortcode: "ABC",
    url: "https://www.instagram.com/p/ABC/",
    thumbs: ["https://i.snapcdn.app/photo?token=1"],
    links: [
      { url: "https://dl.snapcdn.app/get?token=1", label: "Download Video" },
      { url: "https://dl.snapcdn.app/get?token=1", label: "Download Video" },
      { url: "https://dl.snapcdn.app/get?token=2", label: "Download Photo 1440x1440" },
    ],
  });
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].index, 0);
  assert.equal(out.items[1].index, 1);
  assert.equal(out.items[0].kind, "video");
  assert.equal(out.items[1].kind, "photo");
  assert.equal(out.primary, "https://dl.snapcdn.app/get?token=1");
  assert.equal(out.thumbnail, "https://i.snapcdn.app/photo?token=1");
});

test("toOutput: empty links yields empty primary", () => {
  const out = toOutput({ shortcode: "X", url: "u", links: [] });
  assert.deepEqual(out.items, []);
  assert.equal(out.primary, "");
  assert.equal(out.thumbnail, "");
});

test("readyToInteract: only when page fully loaded AND handler present", () => {
  const base = { readyState: "complete", hasInput: true, hasButton: true, hasHandler: true };
  assert.equal(readyToInteract(base), true);
  assert.equal(readyToInteract({ ...base, readyState: "loading" }), false);
  assert.equal(readyToInteract({ ...base, readyState: "interactive" }), false);
  assert.equal(readyToInteract({ ...base, hasHandler: false }), false);
  assert.equal(readyToInteract({ ...base, hasInput: false }), false);
  assert.equal(readyToInteract({ ...base, hasButton: false }), false);
  assert.equal(readyToInteract({}), false);
});

test("classifyResult: done / error / wait", () => {
  assert.equal(classifyResult({ ready: true, links: [{ url: "u" }], message: "" }), "done");
  assert.equal(
    classifyResult({ ready: true, links: [], message: "No data found. Please try again!" }),
    "error",
  );
  assert.equal(
    classifyResult({ ready: true, links: [], message: "The authentication token is invalid." }),
    "error",
  );
  assert.equal(classifyResult({ ready: true, links: [], message: "" }), "wait");
  assert.equal(classifyResult({ ready: false, links: [], message: "" }), "wait");
  assert.equal(classifyResult(null), "wait");
  assert.equal(classifyResult(undefined), "wait");
});

test("waitUntil: returns immediately when decided done", async () => {
  const r = await waitUntil(async () => ({ n: 1 }), (s) => (s.n === 1 ? "done" : "wait"), {
    timeoutMs: 1000,
    intervalMs: 1,
    sleepFn: async () => {},
  });
  assert.equal(r.verdict, "done");
  assert.deepEqual(r.snap, { n: 1 });
});

test("waitUntil: polls until ready and stops", async () => {
  let calls = 0;
  const r = await waitUntil(
    async () => ({ n: ++calls }),
    (s) => (s.n >= 3 ? "done" : "wait"),
    { timeoutMs: 5000, intervalMs: 1, sleepFn: async () => {} },
  );
  assert.equal(r.verdict, "done");
  assert.equal(calls, 3);
});

test("waitUntil: propagates read errors and throws on timeout", async () => {
  await assert.rejects(
    waitUntil(async () => {
      throw new Error("boom");
    }, () => "wait", { timeoutMs: 5000, intervalMs: 1, sleepFn: async () => {} }),
    /boom/,
  );

  await assert.rejects(
    waitUntil(async () => ({ ok: false }), () => "wait", {
      timeoutMs: 20,
      intervalMs: 5,
      sleepFn: async () => new Promise((r) => setTimeout(r, 5)),
      onTimeout: (snap) => new Error(`timeout Custom ${snap.ok}`),
    }),
    /timeout Custom false/,
  );
});

test("req: GET returns status/body (integration via local server)", async () => {
  const { createServer } = await import("node:http");
  const srv = createServer((rq, rs) => {
    if (rq.url === "/redir") {
      rs.writeHead(302, { Location: "/final" });
      rs.end();
      return;
    }
    rs.writeHead(200, { "Content-Type": "text/plain" });
    rs.end("halo dunia");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  const ok = await req(`http://127.0.0.1:${port}/final`);
  assert.equal(ok.status, 200);
  assert.equal(ok.text, "halo dunia");

  const rd = await req(`http://127.0.0.1:${port}/redir`);
  assert.equal(rd.text, "halo dunia");

  await assert.rejects(req(`http://127.0.0.1:${port}/final`, { maxSize: 2 }), /melebihi/);
  await assert.rejects(req(`http://127.0.0.1:${port}/redir`, { maxRedirect: 0 }), /redirect/);
  await assert.rejects(req("notaurl"), /tidak valid/);

  srv.close();
});

test("req: sets Content-Length on POST body", async () => {
  const { createServer } = await import("node:http");
  let seenLen = null;
  const srv = createServer((rq, rs) => {
    seenLen = rq.headers["content-length"];
    rs.writeHead(200);
    rs.end("ok");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await req(`http://127.0.0.1:${port}/x`, { method: "POST", body: "a=1" });
  assert.equal(seenLen, "3");
  srv.close();
});

test("reqJson: json null on non-JSON body", async () => {
  const { createServer } = await import("node:http");
  const srv = createServer((rq, rs) => {
    rs.writeHead(200);
    rs.end("<html>no</html>");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const r = await reqJson(`http://127.0.0.1:${port}/`);
  assert.equal(r.status, 200);
  assert.equal(r.json, null);
  srv.close();
});
