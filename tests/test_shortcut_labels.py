"""Guard the jsxs() children bug class.

react/jsx-runtime exports jsxs(type, props, key) — the third argument is the key, not
children. A call shaped jsxs('div', {...}, [a, b]) compiles happily and renders an
element with no children at all, which is how the keyboard-shortcuts sheet shipped
completely blank. This test fails if any such call comes back.
"""

import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHECKER = ROOT / "scripts" / "fix-jsxs-children.py"


class JsxChildrenTest(unittest.TestCase):
    def test_no_children_passed_as_third_argument(self):
        sources = sorted(
            [*ROOT.glob("ui/src/*.jsx"), *ROOT.glob("ui/src/*.js"), *ROOT.glob("ui/src/**/*.js")]
        )
        self.assertTrue(sources, "no UI sources found")
        broken = {}
        for path in sources:
            out = subprocess.run(
                [sys.executable, str(CHECKER), str(path)],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
            count = int(out.split(" repair", 1)[0].strip() or 0)
            if count:
                broken[str(path.relative_to(ROOT))] = out.strip()
        self.assertEqual(
            broken,
            {},
            "jsxs(type, props, key) takes the key third — children must live in props; "
            "these calls would render empty elements:\n" + "\n".join(broken.values()),
        )

    def test_shortcut_labels_follow_the_platform(self):
        plugin = (ROOT / "ui" / "src" / "plugin.js").read_text()
        # A literal ⌘ in a label tells a Windows or Linux user to press a key they do not
        # have; labels must come from the helpers, which read the platform first.
        self.assertNotIn("'⌘", plugin)
        for helper in ("isMacPlatform", "chord(", "newTabKey(", "zoomKey("):
            self.assertIn(helper, plugin)
        # navigator.platform is non-empty everywhere, so the UA fallback below it never
        # runs — the modern hint has to be consulted first.
        self.assertIn("userAgentData", plugin)
        self.assertTrue((ROOT / "ui" / "src" / "platform.js").exists())


if __name__ == "__main__":
    unittest.main()
