import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const site = (
  await readFile(new URL("../origin.txt", import.meta.url), "utf8")
).trim();
const mirror = (
  await readFile(new URL("../mirror-origin.txt", import.meta.url), "utf8")
).trim();
const github = "https://github.com/GOODBOY008/r-shell/releases/download";
const catalogs = JSON.parse(await readFile(process.argv[2], "utf8"));
async function get(url, options) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, url + " returned " + response.status);
  return response;
}
async function smoke() {
  for (const prefix of ["", "/zh"]) {
    const home = await (await get(site + prefix + "/")).text();
    assert.ok(
      home.includes("github.com/GOODBOY008/r-shell") &&
        home.includes(prefix + "/download/"),
    );
    await get(site + prefix + "/docs/", { method: "HEAD" });
    const download = await (await get(site + prefix + "/download/")).text();
    for (const catalog of Object.values(catalogs)) {
      const base = mirror + "/releases/v" + catalog.version + "/";
      const upstream = github + "/v" + catalog.version + "/";
      assert.ok(download.includes('href="' + base + 'SHA256SUMS"'));
      for (const asset of catalog.installers) {
        assert.ok(download.includes('href="' + base + asset.name + '"'));
        assert.ok(download.includes('href="' + upstream + asset.name + '"'));
        assert.ok(download.includes(asset.sha256));
      }
    }
  }
  await get(site + "/pagefind/pagefind.js", { method: "HEAD" });
  for (const [channel, catalog] of Object.entries(catalogs)) {
    const manifest =
      channel === "stable" ? "/updates/latest.json" : "/updates/current.json";
    const live = await (await get(mirror + manifest)).json();
    assert.deepEqual(live, catalog);
    const base = mirror + "/releases/v" + catalog.version + "/";
    const checksums = (await (await get(base + "SHA256SUMS")).text()).split("\n");
    for (const a of catalog.installers) {
      const url = base + a.name;
      assert.ok(checksums.includes(a.sha256 + "  " + a.name));
      const head = await get(url, { method: "HEAD" });
      assert.equal(Number(head.headers.get("content-length")), a.size);
      const part = await get(url, { headers: { Range: "bytes=1024-1055" } });
      assert.equal(part.status, 206);
      assert.equal(
        part.headers.get("content-range"),
        "bytes 1024-1055/" + a.size,
      );
      assert.equal((await part.arrayBuffer()).byteLength, 32);
    }
  }
}
for (let n = 1; ; n++) {
  try {
    await smoke();
    console.log(
      "Verified both languages, catalogs, download links, search and ranged delivery.",
    );
    break;
  } catch (e) {
    if (n === 8) throw e;
    console.warn(e.message);
    await new Promise((r) => setTimeout(r, 8000));
  }
}
