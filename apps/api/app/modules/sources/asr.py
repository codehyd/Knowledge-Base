"""视频文案：音轨下载 + 云端 / 本地语音转写。

不依赖字幕轨。抖音等站点多数无外挂字幕，需走本模块。
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path


def resolve_ffmpeg() -> str | None:
    env = (os.environ.get("KONGKU_FFMPEG") or "").strip()
    if env and Path(env).is_file():
        return env
    which = shutil.which("ffmpeg")
    if which:
        return which
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and Path(exe).is_file():
            return exe
    except Exception:  # noqa: BLE001
        pass
    return None


def cloud_asr_supported(base_url: str) -> bool:
    low = (base_url or "").lower()
    if not low:
        return False
    if "deepseek" in low:
        return False
    # OpenAI 兼容 /audio/transcriptions 常见可用站
    return any(
        n in low
        for n in (
            "openai.com",
            "siliconflow",
            "azure",
            "groq.com",
            "dashscope",
            "bigmodel.cn",
            "moonshot",
        )
    ) or low.endswith("/v1") or "/compatible-mode" in low


def default_cloud_asr_model(base_url: str) -> str:
    low = (base_url or "").lower()
    if "siliconflow" in low:
        return "FunAudioLLM/SenseVoiceSmall"
    if "groq" in low:
        return "whisper-large-v3"
    return "whisper-1"


def _data_models_dir() -> Path:
    root = Path((os.environ.get("DATA_DIR") or "data").strip() or "data")
    d = root / "models" / "faster-whisper"
    d.mkdir(parents=True, exist_ok=True)
    return d


def download_audio_sync(url: str, work_dir: Path, cookie_file: Path | None = None) -> Path:
    work_dir.mkdir(parents=True, exist_ok=True)
    for old in work_dir.glob("audio.*"):
        try:
            old.unlink()
        except OSError:
            pass

    try:
        import yt_dlp
    except ImportError as exc:
        raise ValueError("未安装 yt-dlp，无法下载视频音轨") from exc

    ffmpeg = resolve_ffmpeg()
    outtmpl = str(work_dir / "audio.%(ext)s")
    opts: dict = {
        # 直接下音轨，避免依赖 ffprobe 做转码后处理
        "format": "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best",
        "outtmpl": outtmpl,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }
    if cookie_file is not None and cookie_file.is_file():
        opts["cookiefile"] = str(cookie_file)
    if ffmpeg:
        # yt-dlp 接受二进制路径或目录；imageio-ffmpeg 无 ffprobe，故不做 ExtractAudio
        opts["ffmpeg_location"] = ffmpeg


    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"下载音轨失败：{str(exc)[-220:]}") from exc

    files = sorted(
        [p for p in work_dir.glob("audio.*") if p.is_file()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not files:
        raise ValueError("音轨下载后未找到文件")
    size = files[0].stat().st_size
    # 云端 Whisper 常见 25MB；本地可更大。此处只拦极端值。
    if size > 120 * 1024 * 1024:
        raise ValueError("媒体文件过大（>120MB），请换较短视频或补贴文案")
    return files[0]


def transcribe_cloud_sync(audio_path: Path, *, base_url: str, api_key: str, model: str) -> str:
    import httpx

    if audio_path.stat().st_size > 24 * 1024 * 1024:
        raise ValueError("音轨超过云端 24MB 限制，请改用本地转写或较短视频")

    base = base_url.rstrip("/")
    key = api_key.strip()
    if not base or not key:
        raise ValueError("云端转写未配置 Base URL / API Key")
    if not cloud_asr_supported(base):
        raise ValueError(
            "当前转写接口疑似不支持语音（如 DeepSeek）。"
            "请在设置「视频语音转写」填写硅基流动 / OpenAI，或改用本地转写。"
        )

    url = f"{base}/audio/transcriptions"
    headers = {"Authorization": f"Bearer {key}"}
    with audio_path.open("rb") as fh:
        files = {"file": (audio_path.name, fh, "application/octet-stream")}
        data = {"model": model or default_cloud_asr_model(base), "response_format": "text"}
        try:
            with httpx.Client(timeout=httpx.Timeout(600.0, connect=30.0)) as client:
                resp = client.post(url, headers=headers, files=files, data=data)
        except httpx.HTTPError as exc:
            raise ValueError(f"云端转写请求失败：{exc}") from exc

    if resp.status_code >= 400:
        detail = (resp.text or "")[:240]
        raise ValueError(f"云端转写返回 {resp.status_code}" + (f"：{detail}" if detail else ""))

    text = (resp.text or "").strip()
    if text.startswith("{"):
        try:
            import json

            text = str(json.loads(text).get("text") or "").strip()
        except Exception:  # noqa: BLE001
            pass
    if len(text) < 8:
        raise ValueError("云端转写结果几乎为空")
    return text


def transcribe_local_sync(audio_path: Path, *, model_size: str = "base") -> str:
    ffmpeg = resolve_ffmpeg()
    if not ffmpeg:
        raise ValueError(
            "本地转写需要 ffmpeg。已尝试内置 imageio-ffmpeg；"
            "若仍失败请安装 ffmpeg 并加入 PATH，或设置 KONGKU_FFMPEG。"
        )
    # faster-whisper / ctranslate2 会找 PATH 里的 ffmpeg
    ff_dir = str(Path(ffmpeg).parent)
    path_env = os.environ.get("PATH") or ""
    if ff_dir not in path_env.split(os.pathsep):
        os.environ["PATH"] = ff_dir + os.pathsep + path_env

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise ValueError(
            "未安装本地转写组件。请在 apps/api 执行："
            "pip install faster-whisper imageio-ffmpeg"
        ) from exc

    size = (model_size or "base").strip() or "base"
    # tiny/base/small/medium/large-v3
    download_root = str(_data_models_dir())
    try:
        model = WhisperModel(
            size,
            device="cpu",
            compute_type="int8",
            download_root=download_root,
        )
        segments, _info = model.transcribe(
            str(audio_path),
            language="zh",
            vad_filter=True,
            beam_size=1,
        )
        parts: list[str] = []
        for seg in segments:
            t = (seg.text or "").strip()
            if t:
                parts.append(t)
        text = "\n".join(parts).strip()
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"本地转写失败：{str(exc)[-240:]}") from exc

    if len(text) < 8:
        raise ValueError("本地转写结果几乎为空")
    try:
        from zhconv import convert

        text = convert(text, "zh-cn")
    except Exception:  # noqa: BLE001
        pass
    return text


def resolve_asr_plan(cfg: dict[str, str]) -> list[tuple[str, dict[str, str]]]:
    """返回 [(engine, params), ...]，engine 为 cloud|local。"""
    mode = (cfg.get("asr_mode") or "auto").strip().lower() or "auto"
    if mode in {"off", "none", "disabled"}:
        return []

    cloud_base = (cfg.get("asr_base_url") or "").strip()
    cloud_key = (cfg.get("asr_api_key") or "").strip()
    chat_base = (cfg.get("chat_base_url") or "").strip()
    chat_key = (cfg.get("chat_api_key") or "").strip()
    cloud_model = (cfg.get("asr_model") or "").strip()
    local_model = (cfg.get("asr_local_model") or "base").strip() or "base"

    # 独立 ASR Key 优先；否则尝试对话 Key（仅当接口支持转写）
    use_base, use_key = cloud_base, cloud_key
    if not use_key and chat_key and cloud_asr_supported(chat_base if not cloud_base else cloud_base):
        use_base = cloud_base or chat_base
        use_key = chat_key
    elif use_key and not use_base:
        use_base = "https://api.siliconflow.cn/v1"

    plan: list[tuple[str, dict[str, str]]] = []
    cloud_ok = bool(use_key and use_base and cloud_asr_supported(use_base))

    if mode == "cloud":
        if cloud_ok:
            plan.append(
                (
                    "cloud",
                    {
                        "base_url": use_base,
                        "api_key": use_key,
                        "model": cloud_model or default_cloud_asr_model(use_base),
                    },
                )
            )
        return plan

    if mode == "local":
        plan.append(("local", {"model_size": local_model}))
        return plan

    # auto：云端（若可用）→ 本地
    if cloud_ok:
        plan.append(
            (
                "cloud",
                {
                    "base_url": use_base,
                    "api_key": use_key,
                    "model": cloud_model or default_cloud_asr_model(use_base),
                },
            )
        )
    plan.append(("local", {"model_size": local_model}))
    return plan


def transcribe_video_audio_sync(
    url: str,
    work_dir: Path,
    cfg: dict[str, str],
    cookie_file: Path | None = None,
) -> str:
    plan = resolve_asr_plan(cfg)
    if not plan:
        raise ValueError(
            "语音转写已关闭。请在设置开启「视频语音转写」，或「补贴文案」。"
        )

    audio = download_audio_sync(url, work_dir, cookie_file=cookie_file)
    errors: list[str] = []
    for engine, params in plan:
        try:
            if engine == "cloud":
                return transcribe_cloud_sync(
                    audio,
                    base_url=params["base_url"],
                    api_key=params["api_key"],
                    model=params.get("model") or "",
                )
            return transcribe_local_sync(audio, model_size=params.get("model_size") or "base")
        except ValueError as exc:
            errors.append(f"{engine}: {exc}")
            continue

    raise ValueError("；".join(errors) if errors else "语音转写失败")
