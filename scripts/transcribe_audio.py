#!/usr/bin/env python
"""Run local Whisper transcription and emit one JSON document."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", default="tiny")
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--ffmpeg-path", default="")
    args = parser.parse_args()

    # openai-whisper invokes the ffmpeg executable by name when it loads the
    # WAV file. Keep that subprocess portable when the API uses an explicit
    # FFMPEG_PATH that is not installed globally on PATH.
    if args.ffmpeg_path:
        configured = Path(args.ffmpeg_path)
        ffmpeg_dir = configured if configured.is_dir() else configured.parent
        if ffmpeg_dir and ffmpeg_dir.exists():
            os.environ["PATH"] = str(ffmpeg_dir) + os.pathsep + os.environ.get("PATH", "")

    import whisper

    model = whisper.load_model(args.model)
    result = model.transcribe(args.audio, language=args.language, fp16=False)
    print(json.dumps({"text": str(result.get("text", "")).strip()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
