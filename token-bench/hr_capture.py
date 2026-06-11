"""Capture Headroom's real compression-engine output for one file, byte-exact.

Invokes the documented public ``headroom.compress`` pipeline (CacheAligner ->
ContentRouter -> SmartCrusher/CodeCompressor/Kompress) on the file's exact bytes,
configured generously so Headroom actually compresses the payload rather than
applying its coding-agent defaults (which skip user messages and the last four
turns). Compressed text goes to stdout; metrics go to stderr.

Usage:
    python3 hr_capture.py <path>
"""

from __future__ import annotations

import json
import sys

from headroom import compress


def main() -> int:
    """Compress the file named in argv[1] and write the result to stdout."""
    path = sys.argv[1]
    with open(path, encoding="utf-8") as handle:
        content = handle.read()

    messages = [{"role": "user", "content": content}]
    result = compress(
        messages,
        model="claude-sonnet-4-5-20250929",
        # Be generous: give Headroom every chance to compress this payload.
        compress_user_messages=True,
        compress_system_messages=True,
        protect_recent=0,
        min_tokens_to_compress=200,
    )

    out = result.messages[-1]["content"]
    text = out if isinstance(out, str) else json.dumps(out)
    sys.stdout.write(text)

    sys.stderr.write(
        "transforms={t} before={b} after={a} saved={s} ratio={r:.3f}\n".format(
            t=result.transforms_applied,
            b=result.tokens_before,
            a=result.tokens_after,
            s=result.tokens_saved,
            r=result.compression_ratio,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
