"""Cloud engines: the parts that can be checked without an account.

These four engines need a real account to prove end to end, so what is pinned here is the
contract that *can* be checked offline: a missing setting produces a message that names the
engine and the field, not a stack trace or a bare 500 — and the read-only guard refuses a write
before any request is signed.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from fastapi import HTTPException  # noqa: E402

import cloud_kinds  # noqa: E402


class CloudEngineContractTest(unittest.TestCase):
    def assertNamedError(self, call, engine, needle):
        with self.assertRaises(HTTPException) as caught:
            call()
        self.assertEqual(caught.exception.status_code, 400, caught.exception.detail)
        detail = str(caught.exception.detail)
        # Every failure has to name the engine first, so a user with four connections open
        # knows which one just failed.
        self.assertTrue(detail.startswith(f"{engine}:"), detail)
        self.assertIn(needle, detail)

    def test_every_cloud_kind_is_registered_with_every_operation(self):
        operations = {"test", "tree", "columns", "rows", "query", "ddl", "indexes"}
        for kind in cloud_kinds.CLOUD_KINDS:
            with self.subTest(kind=kind):
                self.assertIn(kind, cloud_kinds.ENGINES)
                self.assertEqual(set(cloud_kinds.ENGINES[kind]), operations)

    def test_athena_asks_for_an_output_location(self):
        self.assertNamedError(
            lambda: cloud_kinds.athena_test({"kind": "athena", "dbname": "default",
                                             "user": "AKIA", "password": "secret"}),
            "Athena", "output",
        )

    def test_athena_asks_for_a_database(self):
        self.assertNamedError(
            lambda: cloud_kinds.athena_test({"kind": "athena", "options": '{"output": "s3://b/p"}'}),
            "Athena", "database",
        )

    def test_bigquery_asks_for_a_project(self):
        self.assertNamedError(
            lambda: cloud_kinds.bigquery_test({"kind": "bigquery"}), "BigQuery", "project"
        )

    def test_bigquery_asks_for_a_service_account_key(self):
        self.assertNamedError(
            lambda: cloud_kinds.bigquery_test({"kind": "bigquery", "options": '{"project": "p"}'}),
            "BigQuery", "service-account",
        )

    def test_aws_kinds_ask_for_a_key_pair(self):
        options = {
            "athena": '{"region": "ap-southeast-1", "output": "s3://b/p"}',
            "dynamodb": '{"region": "ap-southeast-1"}',
        }
        for kind in ("athena", "dynamodb"):
            with self.subTest(kind=kind):
                self.assertNamedError(
                    lambda kind=kind: cloud_kinds.ENGINES[kind]["query"](
                        {"kind": kind, "options": options[kind]}, "select 1", 10, False,
                    ),
                    cloud_kinds.NAMES[kind], "access key",
                )

    def test_snowflake_says_what_to_install(self):
        # Nothing to connect to, but the message has to say how to fix it if the extra is absent.
        try:
            import snowflake.connector  # noqa: F401
            self.skipTest("the Snowflake connector is installed")
        except ModuleNotFoundError:
            pass
        self.assertNamedError(
            lambda: cloud_kinds.snowflake_test({"kind": "snowflake", "user": "u"}),
            "Snowflake", "snowflake-connector-python",
        )

    def test_options_must_be_json(self):
        self.assertNamedError(
            lambda: cloud_kinds.athena_test({"kind": "athena", "options": "region=eu"}),
            "Athena", "options must be JSON",
        )

    def test_options_must_be_an_object(self):
        self.assertNamedError(
            lambda: cloud_kinds.athena_test({"kind": "athena", "options": '["a"]'}),
            "Athena", "options must be a JSON object",
        )

    def test_read_only_refuses_a_write_before_signing_anything(self):
        for kind in ("athena", "dynamodb", "bigquery", "snowflake"):
            with self.subTest(kind=kind):
                with self.assertRaises(HTTPException) as caught:
                    cloud_kinds.run({"kind": kind, "readonly": True}, ["delete from t"])
                self.assertEqual(caught.exception.status_code, 403)

    def test_sigv4_produces_the_shape_aws_expects(self):
        headers = cloud_kinds._sign_v4(
            {"kind": "athena", "user": "AKIDEXAMPLE", "password": "secret"},
            "athena", "ap-southeast-1", "athena.ap-southeast-1.amazonaws.com",
            target="AmazonAthena.StartQueryExecution", payload=b"{}",
        )
        self.assertTrue(headers["Authorization"].startswith(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/"))
        self.assertIn("/ap-southeast-1/athena/aws4_request", headers["Authorization"])
        self.assertIn("x-amz-target", headers["Authorization"].split("SignedHeaders=")[1].split(",")[0])
        self.assertRegex(headers["x-amz-date"], r"^\d{8}T\d{6}Z$")

    def test_sigv4_is_deterministic_for_the_same_clock_and_payload(self):
        # A signature that changes without the payload changing would fail every AWS request.
        first = cloud_kinds._sign_v4(
            {"kind": "dynamodb", "user": "AKID", "password": "s"},
            "dynamodb", "us-east-1", "dynamodb.us-east-1.amazonaws.com",
            target="DynamoDB_20120810.ListTables", payload=b'{"Limit": 1}',
        )["Authorization"].split("Signature=")[1]
        second = cloud_kinds._sign_v4(
            {"kind": "dynamodb", "user": "AKID", "password": "s"},
            "dynamodb", "us-east-1", "dynamodb.us-east-1.amazonaws.com",
            target="DynamoDB_20120810.ListTables", payload=b'{"Limit": 1}',
        )["Authorization"].split("Signature=")[1]
        self.assertEqual(first, second)

    def test_dynamo_attributes_are_untagged(self):
        item = {
            "id": {"S": "abc"},
            "count": {"N": "7"},
            "live": {"BOOL": True},
            "nothing": {"NULL": True},
            "tags": {"L": [{"S": "a"}, {"S": "b"}]},
            "meta": {"M": {"k": {"S": "v"}}},
        }
        self.assertEqual(
            cloud_kinds._dynamo(item),
            {"id": "abc", "count": "7", "live": True, "nothing": None,
             "tags": ["a", "b"], "meta": {"k": "v"}},
        )


if __name__ == "__main__":
    unittest.main()
