import { test } from "node:test";
import assert from "node:assert/strict";
import { serveRelease } from "../lib/r2.js";
const data = "abcdefghij";
const meta = {
  size: data.length,
  httpEtag: '"sample"',
  etag: "sample",
  uploaded: new Date(0),
  writeHttpMetadata(h) {
    h.set("Content-Type", "application/octet-stream");
  },
};
const bucket = {
  async head() {
    return meta;
  },
  async get(key, { range } = {}) {
    return {
      ...meta,
      body: range
        ? data.slice(range.offset, range.offset + range.length)
        : data,
    };
  },
};
const asset = "/releases/v3.0.0-current.1/r-shell_aarch64.app.tar.gz";
const hit = (method, path = asset, headers = {}, store = bucket) =>
  serveRelease({
    request: new Request("https://example.org" + path, { method, headers }),
    env: { RELEASES: store },
  });
test("GET, HEAD and conditional GET share metadata", async () => {
  assert.equal(await (await hit("GET")).text(), data);
  const head = await hit("HEAD");
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");
  assert.equal(
    (await hit("GET", asset, { "If-None-Match": 'W/"sample"' })).status,
    304,
  );
});
test("partial reads, suffixes, resumption and range errors", async () => {
  for (const [request, text, range] of [
    ["bytes=3-5", "def", "bytes 3-5/10"],
    ["bytes=7-", "hij", "bytes 7-9/10"],
    ["bytes=-2", "ij", "bytes 8-9/10"],
  ]) {
    const r = await hit("GET", asset, { range: request });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("content-range"), range);
    assert.equal(await r.text(), text);
  }
  assert.equal((await hit("GET", asset, { range: "bytes=12-" })).status, 416);
  assert.equal(
    (await hit("GET", asset, { range: "bytes=2-4", "If-Range": '"old"' }))
      .status,
    200,
  );
});
test("only published paths and read methods are exposed", async () => {
  for (const p of [
    "/updates/secret",
    "/releases/v3.0.0/nested/name",
    "/releases/v3.0.0/r-shell%2Fsecret",
  ])
    assert.equal((await hit("GET", p)).status, 404);
  assert.equal((await hit("PUT")).status, 405);
  assert.equal(
    (await hit("GET", asset, {}, { get: async () => null })).status,
    404,
  );
  assert.match(
    (await hit("GET", "/updates/current.json")).headers.get("cache-control"),
    /no-cache/,
  );
});
