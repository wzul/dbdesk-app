"""MongoDB and Redis smoke tests with in-memory servers (no network)."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("DBDESK_HOME", tempfile.mkdtemp(prefix="dbdesk-nosql-"))
os.environ.setdefault("DBDESK_NO_NOTIFY", "1")

from fastapi.testclient import TestClient  # noqa: E402

import app as standalone  # noqa: E402
import dbdesk_api  # noqa: E402

try:
    import mongomock  # noqa: E402
except ImportError:  # pragma: no cover
    mongomock = None

try:
    import fakeredis  # noqa: E402
except ImportError:  # pragma: no cover
    fakeredis = None


@unittest.skipIf(mongomock is None, "mongomock is not installed")
class MongoDBTests(unittest.TestCase):
    def setUp(self) -> None:
        dbdesk_api._save([])
        self.client = TestClient(standalone.app)
        self.server = mongomock.MongoClient()
        self.server.demo.users.insert_many(
            [
                {"name": "Ali", "age": 30, "tags": ["a"]},
                {"name": "Siti", "age": 25},
            ]
        )
        self.original = dbdesk_api._mongo_client
        dbdesk_api._mongo_client = lambda conn: self.server
        response = self.client.post(
            "/api/connections",
            json={
                "kind": "mongodb",
                "name": "mongo-test",
                "dbname": "demo",
                "host": "127.0.0.1",
                "port": 27017,
                "readonly": False,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.cid = response.json()["connection"]["id"]

    def tearDown(self) -> None:
        dbdesk_api._mongo_client = self.original
        dbdesk_api._save([])

    def test_tree_columns_rows(self) -> None:
        tree = self.client.get(f"/api/connections/{self.cid}/tree").json()
        names = [table["name"] for schema in tree["schemas"] for table in schema["tables"]]
        self.assertIn("users", names)

        columns = self.client.get(
            f"/api/connections/{self.cid}/columns",
            params={"schema": "demo", "table": "users"},
        ).json()
        self.assertEqual(columns["columns"][0]["name"], "_id")
        self.assertTrue(columns["columns"][0]["pk"])

        result = self.client.post(
            "/api/table/rows",
            json={
                "connection_id": self.cid,
                "schema": "demo",
                "table": "users",
                "order_by": "age",
                "order_dir": "asc",
                "limit": 10,
            },
        )
        self.assertEqual(result.status_code, 200, result.text)
        payload = result.json()
        index = [column["name"] for column in payload["columns"]].index("name")
        self.assertEqual([row[index] for row in payload["rows"]], ["Siti", "Ali"])

    def test_filter_and_json_query(self) -> None:
        result = self.client.post(
            "/api/table/rows",
            json={
                "connection_id": self.cid,
                "schema": "demo",
                "table": "users",
                "filters": [
                    {"mode": "column", "column": "name", "op": "contains", "value": "li", "enabled": True}
                ],
            },
        ).json()
        index = [column["name"] for column in result["columns"]].index("name")
        self.assertEqual([row[index] for row in result["rows"]], ["Ali"])

        query = self.client.post(
            "/api/query",
            json={
                "connection_id": self.cid,
                "sql": json.dumps({"collection": "users", "find": {"age": {"$gt": 26}}}),
            },
        )
        self.assertEqual(query.status_code, 200, query.text)
        payload = query.json()
        index = [column["name"] for column in payload["columns"]].index("name")
        self.assertEqual([row[index] for row in payload["rows"]], ["Ali"])

    def test_writes_and_approval(self) -> None:
        inserted = self.client.post(
            "/api/mongo/docs/insert",
            json={"connection_id": self.cid, "collection": "users", "document": {"name": "Abu", "age": 40}},
        )
        self.assertEqual(inserted.status_code, 200, inserted.text)
        self.assertEqual(self.server.demo.users.count_documents({"name": "Abu"}), 1)

        updated = self.client.post(
            "/api/mongo/docs/update",
            json={
                "connection_id": self.cid,
                "collection": "users",
                "filter": {"name": "Abu"},
                "changes": {"age": 41},
            },
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(self.server.demo.users.find_one({"name": "Abu"})["age"], 41)

        deleted = self.client.post(
            "/api/mongo/docs/delete",
            json={"connection_id": self.cid, "collection": "users", "filter": {"name": "Abu"}},
        )
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(self.server.demo.users.count_documents({"name": "Abu"}), 0)


@unittest.skipIf(fakeredis is None, "fakeredis is not installed")
class RedisTests(unittest.TestCase):
    def setUp(self) -> None:
        dbdesk_api._save([])
        self.client = TestClient(standalone.app)
        self.server = fakeredis.FakeRedis(decode_responses=False)
        self.server.set("user:1", "Ali")
        self.server.hset("user:2", mapping={"name": "Siti"})
        self.server.rpush("list:1", "a", "b")
        self.original = dbdesk_api._redis_client
        dbdesk_api._redis_client = lambda conn, database=None: self.server
        response = self.client.post(
            "/api/connections",
            json={
                "kind": "redis",
                "name": "redis-test",
                "dbname": "0",
                "host": "127.0.0.1",
                "port": 6379,
                "redis_db": 0,
                "readonly": False,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.cid = response.json()["connection"]["id"]

    def tearDown(self) -> None:
        dbdesk_api._redis_client = self.original
        dbdesk_api._save([])

    def test_tree_and_keys(self) -> None:
        tree = self.client.get(f"/api/connections/{self.cid}/tree").json()
        self.assertEqual(tree["schemas"][0]["tables"][0]["name"], "keys")

        rows = self.client.post(
            "/api/table/rows",
            json={"connection_id": self.cid, "schema": "db0", "table": "keys", "limit": 10},
        )
        self.assertEqual(rows.status_code, 200, rows.text)
        keys = [row[0] for row in rows.json()["rows"]]
        self.assertEqual(sorted(keys), ["list:1", "user:1", "user:2"])

    def test_command_console(self) -> None:
        result = self.client.post(
            "/api/query",
            json={"connection_id": self.cid, "sql": "HGETALL user:2"},
        )
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["rows"], [["name", "Siti"]])

        write = self.client.post(
            "/api/redis/command",
            json={"connection_id": self.cid, "command": "SET greeting hello"},
        )
        self.assertEqual(write.status_code, 200, write.text)
        self.assertEqual(self.server.get("greeting"), b"hello")

    def test_readonly_guard(self) -> None:
        readonly = self.client.post(
            "/api/connections",
            json={
                "kind": "redis",
                "name": "redis-readonly",
                "dbname": "1",
                "host": "127.0.0.1",
                "port": 6379,
                "redis_db": 1,
                "readonly": True,
            },
        ).json()["connection"]["id"]
        result = self.client.post(
            "/api/query",
            json={"connection_id": readonly, "sql": "SET nope 1"},
        )
        self.assertEqual(result.status_code, 403, result.text)


if __name__ == "__main__":
    unittest.main()
