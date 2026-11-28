import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "release_mirror", Path(__file__).with_name("release-mirror.py")
)
mirror = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mirror)


class MirrorTests(unittest.TestCase):
    def test_keep_two_per_channel_and_ignore_drafts_beta_rolling_and_newer_tags(self):
        tags = [
            "v3.10.0",
            "v3.9.0",
            "v3.8.0",
            "v3.1.2",
            "v4.0.0-beta.1",
            "current",
            "v4.0.0-current.10",
            "v4.0.0-current.9",
            "v4.0.0-current.2",
        ]
        releases = [
            dict(tag_name=t, draft=False, prerelease="-" in t or t == "current")
            for t in tags
        ]
        releases.append(dict(tag_name="v3.9.1", draft=True, prerelease=False))
        self.assertEqual(
            mirror.retain(releases, "stable", "v3.9.0"), ["v3.9.0", "v3.8.0"]
        )
        self.assertEqual(mirror.retain(releases, "current", tags[-3]), tags[-3:-1])

    @patch.object(mirror, "MIRROR_ORIGIN", "https://downloads.example.org")
    def test_mirror_pins_signatures_version_and_actual_filename(self):
        tag = "v3.0.0-current.1"
        name = "r-shell_aarch64.app.tar.gz"
        record = dict(url=f"{mirror.GH}/download/{tag}/{name}", signature="signed")
        original = dict(
            version=tag[1:], platforms={p: record.copy() for p in mirror.TARGETS}
        )
        data = mirror.mirrored_manifest(original, tag, [], {name: "signed"})
        self.assertEqual(
            data["platforms"]["darwin-aarch64"],
            dict(
                signature="signed",
                url=f"https://downloads.example.org/releases/{tag}/{name}",
            ),
        )
        self.assertEqual(original["platforms"]["darwin-aarch64"], record)
        with self.assertRaises(ValueError):
            mirror.mirrored_manifest(original, tag, [], {name: "replacement"})
        with self.assertRaises(ValueError):
            mirror.mirrored_manifest(original, "v3.0.0-current.2", [], {name: "signed"})
        del original["platforms"]["linux-x86_64"]
        with self.assertRaises(ValueError):
            mirror.mirrored_manifest(original, tag, [], {name: "signed"})

    def test_catalog_with_any_old_package_origin_requires_sync(self):
        base = f"{mirror.MIRROR_ORIGIN}/releases/v3.4.1/"
        platforms = {
            "a": {"url": base + "r-shell-a"},
            "b": {"url": base + "r-shell-b"},
        }
        catalog = {"version": "3.4.1", "platforms": platforms}
        self.assertTrue(mirror.uses_mirror_origin(catalog))
        platforms["a"]["url"] = "https://old.example/releases/v3.4.1/r-shell-a"
        self.assertFalse(mirror.uses_mirror_origin(catalog))
        self.assertFalse(mirror.uses_mirror_origin(None))

    def test_old_run_cannot_overwrite_alias(self):
        with (
            patch.object(
                mirror, "json_object", return_value=({"version": "3.4.1"}, '"abc"')
            ),
            patch.object(mirror, "put_json") as write,
        ):
            with self.assertRaises(ValueError):
                mirror.promote(None, "stable", {"version": "3.4.0"})
            write.assert_not_called()


if __name__ == "__main__":
    unittest.main()
