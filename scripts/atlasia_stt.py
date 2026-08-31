#!/usr/bin/env python3
import contextlib
import json
import os
import sys


MODEL_ID = os.environ.get("ATLASIA_MODEL", "atlasia/moulsot.v0.3")


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def main():
    if len(sys.argv) != 2:
        fail("Usage: atlasia_stt.py <audio-file>")

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        fail(f"Audio file not found: {audio_path}")

    try:
        from mlx_audio.stt.utils import load
    except Exception as exc:
        fail(
            "mlx-audio is not installed or failed to import. "
            "Run: python3 -m pip install -r requirements-atlasia.txt. "
            f"Original error: {exc}"
        )

    # Some ML libraries log to stdout; keep stdout clean for the JSON response.
    with contextlib.redirect_stdout(sys.stderr):
        model = load(MODEL_ID)
        transcription = model.generate(audio_path)

    text = getattr(transcription, "text", "") or ""
    print(json.dumps({"text": text, "model": MODEL_ID}, ensure_ascii=False))


if __name__ == "__main__":
    main()
