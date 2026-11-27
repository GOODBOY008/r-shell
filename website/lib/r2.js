const releasePath =
  /^releases\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-current\.[1-9]\d*)?\/(?:r-shell[\w.-]*|SHA256SUMS|checksums\.txt|latest\.json)$/;
const catalogs = new Set(["updates/latest.json", "updates/current.json"]);
const fail = (status, headers = {}) =>
  new Response(null, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });

function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  const first = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const last = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  if (
    !Number.isSafeInteger(first) ||
    first < 0 ||
    first >= size ||
    last < first
  )
    return null;
  return { offset: first, length: last - first + 1 };
}

function headersFor(object, catalog) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Last-Modified", object.uploaded.toUTCString());
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(object.size));
  headers.set(
    "Cache-Control",
    catalog ? "no-cache, max-age=0" : "public, max-age=31536000, immutable",
  );
  headers.set("X-Content-Type-Options", "nosniff");
  if (catalog) headers.set("Content-Type", "application/json; charset=utf-8");
  return headers;
}

export async function serveRelease({ request, env }) {
  if (!["GET", "HEAD"].includes(request.method))
    return fail(405, { Allow: "GET, HEAD" });
  const key = new URL(request.url).pathname.slice(1);
  const catalog = catalogs.has(key);
  if (!catalog && !releasePath.test(key)) return fail(404);
  const bucket = env.RELEASES;
  const rangeHeader = request.method === "GET" && request.headers.get("Range");
  const noneMatch = request.headers.get("If-None-Match");
  if (request.method === "HEAD" || rangeHeader || noneMatch) {
    const meta = await bucket.head(key);
    if (!meta) return fail(404);
    const headers = headersFor(meta, catalog);
    if (
      noneMatch &&
      noneMatch
        .split(",")
        .some((value) =>
          ["*", meta.httpEtag].includes(value.trim().replace(/^W\//, "")),
        )
    ) {
      headers.delete("Content-Length");
      return new Response(null, { status: 304, headers });
    }
    if (request.method === "HEAD") return new Response(null, { headers });
    const ifRange = request.headers.get("If-Range");
    if (
      rangeHeader &&
      (!ifRange ||
        ifRange === meta.httpEtag ||
        ifRange === meta.uploaded.toUTCString())
    ) {
      const range = byteRange(rangeHeader, meta.size);
      if (!range) return fail(416, { "Content-Range": "bytes */" + meta.size });
      const partial = await bucket.get(key, {
        range,
        onlyIf: { etagMatches: meta.etag },
      });
      if (!partial) return fail(404);
      if ("body" in partial) {
        headers.set("Content-Length", String(range.length));
        headers.set(
          "Content-Range",
          "bytes " +
            range.offset +
            "-" +
            (range.offset + range.length - 1) +
            "/" +
            meta.size,
        );
        return new Response(partial.body, { status: 206, headers });
      }
      // The catalog changed between HEAD and GET. Serve the new complete representation.
    }
  }
  const object = await bucket.get(key);
  return object
    ? new Response(object.body, { headers: headersFor(object, catalog) })
    : fail(404);
}
