import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const origin = (
  await readFile(new URL("../origin.txt", import.meta.url), "utf8")
).trim();
const catalogs = JSON.parse(await readFile(process.argv[2], "utf8"));
async function get(path, options) {
  const response = await fetch(origin + path, {
    ...options,
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, path + " returned " + response.status);
  return response;
}
async function smoke() {
  for (const prefix of ["", "/zh"]) {
    const home = await (await get(prefix + "/")).text();
    assert.ok(
      home.includes("github.com/GOODBOY008/r-shell") &&
        home.includes(prefix + "/download/"),
    );
    await get(prefix + "/docs/", { method: "HEAD" });
    const download = await (await get(prefix + "/download/")).text();
    for (const c of Object.values(catalogs))
      for (const a of c.installers) {
        assert.ok(
          download.includes("/releases/v" + c.version + "/" + a.name) &&
            download.includes(
              "/releases/download/v" + c.version + "/" + a.name,
            ),
        );
        assert.ok(download.includes(a.sha256));
      }
  }
  await get("/pagefind/pagefind.js", { method: "HEAD" });
  for (const [channel, catalog] of Object.entries(catalogs)) {
    const live = await (
      await get(
        channel === "stable" ? "/updates/latest.json" : "/updates/current.json",
      )
    ).json();
    assert.deepEqual(live, catalog);
    for (const a of catalog.installers) {
      const path = "/releases/v" + catalog.version + "/" + a.name;
      const head = await get(path, { method: "HEAD" });
      assert.equal(Number(head.headers.get("content-length")), a.size);
      const part = await get(path, { headers: { Range: "bytes=1024-1055" } });
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
