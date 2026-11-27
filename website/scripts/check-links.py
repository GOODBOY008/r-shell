"""Check the two built handbooks and all their local links, without a network connection."""

from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

dist = Path(__file__).resolve().parents[1] / "dist"
origin = (dist.parent / "origin.txt").read_text().strip()


class Links(HTMLParser):
    def __init__(self, page):
        super().__init__()
        self.page = page

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        for field in ("href", "src"):
            raw = attrs.get(field)
            if not raw or raw.startswith(("#", "data:", "mailto:")):
                continue
            url = urlsplit(urljoin(origin + "/" + self.page, raw))
            if url.netloc != urlsplit(origin).netloc:
                continue
            key = unquote(url.path).lstrip("/")
            if key.startswith(("releases/", "updates/")):
                continue
            path = dist / key
            if not (path.is_file() or (path / "index.html").is_file()):
                raise ValueError(f"{self.page}: broken link {raw}")


english = {p.relative_to(dist / "docs") for p in (dist / "docs").rglob("index.html")}
chinese = {
    p.relative_to(dist / "zh/docs") for p in (dist / "zh/docs").rglob("index.html")
}
assert english == chinese and len(english) >= 10, "Missing handbook translations"
for page in dist.rglob("*.html"):
    Links(str(page.relative_to(dist))).feed(page.read_text())
assert (dist / "pagefind/pagefind.js").is_file()
print(f"Validated {len(english)} paired handbook pages and all local page links.")
