#!/usr/bin/env python3
"""Mirror verified R-Shell releases. CI runs sync before Pages and prune only after public smoke tests."""

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[1]
SITE_ORIGIN = (ROOT / "website/origin.txt").read_text().strip()
MIRROR_ORIGIN = (ROOT / "website/mirror-origin.txt").read_text().strip()
REPO = "GOODBOY008/r-shell"
GH = "https://github.com/" + REPO + "/releases"
BUCKET = "r-shell-releases"
TAG = re.compile(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-current\.([1-9]\d*))?")
ASSET = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
CHANNELS = {"stable": "latest.json", "current": "current.json"}
IMMUTABLE = "public, max-age=31536000, immutable"
TARGETS = {"darwin-aarch64", "linux-x86_64", "windows-x86_64"}
PUBLIC_KEY = (
    base64.b64decode(
        json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["plugins"][
            "updater"
        ]["pubkey"]
    )
    .decode()
    .splitlines()[1]
)


def api(path):
    return json.loads(
        subprocess.check_output(["gh", "api", "repos/" + REPO + "/" + path])
    )


def gh_assets(tag):
    release = api("releases/tags/" + tag)
    if release["draft"] or release["tag_name"] != tag:
        raise ValueError("Expected a published release for " + tag)
    items = release["assets"]
    for a in items:
        if not ASSET.fullmatch(a["name"]) or not re.fullmatch(
            r"sha256:[0-9a-f]{64}", a["digest"] or ""
        ):
            raise ValueError("Unsafe asset name or missing GitHub digest: " + a["name"])
    if not items or len({a["name"] for a in items}) != len(items):
        raise ValueError("Empty or duplicate release assets")
    return items


def semver(tag):
    match = TAG.fullmatch(tag)
    if not match:
        raise ValueError("Unexpected tag: " + tag)
    return tuple(int(n or 0) for n in match.groups())


def channel_of(tag):
    return "current" if semver(tag)[3] else "stable"


def retain(releases, channel, tip):
    return sorted(
        {
            r["tag_name"]
            for r in releases
            if not r["draft"]
            and TAG.fullmatch(r["tag_name"])
            and channel_of(r["tag_name"]) == channel
            and r["prerelease"] == (channel == "current")
            and semver(r["tag_name"]) <= semver(tip)
        },
        key=semver,
        reverse=True,
    )[:2]


def digest(stream):
    h = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        h.update(chunk)
    return h.hexdigest()


def checked_file(path, asset):
    if not path.is_file() or path.stat().st_size != asset["size"]:
        return False
    with path.open("rb") as f:
        return "sha256:" + digest(f) == asset["digest"]


def fetch_asset(asset, folder):
    path = folder / asset["name"]
    if not checked_file(path, asset):
        tmp = path.with_suffix(path.suffix + ".partial")
        subprocess.run(
            [
                "curl",
                "-q",
                "-fsSL",
                "--retry",
                "3",
                "--connect-timeout",
                "15",
                "--max-time",
                "900",
                "-o",
                str(tmp),
                asset["browser_download_url"],
            ],
            check=True,
        )
        if not checked_file(tmp, asset):
            raise ValueError("GitHub digest mismatch: " + path.name)
        tmp.replace(path)
    return path


def client():
    return boto3.client(
        "s3",
        region_name="auto",
        endpoint_url="https://"
        + os.environ["CLOUDFLARE_ACCOUNT_ID"]
        + ".r2.cloudflarestorage.com",
        config=Config(
            retries={"mode": "standard", "max_attempts": 4},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )


def optional_get(s3, key):
    try:
        return s3.get_object(Bucket=BUCKET, Key=key)
    except ClientError as e:
        if e.response["Error"]["Code"] in {"NoSuchKey", "404", "NotFound"}:
            return None
        raise


def json_object(s3, key):
    obj = optional_get(s3, key)
    if obj is None:
        return None, None
    with obj["Body"] as stream:
        return json.load(stream), obj["ETag"]


def put_json(s3, key, value, **condition):
    s3.put_object(
        Bucket=BUCKET,
        Key=key,
        Body=json.dumps(value, ensure_ascii=False).encode(),
        ContentType="application/json",
        CacheControl="no-cache",
        **condition,
    )


def ensure_object(s3, key, path, expected):
    obj = optional_get(s3, key)
    if obj is None:
        with path.open("rb") as f:
            s3.put_object(
                Bucket=BUCKET,
                Key=key,
                Body=f,
                IfNoneMatch="*",
                ContentType=mimetypes.guess_type(path.name)[0]
                or "application/octet-stream",
                CacheControl=IMMUTABLE,
                Metadata={"sha256": expected},
            )
        obj = s3.get_object(Bucket=BUCKET, Key=key)
    with obj["Body"] as stream:
        if obj["ContentLength"] != path.stat().st_size or digest(stream) != expected:
            raise ValueError("Immutable R2 object differs from release: " + key)


def check_signatures(folder, assets, tag):
    signed = {}
    for name in sorted(a["name"] for a in assets if a["name"].endswith(".sig")):
        target = name[:-4]
        encoded = (folder / name).read_text().strip()
        detached = base64.b64decode(encoded, validate=True)
        with tempfile.NamedTemporaryFile() as sig:
            sig.write(detached)
            sig.flush()
            subprocess.run(
                [
                    "minisign",
                    "-Vq",
                    "-P",
                    PUBLIC_KEY,
                    "-m",
                    str(folder / target),
                    "-x",
                    sig.name,
                ],
                check=True,
            )
        versions = [
            field[8:]
            for line in detached.decode().splitlines()
            if line.startswith("trusted comment:")
            for field in line.split("\t")
            if field.startswith("version:")
        ]
        # This published historical channel predates versioned Tauri signatures.
        if versions != [tag[1:]] and not (tag == "v3.0.0-current.1" and not versions):
            raise ValueError("Missing or incorrect signed version for " + name)
        signed[target] = encoded
    return signed


def installer(a):
    name = a["name"]
    ext = name.split(".")[-1]
    if ext not in {"dmg", "exe", "msi", "AppImage", "deb", "rpm"}:
        return None
    if ext == "dmg":
        platform, arch = "macOS", "Apple Silicon" if "aarch64" in name else "Intel"
    elif ext in {"exe", "msi"}:
        platform, arch = "Windows", "x64"
    else:
        platform, arch = "Linux", "x86_64"
    return dict(
        name=name,
        platform=platform,
        arch=arch,
        format=ext if ext == "AppImage" else ext.upper(),
        size=a["size"],
        sha256=a["digest"].split(":")[1],
    )


def mirrored_manifest(original, tag, assets, signed):
    expected = TARGETS | ({"darwin-x86_64"} if channel_of(tag) == "stable" else set())
    if original["version"] != tag[1:] or set(original["platforms"]) != expected:
        raise ValueError("Incomplete or mismatched updater manifest for " + tag)
    platforms = {}
    for target, record in original["platforms"].items():
        name = urlsplit(record["url"]).path.rsplit("/", 1)[-1]
        if (
            record["url"] != GH + "/download/" + tag + "/" + name
            or not signed.get(name)
            or signed[name] != record["signature"]
        ):
            raise ValueError("Package URL or signature mismatch for " + target)
        platforms[target] = dict(record, url=f"{MIRROR_ORIGIN}/releases/{tag}/{name}")
    installs = [i for a in assets if (i := installer(a))]
    ranks = {"macOS": 0, "Windows": 1, "Linux": 2}
    installs.sort(key=lambda i: (ranks[i["platform"]], i["arch"], i["format"]))
    return dict(original, platforms=platforms, installers=installs)


def authority(channel, cache):
    if channel == "stable":
        return api("releases/latest")["tag_name"], None
    # The GitHub 'current' tag is rolling; its packages belong to a real version tag.
    folder = cache / "_current"
    folder.mkdir(exist_ok=True)
    asset = next(a for a in gh_assets("current") if a["name"] == "current.json")
    manifest = json.loads(fetch_asset(asset, folder).read_bytes())
    return "v" + manifest["version"], manifest


def stage(s3, tag, cache, live_manifest, tip):
    folder = cache / tag
    folder.mkdir(exist_ok=True, parents=True)
    assets = gh_assets(tag)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda a: fetch_asset(a, folder), assets))
    signed = check_signatures(folder, assets, tag)
    hashes = {a["name"]: a["digest"].split(":")[1] for a in assets}
    sums = folder / "SHA256SUMS"
    if sums.name not in hashes:
        sums.write_text("".join(f"{hashes[n]}  {n}\n" for n in sorted(hashes)))
        hashes[sums.name] = hashlib.sha256(sums.read_bytes()).hexdigest()
    prefix = "releases/" + tag + "/"
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(
            pool.map(
                lambda n: ensure_object(s3, prefix + n, folder / n, hashes[n]), hashes
            )
        )
    put_json(s3, "_mirror/" + tag + ".json", sorted(hashes))
    print(
        f"Verified {tag}: {len(assets)} release objects, {len(signed)} signatures",
        flush=True,
    )
    if tag == tip:
        original = live_manifest or json.loads((folder / "latest.json").read_bytes())
        return mirrored_manifest(original, tag, assets, signed)
    return None


def promote(s3, channel, manifest):
    key = "updates/" + CHANNELS[channel]
    old, etag = json_object(s3, key)
    if old == manifest:
        return
    if old and semver("v" + old["version"]) > semver("v" + manifest["version"]):
        raise ValueError("Refusing to roll back " + channel)
    put_json(s3, key, manifest, **({"IfMatch": etag} if etag else {"IfNoneMatch": "*"}))
    confirmed, _ = json_object(s3, key)
    if confirmed != manifest:
        raise ValueError("Promoted catalog readback differs: " + channel)


def managed(s3):
    for page in s3.get_paginator("list_objects_v2").paginate(
        Bucket=BUCKET, Prefix="_mirror/"
    ):
        for entry in page.get("Contents", []):
            key = entry["Key"]
            tag = key.removeprefix("_mirror/").removesuffix(".json")
            if key == "_mirror/" + tag + ".json" and TAG.fullmatch(tag):
                yield tag


def prune(s3, keep):
    for tag in sorted(set(managed(s3)) - set(keep)):
        receipt = "_mirror/" + tag + ".json"
        names, _ = json_object(s3, receipt)
        if not names or not all(ASSET.fullmatch(n) for n in names):
            raise ValueError("Invalid mirror receipt for " + tag)
        for n in names:
            s3.delete_object(Bucket=BUCKET, Key="releases/" + tag + "/" + n)
        s3.delete_object(Bucket=BUCKET, Key=receipt)
        print("Expired " + tag)


def uses_mirror_origin(catalog):
    if not catalog or not catalog.get("platforms"):
        return False
    prefix = f"{MIRROR_ORIGIN}/releases/v{catalog['version']}/"
    return all(p["url"].startswith(prefix) for p in catalog["platforms"].values())


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=["sync", "catalog", "prune"])
    p.add_argument("--cache", type=Path, required=True)
    p.add_argument("--catalog", type=Path, required=True)
    p.add_argument(
        "--tag",
        help="Verify a retained version explicitly; older tags can never advance channels",
    )
    args = p.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    s3 = client()
    if args.action == "catalog":
        catalogs = {
            ch: json_object(s3, "updates/" + name)[0] for ch, name in CHANNELS.items()
        }
        if all(uses_mirror_origin(catalog) for catalog in catalogs.values()):
            args.catalog.parent.mkdir(parents=True, exist_ok=True)
            args.catalog.write_text(json.dumps(catalogs, ensure_ascii=False))
            return
        # Rebuild missing catalogs or migrate package URLs after an origin change.
    pages = json.loads(
        subprocess.check_output(
            [
                "gh",
                "api",
                "--paginate",
                "--slurp",
                "repos/" + REPO + "/releases?per_page=100",
            ]
        )
    )
    releases = [r for page in pages for r in page]
    tips = {ch: authority(ch, args.cache) for ch in CHANNELS}
    retained = {ch: retain(releases, ch, tip) for ch, (tip, _) in tips.items()}
    keep = [t for tags in retained.values() for t in tags]
    if args.tag and args.tag not in keep:
        raise SystemExit("Tag is outside the two retained versions of its channel")
    if args.action == "prune":
        deployed = json.loads(args.catalog.read_text())
        for ch, (tip, _) in tips.items():
            live, _ = json_object(s3, "updates/" + CHANNELS[ch])
            if live != deployed[ch] or live["version"] != tip[1:]:
                raise ValueError("Channel advanced during deployment; skip cleanup")
        prune(s3, keep)
        destination = SITE_ORIGIN + "/download/"
        page = (
            '<!doctype html><html lang="en"><meta charset="utf-8"><title>R-Shell downloads</title>'
            f'<meta http-equiv="refresh" content="0;url={destination}"><a href="{destination}">R-Shell downloads</a></html>'
        )
        s3.put_object(
            Bucket=BUCKET,
            Key="index.html",
            Body=page.encode(),
            ContentType="text/html; charset=utf-8",
            CacheControl="no-cache",
            ContentDisposition="inline",
        )
        return
    catalog = {}
    for ch, (tip, manifest) in tips.items():
        tags = retained[ch]
        if not tags or tags[0] != tip:
            raise ValueError(
                "Published channel disagrees with release inventory: " + ch
            )
        for tag in reversed(tags):
            result = stage(s3, tag, args.cache, manifest, tip)
            if tag == tip:
                catalog[ch] = result
        if authority(ch, args.cache)[0] != tip:
            raise ValueError("Channel changed during synchronization; retry")
        promote(s3, ch, catalog[ch])
    args.catalog.parent.mkdir(parents=True, exist_ok=True)
    args.catalog.write_text(json.dumps(catalog, ensure_ascii=False))


if __name__ == "__main__":
    main()
