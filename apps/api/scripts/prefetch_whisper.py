#!/usr/bin/env python3
"""预下载 faster-whisper 模型，避免首次转写时才从 Hugging Face 拉取超时。"""

from __future__ import annotations

import os
import sys
from pathlib import Path

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from app.modules.sources.asr import configure_hf_hub, load_whisper_model, whisper_download_root  # noqa: E402


def main() -> int:
    size = (os.environ.get("KONGKU_ASR_LOCAL_MODEL") or "base").strip() or "base"
    root = whisper_download_root()
    print(f"预下载 Whisper 模型：{size}")
    print(f"保存目录：{root}")
    configure_hf_hub()
    load_whisper_model(size)
    print("Whisper 模型已就绪。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
