"""The hosted build must be installable: manifest, icons and a service worker.

A wrong content type on the manifest, or a worker served with a cacheable header,
breaks "Add to Home Screen" in a way that looks like nothing happened — so these
are assertions, not eyeballing.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("DBDESK_HOME", tempfile.mkdtemp(prefix="dbdesk-pwa-"))
os.environ.setdefault("DBDESK_NO_NOTIFY", "1")

from fastapi.testclient import TestClient  # noqa: E402

import app as server  # noqa: E402

UI = server.UI_DIR


@unittest.skipUnless((UI / "manifest.webmanifest").is_file(), "UI bundle has not been built")
class InstallableBuildTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)

    def test_manifest_is_served_with_its_own_media_type(self):
        response = self.client.get("/manifest.webmanifest")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"].split(";")[0], "application/manifest+json")
        payload = response.json()
        self.assertEqual(payload["name"], "DB Desk")
        self.assertEqual(payload["start_url"], "/")
        sizes = {(icon["sizes"], icon.get("purpose", "any")) for icon in payload["icons"]}
        self.assertIn(("192x192", "any"), sizes)
        self.assertIn(("512x512", "any"), sizes)
        self.assertIn(("512x512", "maskable"), sizes)

    def test_every_icon_the_manifest_names_exists(self):
        manifest = self.client.get("/manifest.webmanifest").json()
        for icon in manifest["icons"]:
            with self.subTest(icon=icon["src"]):
                response = self.client.get(icon["src"])
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["content-type"], "image/png")

    def test_service_worker_is_never_cached(self):
        response = self.client.get("/sw.js")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"].split(";")[0], "application/javascript")
        self.assertEqual(response.headers.get("cache-control"), "no-store")
        self.assertIn("addEventListener('fetch'", response.text)


if __name__ == "__main__":
    unittest.main()
