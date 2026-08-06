"""视频文案：音轨下载 + 云端 / 本地语音转写。

不依赖字幕轨。抖音等站点多数无外挂字幕，需走本模块。
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
from pathlib import Path

# 已是音轨 / 需抽轨的视频容器
_AUDIO_SUFFIX = {".m4a", ".mp3", ".wav", ".aac", ".ogg", ".opus", ".flac", ".wma"}
_MEDIA_SUFFIX = _AUDIO_SUFFIX | {".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi"}

logger = logging.getLogger(__name__)

# 进程内复用 Whisper，避免合集每集重新加载模型
_whisper_lock = threading.Lock()
# 本地推理互斥：多路抽取可并行下载/拉字幕，但 Whisper 同时只跑 1 路（最安全）
_whisper_infer_lock = threading.Lock()
_whisper_cache: dict[tuple[str, str, str], object] = {}


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


HF_MIRROR = "https://hf-mirror.com"


def whisper_download_root() -> Path:
    root = Path((os.environ.get("DATA_DIR") or "data").strip() or "data")
    d = root / "models" / "faster-whisper"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _data_models_dir() -> Path:
    return whisper_download_root()


def configure_hf_hub(*, prefer_mirror: bool = False) -> None:
    """拉长 Hugging Face 超时；模型缓存落在 DATA_DIR 下，便于桌面端与开发一致。"""
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "600")
    os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "120")

    data_root = Path((os.environ.get("DATA_DIR") or "data").strip() or "data")
    hf_home = data_root / "huggingface"
    hf_home.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(hf_home))
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(hf_home / "hub"))
    # 镜像站不支持 xet 协议；关闭后可走普通 HTTP 下载
    endpoint = (os.environ.get("HF_ENDPOINT") or "").strip().lower()
    if prefer_mirror or "hf-mirror" in endpoint:
        os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

    if prefer_mirror and not (os.environ.get("HF_ENDPOINT") or "").strip():
        os.environ["HF_ENDPOINT"] = HF_MIRROR
        os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    elif not endpoint:
        # 未配置时默认走国内镜像，避免 Mac 首次下载 Whisper 超时
        os.environ["HF_ENDPOINT"] = HF_MIRROR
        os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


def _hub_error_hint(exc: Exception) -> str:
    msg = str(exc)
    low = msg.lower()
    if any(
        k in low
        for k in (
            "timed out",
            "timeout",
            "cannot find the appropriate snapshot",
            "locate the files on the hub",
            "connection",
            "network",
            "errno 60",
        )
    ):
        return (
            "首次本地转写需从 Hugging Face 下载 Whisper 模型。"
            "Mac/国内网络易超时，请任选其一："
            "① 在 .env 加 HF_ENDPOINT=https://hf-mirror.com 后重启；"
            "② 运行 bash scripts/install-deps.sh 预下载；"
            "③ 设置里配置硅基流动/OpenAI 云端转写（自动模式会优先云端）。"
        )
    return f"本地转写失败：{msg[-240:]}"


def _is_hub_download_error(exc: Exception) -> bool:
    low = str(exc).lower()
    return any(
        k in low
        for k in (
            "timed out",
            "timeout",
            "snapshot folder",
            "locate the files on the hub",
            "connection",
            "errno 60",
        )
    )


def _cuda_available() -> bool:
    try:
        import ctranslate2

        devices = ctranslate2.get_supported_devices() or []
        if "cuda" in devices:
            return True
    except Exception:  # noqa: BLE001
        pass
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        return False


def _resolve_whisper_device() -> list[tuple[str, str]]:
    """返回按优先级尝试的 (device, compute_type) 列表。

    KONGKU_WHISPER_DEVICE=auto|cpu|cuda（默认 auto）。
    """
    pref = (os.environ.get("KONGKU_WHISPER_DEVICE") or "auto").strip().lower() or "auto"
    if pref in {"cpu", "none"}:
        return [("cpu", "int8")]
    if pref in {"cuda", "gpu"}:
        if _cuda_available():
            return [("cuda", "float16"), ("cuda", "int8"), ("cpu", "int8")]
        logger.warning("KONGKU_WHISPER_DEVICE=%s 但未检测到 CUDA，回退 CPU", pref)
        return [("cpu", "int8")]
    # auto
    if _cuda_available():
        return [("cuda", "float16"), ("cuda", "int8"), ("cpu", "int8")]
    return [("cpu", "int8")]


def _instantiate_whisper(size: str, device: str, compute_type: str, download_root: str):
    from faster_whisper import WhisperModel

    configure_hf_hub()
    try:
        return WhisperModel(
            size,
            device=device,
            compute_type=compute_type,
            download_root=download_root,
        )
    except Exception as first_exc:  # noqa: BLE001
        if not _is_hub_download_error(first_exc):
            raise
        # 官方 Hub 超时 → 自动换国内镜像重试一次
        configure_hf_hub(prefer_mirror=True)
        try:
            return WhisperModel(
                size,
                device=device,
                compute_type=compute_type,
                download_root=download_root,
            )
        except Exception as second_exc:  # noqa: BLE001
            raise ValueError(_hub_error_hint(second_exc)) from second_exc


def load_whisper_model(model_size: str):
    """加载本地 Whisper；同进程按 (size, device, compute_type) 缓存。"""
    size = (model_size or "base").strip() or "base"
    download_root = str(_data_models_dir())
    attempts = _resolve_whisper_device()

    with _whisper_lock:
        for device, compute_type in attempts:
            key = (size, device, compute_type)
            cached = _whisper_cache.get(key)
            if cached is not None:
                return cached
            try:
                model = _instantiate_whisper(size, device, compute_type, download_root)
                _whisper_cache[key] = model
                logger.info(
                    "loaded whisper model size=%s device=%s compute_type=%s",
                    size,
                    device,
                    compute_type,
                )
                return model
            except ValueError:
                raise
            except Exception as exc:  # noqa: BLE001
                # CUDA/精度失败则试下一档；Hub 错误已在 _instantiate 转成 ValueError
                logger.warning(
                    "whisper load failed size=%s device=%s compute_type=%s: %s",
                    size,
                    device,
                    compute_type,
                    exc,
                )
                continue
        raise ValueError("本地转写模型加载失败，请改用云端转写或检查 faster-whisper 安装")


def _download_via_desktop_bridge(url: str, work_dir: Path) -> Path | None:
    """桌面端桥：用已登录 Electron 会话抓抖音媒体（绕过 yt-dlp 网页接口风控）。"""
    import os

    import httpx

    bridge = (os.environ.get("KONGKU_DESKTOP_BRIDGE") or "").strip().rstrip("/")
    if not bridge:
        return None
    if "douyin" not in (url or "").lower() and "iesdouyin" not in (url or "").lower():
        return None
    try:
        with httpx.Client(timeout=httpx.Timeout(150.0, connect=5.0), trust_env=False) as client:
            resp = client.post(
                f"{bridge}/douyin/fetch",
                json={"url": url, "out_dir": str(work_dir)},
            )
            data = resp.json()
    except Exception:  # noqa: BLE001
        return None
    if not data.get("ok"):
        return None
    path = Path(str(data.get("path") or ""))
    if path.is_file() and path.stat().st_size > 1024:
        return path
    return None


def download_audio_sync(url: str, work_dir: Path, cookie_file: Path | None = None) -> Path:
    from app.modules.sources.extractors import (
        apply_ytdlp_network_opts,
        compact_tool_error,
        resolve_media_url_sync,
    )

    url = resolve_media_url_sync(url)
    work_dir.mkdir(parents=True, exist_ok=True)
    for old in work_dir.glob("audio.*"):
        try:
            old.unlink()
        except OSError:
            pass

    # 抖音：优先桌面桥（真实登录会话），yt-dlp 网页接口近年经常 Fresh cookies 误报
    bridged = _download_via_desktop_bridge(url, work_dir)
    if bridged is not None:
        return bridged

    try:
        import yt_dlp
    except ImportError as exc:
        raise ValueError("未安装 yt-dlp，无法下载视频音轨") from exc

    ffmpeg = resolve_ffmpeg()
    outtmpl = str(work_dir / "audio.%(ext)s")
    ua = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    )
    # Referer 按平台给：带错 Referer（如抖音）会被 B站 WAF 拦截，
    # 表现为 403 / KeyError('bvid') 等误导性报错
    url_low = url.lower()
    is_bilibili = "bilibili" in url_low or "b23.tv" in url_low
    req_headers = {"User-Agent": ua}
    if "douyin" in url_low or "iesdouyin" in url_low:
        req_headers["Referer"] = "https://www.douyin.com/"
        req_headers["Origin"] = "https://www.douyin.com"
    elif is_bilibili:
        req_headers["Referer"] = "https://www.bilibili.com/"
    base: dict = {
        "outtmpl": outtmpl,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "retries": 8,
        "fragment_retries": 8,
        "file_access_retries": 3,
        "concurrent_fragment_downloads": 4,
        "http_headers": req_headers,
    }
    base = apply_ytdlp_network_opts(base, url)
    if ffmpeg:
        # yt-dlp 接受二进制路径或目录；imageio-ffmpeg 无 ffprobe，故不做 ExtractAudio
        base["ffmpeg_location"] = ffmpeg

    # 多策略：抖音 CDN 偶发空块 / 仅音轨格式失效时，换格式或换 Cookie 再试
    formats: tuple[str, ...] = (
        "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best",
        "best[height<=720]/best",
        "best",
        "worst",
    )
    if is_bilibili:
        # B站近年多为 DASH 分离流（video-only + audio-only），没有「合并好的」
        # progressive 格式。此时 yt-dlp 的 best/worst 会报
        #「Requested format is not available」；必须显式 bv*+ba / bestaudio。
        # 转写优先纯音轨（更小）；失败再拉低清视频由本地抽轨。
        formats = (
            "bestaudio/bestvideo[height<=480]+bestaudio/bestvideo+bestaudio/best",
            "bv*[height<=480]+ba/bv*+ba/b",
            "bestvideo+bestaudio/best",
        )
        base.setdefault("merge_output_format", "mp4")
    attempts: list[dict] = []
    for fmt in formats:
        if cookie_file is not None and cookie_file.is_file():
            attempts.append({**base, "format": fmt, "cookiefile": str(cookie_file)})
        # B站匿名常无可用清晰度，有 Cookie 时不必再盲试匿名（易触发风控）
        if not is_bilibili or cookie_file is None or not cookie_file.is_file():
            attempts.append({**base, "format": fmt})

    last_exc = ""
    for opts in attempts:
        for old in work_dir.glob("audio.*"):
            try:
                old.unlink()
            except OSError:
                pass
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])
            files = sorted(
                [p for p in work_dir.glob("audio.*") if p.is_file() and p.stat().st_size > 0],
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            if files:
                size = files[0].stat().st_size
                if size > 120 * 1024 * 1024:
                    raise ValueError("媒体文件过大（>120MB），请换较短视频或补贴文案")
                return files[0]
            last_exc = "音轨下载后未找到文件"
        except Exception as exc:  # noqa: BLE001
            last_exc = str(exc)
            continue

    # yt-dlp 失败后再试一次桌面桥（桥可能刚就绪）
    bridged = _download_via_desktop_bridge(url, work_dir)
    if bridged is not None:
        return bridged

    tip = ""
    low = last_exc.lower()
    if any(k in low for k in ("proxy", "tunnel connection failed", "unable to connect to proxy")):
        tip = (
            " 本机代理（Clash/VPN）拦截了请求。"
            "请关闭系统/终端代理后重试。"
        )
    elif is_bilibili and (
        "format is not available" in low or "no video formats" in low
    ):
        tip = (
            " B站未返回可下载清晰度。请确认已「应用内登录B站」后重试；"
            "合集批量时请稍候再试，并关闭 Clash 等代理。"
        )
    elif is_bilibili:
        tip = (
            " B站抓取失败。请确认：① 桌面端「应用内登录B站」；"
            "② 稍候几分钟再「重试」；③ 关闭 Clash 等代理。"
        )
    elif any(
        k in low
        for k in (
            "data blocks",
            "fresh cookies",
            "cookie",
            "login",
            "403",
            "401",
            "empty",
        )
    ):
        tip = (
            " 抖音网页接口近年风控较严。请确认：① 用桌面端并已「应用内登录抖音」；"
            "② 关闭 Clash；③ 仍失败请「补贴文案」。"
        )
    raise ValueError(
        f"下载音轨失败：{compact_tool_error(last_exc, url=url)}{tip}"
    )


def transcribe_local_sync(
    audio_path: Path, *, model_size: str = "base"
) -> tuple[str, list]:
    """返回 (纯文本, TimedCue 列表)。"""
    from app.modules.sources.cues import TimedCue

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
        import faster_whisper  # noqa: F401
    except ImportError as exc:
        raise ValueError(
            "未安装本地转写组件。请在 apps/api 执行："
            "pip install faster-whisper imageio-ffmpeg"
        ) from exc

    size = (model_size or "base").strip() or "base"
    cues: list[TimedCue] = []
    try:
        # 推理全程持锁，避免两路 ctranslate2 抢同一 GPU/模型
        with _whisper_infer_lock:
            model = load_whisper_model(size)
            segments, _info = model.transcribe(
                str(audio_path),
                language="zh",
                vad_filter=True,
                beam_size=1,
            )
            parts: list[str] = []
            for seg in segments:
                t = (seg.text or "").strip()
                if not t:
                    continue
                try:
                    from zhconv import convert

                    t = convert(t, "zh-cn")
                except Exception:  # noqa: BLE001
                    pass
                parts.append(t)
                cues.append(
                    TimedCue(
                        start=float(getattr(seg, "start", 0) or 0),
                        end=float(getattr(seg, "end", 0) or 0),
                        text=t,
                    )
                )
            text = "\n".join(parts).strip()
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ValueError(_hub_error_hint(exc)) from exc

    if len(text) < 8:
        raise ValueError("本地转写结果几乎为空")
    return text, cues


def transcribe_cloud_sync(audio_path: Path, *, base_url: str, api_key: str, model: str) -> tuple[str, list]:
    """云端转写；多数接口无句级时间轴，cues 为空。"""
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
    return text, []


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


def extract_audio_with_ffmpeg(media_path: Path, work_dir: Path) -> Path:
    """把视频/任意容器抽出为适合 ASR 的单声道音轨（优先 m4a，失败则 wav）。"""
    ffmpeg = resolve_ffmpeg()
    if not ffmpeg:
        raise ValueError(
            "需要 ffmpeg 才能从视频抽音频。已尝试内置 imageio-ffmpeg；"
            "若仍失败请安装 ffmpeg 并加入 PATH，或设置 KONGKU_FFMPEG。"
        )
    if not media_path.is_file() or media_path.stat().st_size < 256:
        raise ValueError("媒体文件无效或过小")

    work_dir.mkdir(parents=True, exist_ok=True)
    suffix = media_path.suffix.lower()
    # 已是较小纯音轨且体积可控时，可直接用，避免二次损失
    if suffix in {".m4a", ".mp3", ".wav", ".aac"} and media_path.stat().st_size < 24 * 1024 * 1024:
        dest = work_dir / f"audio{suffix}"
        if media_path.resolve() != dest.resolve():
            shutil.copy2(media_path, dest)
        return dest

    out_m4a = work_dir / "audio.m4a"
    out_wav = work_dir / "audio.wav"
    for old in (out_m4a, out_wav):
        try:
            old.unlink()
        except OSError:
            pass

    # -vn 去画面；单声道 16k 利于语音识别与体积
    attempts = [
        [
            ffmpeg,
            "-y",
            "-i",
            str(media_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            str(out_m4a),
        ],
        [
            ffmpeg,
            "-y",
            "-i",
            str(media_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(out_wav),
        ],
    ]
    last_err = ""
    for cmd in attempts:
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=600,
                check=False,
            )
            out = Path(cmd[-1])
            if proc.returncode == 0 and out.is_file() and out.stat().st_size > 1024:
                if out.stat().st_size > 120 * 1024 * 1024:
                    raise ValueError("抽出的音轨过大（>120MB），请换较短视频")
                return out
            err = (proc.stderr or proc.stdout or "").strip()
            last_err = err[-400:] if err else f"exit {proc.returncode}"
        except subprocess.TimeoutExpired as exc:
            raise ValueError("ffmpeg 抽音频超时") from exc
        except ValueError:
            raise
        except Exception as exc:  # noqa: BLE001
            last_err = str(exc)
            continue

    raise ValueError(f"ffmpeg 抽音频失败：{last_err or '未知错误'}")


def prepare_audio_for_asr(media_path: Path, work_dir: Path) -> Path:
    """下载或上传得到的媒体 → 统一抽成 ASR 用音轨。"""
    return extract_audio_with_ffmpeg(media_path, work_dir)


def _run_asr_plan(
    audio: Path, plan: list[tuple[str, dict[str, str]]]
) -> tuple[str, list]:
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
            return transcribe_local_sync(
                audio, model_size=params.get("model_size") or "base"
            )
        except ValueError as exc:
            errors.append(f"{engine}: {exc}")
            continue
    raise ValueError("；".join(errors) if errors else "语音转写失败")


def transcribe_media_file_sync(
    media_path: Path,
    work_dir: Path,
    cfg: dict[str, str],
) -> tuple[str, list, Path]:
    """本地视频/音频文件 → ffmpeg 抽轨 → ASR。返回 (文本, cues, 音轨路径)。"""
    plan = resolve_asr_plan(cfg)
    if not plan:
        raise ValueError(
            "语音转写已关闭。请在设置开启「视频语音转写」，或「补贴文案」。"
        )
    audio = prepare_audio_for_asr(media_path, work_dir)
    text, cues = _run_asr_plan(audio, plan)
    return text, cues, audio


def transcribe_video_audio_sync(
    url: str,
    work_dir: Path,
    cfg: dict[str, str],
    cookie_file: Path | None = None,
) -> tuple[str, list, Path]:
    """链接下载媒体 → ffmpeg 抽轨 → ASR。返回 (文本, cues, 音轨路径)。"""
    plan = resolve_asr_plan(cfg)
    if not plan:
        raise ValueError(
            "语音转写已关闭。请在设置开启「视频语音转写」，或「补贴文案」。"
        )

    raw = download_audio_sync(url, work_dir, cookie_file=cookie_file)
    # 桥/ yt-dlp 常得到 mp4；统一抽音频再转写
    audio = prepare_audio_for_asr(raw, work_dir)
    text, cues = _run_asr_plan(audio, plan)
    return text, cues, audio