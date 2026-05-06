import importlib
import math
import os
import sys
import types
import unittest


def import_worker():
    os.environ.setdefault("JOB_ID", "unit-test")
    os.environ.setdefault("S3_BUCKET", "unit-test-bucket")
    os.environ.setdefault("S3_INPUT_KEY", "translator-jobs/unit-test/input.mp4")
    os.environ.setdefault("DYNAMODB_TABLE", "unit-test-table")
    os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
    os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

    if "boto3" not in sys.modules:
        class DummyTable:
            def update_item(self, **kwargs):
                return None

        class DummyDynamoDb:
            def Table(self, name):
                return DummyTable()

        boto3 = types.ModuleType("boto3")
        boto3.client = lambda *args, **kwargs: object()
        boto3.resource = lambda *args, **kwargs: DummyDynamoDb()
        sys.modules["boto3"] = boto3

    return importlib.import_module("worker")


class WorkerGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = import_worker()

    def test_translation_response_accepts_wrapped_list_and_normalises_ids(self):
        parsed = self.worker._normalise_translation_response(
            {"translations": [{"id": "7", "translated_text": "hello"}]}
        )

        self.assertEqual(parsed[0]["id"], 7)

    def test_translation_response_rejects_invalid_shape(self):
        with self.assertRaisesRegex(RuntimeError, "invalid JSON shape|instead of a translation list"):
            self.worker._normalise_translation_response({"unexpected": "value"})

    def test_speaking_rate_is_clamped_and_non_finite_safe(self):
        self.assertEqual(self.worker._safe_speaking_rate("bad"), 1.0)
        self.assertEqual(self.worker._safe_speaking_rate(math.inf), 1.0)
        self.assertEqual(self.worker._safe_speaking_rate(0.1), 0.9)
        self.assertEqual(self.worker._safe_speaking_rate(9), 1.2)


if __name__ == "__main__":
    unittest.main()
