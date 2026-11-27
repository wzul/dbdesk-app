"""Wire-protocol engine families.

Redshift, CockroachDB and Greenplum speak the PostgreSQL protocol; SingleStore speaks the
MySQL protocol. They are names with defaults, not new code paths — which is exactly why
they break quietly: a port table lookup that misses the kind raises KeyError, and a
default that overrides a stored port sends the connection to 5439 instead of the port the
user typed.
"""

import pathlib
import re
import unittest

import dbdesk_api as api

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = (ROOT / "backend" / "dbdesk_api.py").read_text()


class FamilyTest(unittest.TestCase):
    def test_new_kinds_are_known(self):
        for kind in ("redshift", "cockroachdb", "greenplum", "singlestore"):
            self.assertIn(kind, api.KINDS)
        self.assertIn("redshift", api.PG_KINDS)
        self.assertIn("greenplum", api.PG_KINDS)
        self.assertIn("singlestore", api.MY_KINDS)
        self.assertNotIn("singlestore", api.PG_KINDS)

    def test_default_ports(self):
        self.assertEqual(api.default_port("redshift"), 5439)
        self.assertEqual(api.default_port("cockroachdb"), 26257)
        self.assertEqual(api.default_port("greenplum"), 5432)
        self.assertEqual(api.default_port("singlestore"), 3306)
        self.assertEqual(api.default_port("mongodb"), 27017)
        # unknown kinds fall back rather than raising, so a new name never 500s a save
        self.assertEqual(api.default_port("duckdb"), 5432)

    def test_every_kind_has_a_default_port_or_is_portless(self):
        portless = {"mcp", "http", "sqlite", "duckdb"}
        for kind in api.KINDS - portless:
            self.assertIn(kind, api.DEFAULT_PORTS, f"{kind} would KeyError on save")

    def test_stored_port_wins_over_the_default(self):
        # A bare default_port(kind) in a connection path silently overrides the port the
        # user typed; every call site has to read the connection first.
        bare = [
            line.strip()
            for line in SOURCE.splitlines()
            if "default_port(kind)" in line
            and 'conn.get("port")' not in line
            and "def default_port" not in line
        ]
        self.assertEqual(bare, [], "default_port(kind) without honouring the stored port")

    def test_single_store_routes_through_mysql(self):
        # 21 branches compared the kind to "mysql" literally; SingleStore has to be in
        # every one of them or it silently falls through to the PostgreSQL path.
        self.assertNotRegex(
            SOURCE,
            r'kind == "mysql"',
            'compare with MY_KINDS, not the literal "mysql"',
        )
        self.assertIn("kind in MY_KINDS", SOURCE)

    def test_kind_falls_back_without_losing_new_names(self):
        self.assertEqual(api._kind({"kind": "redshift"}), "redshift")
        self.assertEqual(api._kind({"kind": "singlestore"}), "singlestore")
        self.assertEqual(api._kind({"kind": "nonsense"}), "postgres")
        self.assertEqual(api._kind({}), "postgres")


if __name__ == "__main__":
    unittest.main()
