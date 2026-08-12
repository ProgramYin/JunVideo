#!/usr/bin/env python
"""Run local Whisper transcription and emit one JSON document."""

from __future__ import annotations

import argparse
import json


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", default="tiny")
    parser.add_argument("--language", default="Chinese")
    args = parser.parse_args()

    import whisper

    model = whisper.load_model(args.model)
    result = model.transcribe(args.audio, language=args.language, fp16=False)
    print(json.dumps({"text": str(result.get("text", "")).strip()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
