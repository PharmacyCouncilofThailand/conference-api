import json
import subprocess
import sys
import unittest
from pathlib import Path


WORKER_PATH = Path(__file__).with_name("pythainlp-word-count.py")


def run_worker(payload: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(WORKER_PATH)],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )


class PyThaiNlpWordCountWorkerTests(unittest.TestCase):
    def test_counts_word_like_tokens_in_one_newmm_batch(self) -> None:
        result = run_worker(
            {
                "engine": "newmm",
                "normalization": "trim",
                "texts": [
                    "โอเคบ่พวกเรารักภาษาบ้านเกิด",
                    "alpha beta 42 % !!!",
                    "   ",
                ],
            }
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        body = json.loads(result.stdout)
        self.assertEqual(body["engine"], "newmm")
        self.assertEqual(body["normalization"], "trim")
        self.assertEqual(body["counts"], [6, 3, 0])
        self.assertEqual(body["runtime"]["python"], sys.version.split()[0])
        self.assertEqual(body["runtime"]["pythainlp"], "5.3.4")

    def test_rejects_a_request_without_a_text_array(self) -> None:
        result = run_worker({"engine": "newmm", "normalization": "nfc"})

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("texts must be an array of strings", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_server_mode_handles_multiple_json_line_requests(self) -> None:
        process = subprocess.Popen(
            [sys.executable, str(WORKER_PATH), "--server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        requests = [
            {
                "id": 41,
                "engine": "newmm",
                "normalization": "nfc",
                "texts": ["ภาษาไทย", "alpha beta"],
            },
            {
                "id": 42,
                "engine": "newmm",
                "normalization": "nfc",
                "texts": [""],
            },
        ]
        stdout, stderr = process.communicate(
            "".join(
                json.dumps(request, ensure_ascii=False) + "\n"
                for request in requests
            ),
            timeout=10,
        )

        self.assertEqual(process.returncode, 0, stderr)
        responses = [json.loads(line) for line in stdout.splitlines()]
        self.assertEqual([response["id"] for response in responses], [41, 42])
        self.assertEqual(responses[0]["counts"], [1, 2])
        self.assertEqual(responses[1]["counts"], [0])


if __name__ == "__main__":
    unittest.main()
