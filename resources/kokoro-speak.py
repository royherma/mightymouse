"""
Kokoro TTS with word timestamps.

Replaces the `mlx_audio.tts.generate` CLI for the Kokoro rung. Same WAV out, but
the CLI throws away the per-word alignment the model already computed: its
KokoroPipeline stamps every token with start_ts/end_ts (pipeline.py's
join_timestamps), and generate.py never reads them back. Calling the pipeline
directly is the only way to keep them.

Contract with tts.ts's speakWithKokoro():
  argv: <repo_id> <voice> <lang_code> <out_wav_path>, text on stdin
  stdout: one JSON object — {"words": [{"w","s","e"}, ...]}
  exit 0 only if the WAV was written; any failure exits non-zero and tts.ts
  falls down the ladder to `say`.

Nothing but that JSON may reach stdout — mlx/HF chatter goes to stderr.
"""

import contextlib
import json
import sys
import wave


def main() -> int:
    if len(sys.argv) != 5:
        print("usage: kokoro-speak.py <repo_id> <voice> <lang_code> <out.wav>", file=sys.stderr)
        return 2
    repo_id, voice, lang_code, out_path = sys.argv[1:5]
    text = sys.stdin.read().strip()
    if not text:
        return 3

    # Imports live here, not at module scope: they pull in mlx + torch and print
    # progress bars, so they must happen inside the stdout guard below.
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        from mlx_audio.tts.models.kokoro import KokoroPipeline
        from mlx_audio.tts.utils import load_model

        model = load_model(repo_id)
        pipeline = KokoroPipeline(lang_code=lang_code, model=model, repo_id=repo_id)

        chunks: list = []
        words: list = []
        # The pipeline splits long text into segments, each with its own audio and
        # its own timestamps rebased to that segment's zero. Offsetting by the
        # audio emitted so far is what makes the timeline continuous.
        elapsed = 0.0
        for result in pipeline(text, voice=voice, speed=1.0):
            if result.audio is None:
                continue
            samples = np.asarray(result.audio).reshape(-1)
            for token in result.tokens or []:
                word = (token.text or "").strip()
                # Punctuation is its own token (". " between sentences). Keeping
                # it would highlight the pause between two words as if it were a
                # word — so anything with no alphanumeric in it is dropped.
                if token.start_ts is None or token.end_ts is None:
                    continue
                if not any(c.isalnum() for c in word):
                    continue
                words.append(
                    {"w": word, "s": elapsed + token.start_ts, "e": elapsed + token.end_ts}
                )
            chunks.append(samples)
            elapsed += len(samples) / SAMPLE_RATE

        if not chunks:
            return 4
        # stdlib `wave` rather than soundfile: the mlx-audio venv doesn't ship
        # soundfile, and 16-bit PCM is what the `say` rung already hands the
        # renderer. Clipped before the int16 cast — a float slightly over 1.0
        # wraps to full-scale negative and audibly clicks.
        pcm = np.clip(np.concatenate(chunks), -1.0, 1.0)
        with wave.open(out_path, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes((pcm * 32767).astype("<i2").tobytes())

    json.dump({"words": words}, sys.stdout)
    return 0


SAMPLE_RATE = 24000


if __name__ == "__main__":
    sys.exit(main())
