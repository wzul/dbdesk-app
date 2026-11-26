"""The Windows-on-ARM crypto fallback has to be byte-compatible with `cryptography`.

A vault written on a laptop must open on a Windows ARM machine and the other way
round, and nothing else in the app knows which library produced the blob. So this
pins the wire format with fixed key/nonce/AAD rather than only round-tripping.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from dbdesk_api import _aesgcm_from_pycryptodome  # noqa: E402

try:  # the reference implementation
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM as Reference
except Exception:  # pragma: no cover
    Reference = None

Fallback = _aesgcm_from_pycryptodome()

KEY = bytes(range(32))
NONCE = bytes(range(100, 112))
AAD = b"dbdesk"
SECRET = "postgres://user:pass@db.internal:5432/app".encode()


@unittest.skipUnless(Fallback is not None, "pycryptodome is not installed")
class PycryptodomeFallbackTest(unittest.TestCase):
    def test_round_trip(self):
        blob = Fallback(KEY).encrypt(NONCE, SECRET, AAD)
        self.assertEqual(Fallback(KEY).decrypt(NONCE, blob, AAD), SECRET)

    def test_rejects_tampering(self):
        blob = bytearray(Fallback(KEY).encrypt(NONCE, SECRET, AAD))
        blob[-1] ^= 0xFF
        with self.assertRaises(Exception):
            Fallback(KEY).decrypt(NONCE, bytes(blob), AAD)

    @unittest.skipUnless(Reference is not None, "cryptography is not installed")
    def test_matches_cryptography_on_the_wire(self):
        ours = Fallback(KEY).encrypt(NONCE, SECRET, AAD)
        theirs = Reference(KEY).encrypt(NONCE, SECRET, AAD)
        self.assertEqual(ours, theirs, "ciphertext||tag must be byte-identical")
        # and each library opens the other's blob
        self.assertEqual(Reference(KEY).decrypt(NONCE, ours, AAD), SECRET)
        self.assertEqual(Fallback(KEY).decrypt(NONCE, theirs, AAD), SECRET)


if __name__ == "__main__":
    unittest.main()
