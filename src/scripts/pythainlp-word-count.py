"""PyThaiNLP word-count worker for batch and persistent server modes."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unicodedata
from pathlib import Path
from typing import Any

os.environ.setdefault(
    "PYTHAINLP_DATA",
    str(Path(tempfile.gettempdir()) / "conference-api-pythainlp-data"),
)

import pythainlp
from pythainlp.tokenize import word_tokenize


REQUIRED_PYTHAINLP_VERSION = "5.3.4"
SUPPORTED_ENGINE = "newmm"
SUPPORTED_NORMALIZATIONS = {"trim", "nfc"}


def validate_request(value: Any) -> tuple[str, str, list[str]]:
    if not isinstance(value, dict):
        raise ValueError("request must be a JSON object")

    engine = value.get("engine")
    if engine != SUPPORTED_ENGINE:
        raise ValueError(f"engine must be {SUPPORTED_ENGINE}")

    normalization = value.get("normalization")
    if normalization not in SUPPORTED_NORMALIZATIONS:
        raise ValueError("normalization must be trim or nfc")

    texts = value.get("texts")
    if not isinstance(texts, list) or not all(isinstance(text, str) for text in texts):
        raise ValueError("texts must be an array of strings")

    return engine, normalization, texts


def normalize_text(text: str, normalization: str) -> str:
    if normalization == "nfc":
        return unicodedata.normalize("NFC", text).strip()
    return text.strip()


def count_word_like_tokens(text: str, engine: str, normalization: str) -> int:
    value = normalize_text(text, normalization)
    if not value:
        return 0

    tokens = word_tokenize(
        value,
        engine=engine,
        keep_whitespace=False,
        join_broken_num=True,
    )
    return sum(1 for token in tokens if any(character.isalnum() for character in token))


def verify_runtime() -> None:
    if pythainlp.__version__ != REQUIRED_PYTHAINLP_VERSION:
        raise RuntimeError(
            "PyThaiNLP version mismatch: "
            f"expected {REQUIRED_PYTHAINLP_VERSION}, got {pythainlp.__version__}"
        )

def build_response(request: Any) -> dict[str, Any]:
    engine, normalization, texts = validate_request(request)
    counts = [
        count_word_like_tokens(text, engine, normalization)
        for text in texts
    ]
    return {
        "engine": engine,
        "normalization": normalization,
        "counts": counts,
        "runtime": {
            "python": sys.version.split()[0],
            "pythainlp": pythainlp.__version__,
        },
    }


def run_batch() -> None:
    verify_runtime()
    json.dump(build_response(json.load(sys.stdin)), sys.stdout, ensure_ascii=False)


def run_server() -> None:
    verify_runtime()
    for line in sys.stdin:
        if not line.strip():
            continue
        request: Any = None
        try:
            request = json.loads(line)
            request_id = request.get("id") if isinstance(request, dict) else None
            if not isinstance(request_id, int):
                raise ValueError("id must be an integer")
            response = {"id": request_id, **build_response(request)}
        except Exception as error:
            request_id = request.get("id") if isinstance(request, dict) else None
            response = {"id": request_id, "error": str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)


def main() -> int:
    try:
        if len(sys.argv) > 1 and sys.argv[1] == "--server":
            run_server()
        else:
            run_batch()
        return 0
    except Exception as error:  # The CLI boundary must convert failures to diagnostics.
        print(f"PyThaiNLP worker error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
