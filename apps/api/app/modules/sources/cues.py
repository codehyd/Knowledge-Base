"""带时间轴的文案片段（跟读高亮用）。"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass
class TimedCue:
    start: float  # 秒
    end: float
    text: str

    def to_dict(self) -> dict:
        return {
            "start": round(float(self.start), 3),
            "end": round(float(self.end), 3),
            "text": self.text,
        }


def cues_to_text(cues: list[TimedCue]) -> str:
    return "\n".join(c.text for c in cues if (c.text or "").strip()).strip()


def write_cues_file(path: Path, cues: list[TimedCue]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": 1, "cues": [c.to_dict() for c in cues]}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def read_cues_file(path: Path) -> list[TimedCue]:
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    items = data.get("cues") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    out: list[TimedCue] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        try:
            start = float(item.get("start") or 0)
            end = float(item.get("end") or start)
        except (TypeError, ValueError):
            continue
        if end < start:
            end = start
        out.append(TimedCue(start=start, end=end, text=text))
    return out


_TS_RE = re.compile(
    r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})"
)


def _ts_to_seconds(h: str | None, m: str, s: str, ms: str) -> float:
    hours = int(h or 0)
    mins = int(m)
    secs = int(s)
    frac = ms.ljust(3, "0")[:3]
    return hours * 3600 + mins * 60 + secs + int(frac) / 1000.0


def parse_subtitle_cues(raw: str) -> list[TimedCue]:
    """从 VTT/SRT 原文解析时间轴片段。"""
    cues: list[TimedCue] = []
    blocks = re.split(r"\n\s*\n", (raw or "").replace("\r\n", "\n"))
    for block in blocks:
        lines = [ln.strip() for ln in block.split("\n") if ln.strip()]
        if not lines:
            continue
        ts_line = next((ln for ln in lines if "-->" in ln), None)
        if not ts_line:
            continue
        m = _TS_RE.search(ts_line)
        if not m:
            continue
        start = _ts_to_seconds(m.group(1), m.group(2), m.group(3), m.group(4))
        end = _ts_to_seconds(m.group(5), m.group(6), m.group(7), m.group(8))
        text_lines: list[str] = []
        after_ts = False
        for ln in lines:
            if "-->" in ln:
                after_ts = True
                continue
            if not after_ts:
                continue
            if ln.isdigit() or ln.upper().startswith("WEBVTT"):
                continue
            cleaned = re.sub(r"<[^>]+>", "", ln).strip()
            if cleaned:
                text_lines.append(cleaned)
        text = " ".join(text_lines).strip()
        if text:
            cues.append(TimedCue(start=start, end=end, text=text))
    return cues


def find_media_file(folder: Path) -> Path | None:
    """uploads/{id}/ 下可播放音轨。"""
    for name in ("media.m4a", "media.mp3", "media.webm", "media.opus", "media.ogg"):
        p = folder / name
        if p.is_file() and p.stat().st_size > 0:
            return p
    audio_dir = folder / "audio"
    if audio_dir.is_dir():
        files = sorted(
            [p for p in audio_dir.glob("audio.*") if p.is_file() and p.stat().st_size > 0],
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if files:
            return files[0]
    return None


def persist_media_copy(src: Path, folder: Path) -> Path | None:
    """把音轨拷成 uploads/{id}/media.<ext>，便于稳定播放。"""
    if not src.is_file():
        return None
    folder.mkdir(parents=True, exist_ok=True)
    ext = src.suffix.lower() or ".m4a"
    if ext not in {".m4a", ".mp3", ".webm", ".opus", ".ogg", ".wav", ".aac"}:
        ext = ".m4a"
    dest = folder / f"media{ext}"
    if src.resolve() != dest.resolve():
        dest.write_bytes(src.read_bytes())
    return dest
