"""从原件 / URL 抽取纯文本。"""

from __future__ import annotations

import re
import subprocess
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse, urlunparse


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._chunks: list[str] = []
        self._skip = False

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        if tag in {"script", "style", "noscript"}:
            self._skip = True

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"}:
            self._skip = False
        if tag in {"p", "div", "br", "li", "h1", "h2", "h3", "tr"}:
            self._chunks.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip and data:
            self._chunks.append(data)

    def text(self) -> str:
        raw = "".join(self._chunks)
        raw = re.sub(r"[ \t]+", " ", raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        return raw.strip()


def decode_bytes(data: bytes) -> str:
    for enc in ("utf-8", "utf-8-sig", "gbk", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="ignore")


def extract_txt(path: Path) -> str:
    return decode_bytes(path.read_bytes()).strip()


_MIN_TEXT_CHARS = 20
# 扫描件 OCR 上限：避免超大书一次拖死；超出部分会在文末注明
_OCR_MAX_PAGES = 120
_ocr_engine = None


def _get_ocr_engine():
    global _ocr_engine
    if _ocr_engine is None:
        from rapidocr import RapidOCR

        _ocr_engine = RapidOCR()
    return _ocr_engine


def _extract_pdf_pypdf(path: Path) -> str:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    parts: list[str] = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
    return "\n".join(parts).strip()


def _extract_pdf_pymupdf_text(path: Path) -> str:
    import fitz

    doc = fitz.open(str(path))
    try:
        parts: list[str] = []
        for page in doc:
            parts.append(page.get_text("text") or "")
        return "\n".join(parts).strip()
    finally:
        doc.close()


def _ocr_pdf_pages(path: Path) -> str:
    """把页面渲成图后用 RapidOCR（中英）识别。"""
    import fitz
    import numpy as np

    engine = _get_ocr_engine()
    doc = fitz.open(str(path))
    try:
        total = doc.page_count
        limit = min(total, _OCR_MAX_PAGES)
        # 约 144dpi：速度与清晰度折中
        matrix = fitz.Matrix(1.5, 1.5)
        parts: list[str] = []
        for i in range(limit):
            page = doc.load_page(i)
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            if pix.n == 4:
                img = img[:, :, :3]
            result = engine(img)
            lines: list[str] = []
            txts = getattr(result, "txts", None)
            if txts:
                lines = [t for t in txts if t]
            elif isinstance(result, (list, tuple)) and result:
                # 兼容旧版 rapidocr-onnxruntime 返回值
                for item in result:
                    if item and len(item) >= 2 and item[1]:
                        lines.append(str(item[1]))
            page_text = "\n".join(lines).strip()
            if page_text:
                parts.append(page_text)
        text = "\n\n".join(parts).strip()
        if len(text) < _MIN_TEXT_CHARS:
            raise ValueError("OCR 未能识别出有效文字，请换清晰扫描件或改用 TXT/粘贴")
        if total > limit:
            text += f"\n\n（提示：本书共 {total} 页，本次 OCR 仅处理前 {limit} 页）"
        return text
    finally:
        doc.close()


def extract_pdf(path: Path) -> str:
    """优先抽文字层；不足时再 RapidOCR（适合扫描版 PDF）。"""
    text = ""
    try:
        text = _extract_pdf_pypdf(path)
    except Exception:
        text = ""

    if len(text) >= _MIN_TEXT_CHARS:
        return text

    try:
        text = _extract_pdf_pymupdf_text(path)
    except Exception:
        text = ""

    if len(text) >= _MIN_TEXT_CHARS:
        return text

    try:
        return _ocr_pdf_pages(path)
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001
                raise ValueError(
                    f"扫描版 PDF 识别失败：{exc}。请确认已安装 rapidocr / onnxruntime，或改用带文字层的 PDF"
                ) from exc


def extract_epub(path: Path) -> str:
    from ebooklib import epub
    from ebooklib import ITEM_DOCUMENT

    book = epub.read_epub(str(path))
    parts: list[str] = []
    for item in book.get_items_of_type(ITEM_DOCUMENT):
        html = item.get_content().decode("utf-8", errors="ignore")
        parser = _HTMLTextExtractor()
        parser.feed(html)
        t = parser.text()
        if t:
            parts.append(t)
    text = "\n\n".join(parts).strip()
    if len(text) < 20:
        raise ValueError("EPUB 未能抽出有效正文")
    return text


def extract_local_file(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".txt", ".md", ".markdown"}:
        return extract_txt(path)
    if suffix == ".pdf":
        return extract_pdf(path)
    if suffix == ".epub":
        return extract_epub(path)
    raise ValueError(f"不支持的文件类型：{suffix}")


def looks_like_video_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    needles = (
        "youtube.com",
        "youtu.be",
        "bilibili.com",
        "b23.tv",
        "v.qq.com",
        "douyin.com",
        "iesdouyin.com",
        "tiktok.com",
        "vimeo.com",
    )
    return any(n in host for n in needles)


_SHARE_URL_RE = re.compile(r"https?://[^\s<>\"'\]）)」』]+", re.IGNORECASE)


def _clean_extracted_url(raw: str) -> str:
    u = raw.strip()
    # 分享文案常把「复制此链接」粘在 URL 后且无空格
    for marker in ("复制此链接", "复制链接", "打开Dou音", "打开抖音", "打开抖音搜索"):
        idx = u.find(marker)
        if idx > 0:
            u = u[:idx]
    # 不要把短链末尾的 / 清掉到误伤 path；只清常见中英文标点
    u = u.rstrip("，。！？；：、）)」』\"'.,;:!?\\")
    return u.rstrip("/")


def normalize_media_url(url: str) -> str:
    """轻量规范化：完整视频页去掉跟踪参数；短链保持原样（交给跳转解析）。"""
    u = _clean_extracted_url(url)
    try:
        p = urlparse(u)
    except Exception:  # noqa: BLE001
        return u
    host = (p.hostname or "").lower()
    path = p.path or ""

    # 已是 /video/数字 → 规范成干净页，去掉 share_sign 等
    if any(n in host for n in ("douyin.com", "iesdouyin.com")):
        m = re.search(r"/video/(\d+)", path)
        if m:
            return f"https://www.douyin.com/video/{m.group(1)}"
        # v.douyin.com/xxxx 短链：不要改 path，只去掉 query
        if host.startswith("v.") or re.fullmatch(r"/[A-Za-z0-9_-]+/?", path or ""):
            # yt-dlp 对带/不带/都可；保留短码即可
            return urlunparse(
                (p.scheme or "https", p.netloc, path.rstrip("/") + "/", "", "", "")
            )
        # 其它 douyin 页：去掉 query 但保留 path
        return urlunparse((p.scheme or "https", p.netloc, path, "", "", ""))

    if "bilibili.com" in host or "b23.tv" in host:
        return urlunparse((p.scheme or "https", p.netloc, path.rstrip("/") or "/", "", "", ""))

    if "youtube.com" in host or "youtu.be" in host:
        from urllib.parse import parse_qs, urlencode

        qs = parse_qs(p.query, keep_blank_values=False)
        keep = {}
        for key in ("v", "list", "t", "start"):
            if key in qs and qs[key]:
                keep[key] = qs[key][0]
        return urlunparse(
            (p.scheme or "https", p.netloc, path, "", urlencode(keep), "")
        )

    return u


def _ytdlp_proxy_opt() -> str:
    """抖音抓取默认直连。系统 HTTP_PROXY（Clash 等）常 403，再被误报成 Fresh cookies。"""
    import os

    return (os.environ.get("KONGKU_YTDLP_PROXY") or "").strip()


def apply_ytdlp_network_opts(opts: dict) -> dict:
    """写入 proxy / UA 相关网络选项（原地修改并返回）。"""
    opts = dict(opts)
    # 空字符串 = yt-dlp 明确不走代理，忽略环境变量里的 HTTP_PROXY
    opts["proxy"] = _ytdlp_proxy_opt()
    headers = dict(opts.get("http_headers") or {})
    headers.setdefault(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    )
    headers.setdefault("Referer", "https://www.douyin.com/")
    opts["http_headers"] = headers
    return opts


def _httpx_client_kwargs(**extra) -> dict:
    """httpx：默认不信任环境代理，避免短链解析也走坏代理。"""
    import os

    kwargs = {
        "trust_env": False,
        "follow_redirects": True,
        "timeout": httpx_timeout_default(),
        "headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
            ),
            "Referer": "https://www.douyin.com/",
        },
    }
    proxy = _ytdlp_proxy_opt()
    if proxy:
        kwargs["proxy"] = proxy
    kwargs.update(extra)
    return kwargs


def httpx_timeout_default():
    import httpx

    return httpx.Timeout(20.0, connect=8.0)


def resolve_media_url_sync(url: str) -> str:
    """短链跟跳到可识别的视频页（v.douyin.com → www.douyin.com/video/id）。"""
    u = normalize_media_url(url)
    try:
        p = urlparse(u)
    except Exception:  # noqa: BLE001
        return u
    host = (p.hostname or "").lower()
    need_resolve = any(
        n in host
        for n in ("v.douyin.com", "v.tiktok.com", "b23.tv", "xhslink.com")
    ) or (host.endswith("douyin.com") and "/video/" not in (p.path or ""))
    if not need_resolve and "/video/" in (p.path or ""):
        return u

    # 已有数字 video id 则不必跳转
    if re.search(r"/video/(\d+)", p.path or ""):
        return normalize_media_url(u)

    if not any(n in host for n in ("douyin.com", "iesdouyin.com", "b23.tv", "tiktok.com", "xhslink.com")):
        return u

    try:
        import httpx

        with httpx.Client(**_httpx_client_kwargs()) as client:
            resp = client.get(u)
            final = str(resp.url)
            if final and final != u:
                return normalize_media_url(final)
    except Exception:  # noqa: BLE001
        pass
    return u


def compact_tool_error(err: str, limit: int = 180) -> str:
    """压缩 yt-dlp 等长错误：优先 ERROR 行，去掉 URL，取头部而非尾巴。"""
    text = str(err or "").strip()
    if not text:
        return "未知错误"
    for line in text.replace("\r", "\n").split("\n"):
        s = line.strip()
        if s.upper().startswith("ERROR:"):
            text = s
            break
    low_full = text.lower()
    if any(
        k in low_full
        for k in (
            "proxy",
            "tunnel connection failed",
            "unable to connect to proxy",
            "407 proxy",
        )
    ):
        return (
            "访问抖音失败：本机代理（Clash/VPN 等）拦截了请求。"
            "请关闭系统/终端代理后重试，或设置环境变量 KONGKU_YTDLP_PROXY 指向可用代理。"
        )
    text = re.sub(r"https?://\S+", "[链接]", text)
    text = re.sub(r"\s+", " ", text).strip()
    if "unsupported url" in text.lower():
        return (
            "无法识别该链接。请粘贴完整抖音分享文案或 v.douyin.com 短链，"
            "并确认已「应用内登录抖音」后重试"
        )
    if "fresh cookies" in text.lower():
        return (
            "抖音网页接口风控（常被误报成 Cookie 问题）。"
            "请用桌面端并已登录后重试；系统会改走应用内会话下载。"
        )
    if re.fullmatch(r"[\w%.\-&=]+", text) and ("share_sign" in text or "from_aid" in text):
        return "平台返回异常（链接参数噪声），请重新粘贴分享链接或「应用内登录抖音」后重试"
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


def extract_urls_from_text(text: str) -> list[str]:
    """从纯 URL 或抖音/B站等「复制分享」整段文案中抽出 http(s) 链接。"""
    found: list[str] = []
    seen: set[str] = set()
    for m in _SHARE_URL_RE.finditer(text or ""):
        # 抽取阶段只做轻清洗，避免误伤短链；规范化放到 resolve
        u = _clean_extracted_url(m.group(0))
        if not u.startswith(("http://", "https://")):
            continue
        if u in seen:
            continue
        seen.add(u)
        found.append(u)
    return found


def _strip_share_title_noise(title: str) -> str:
    """去掉抖音口令前缀噪声，例如「XM 重塑思维」→「重塑思维」。"""
    t = (title or "").strip()
    if not t:
        return ""
    # 口令码：两位随机字母 + 空格（用户反馈的 XM / AB 等）
    t = re.sub(r"^[A-Za-z]{1,4}\s+", "", t)
    # 7.23 xxx:/ 或 xxx:/ 一类邀请码
    t = re.sub(r"^[\d.]+\s+[A-Za-z0-9_-]{2,}:/\s*", "", t)
    t = re.sub(r"^[A-Za-z0-9_-]{2,}:/\s*", "", t)
    # 再清一次残留短英文前缀
    t = re.sub(r"^[A-Za-z]{1,4}\s+", "", t)
    return t.strip(" /:：.-")


def guess_title_from_share(text: str, url: str) -> str:
    """从分享文案里猜标题（如抖音「标题 #标签 https://…」）。"""
    head = (text or "").split(url, 1)[0]
    head = re.split(r"\s+#", head, maxsplit=1)[0].strip()
    if not head:
        return ""
    for noise in ("复制此链接", "打开抖音", "打开Dou音", "长按复制", "请使用抖音"):
        idx = head.find(noise)
        if idx >= 0:
            head = head[:idx].strip()
    # 去掉口令前缀后再取偏中文的末段
    head = _strip_share_title_noise(head)
    m = re.search(
        r"([\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9，。！？、：；《》【】（）\-\s]{0,120})$",
        head,
    )
    title = (m.group(1) if m else head).strip(" /:：.-")
    title = _strip_share_title_noise(title)
    if len(title) < 2:
        return ""
    # 过滤反爬口令噪声 / 纯英文乱码
    if re.fullmatch(r"[\d\s\./@:a-zA-Z_\-]+", title):
        return ""
    if len(re.findall(r"[\u4e00-\u9fff]", title)) < 1:
        return ""
    return title[:200]


def parse_share_input(raw: str) -> tuple[str, str]:
    """
    解析用户粘贴内容 → (URL, 可选标题)。
    支持纯链接与抖音「复制分享」整段口令；标题优先从文案猜测。
    """
    text = (raw or "").strip()
    if not text:
        raise ValueError("请输入链接或粘贴分享文案")

    if text.startswith(("http://", "https://")) and not re.search(r"\s", text):
        url = _clean_extracted_url(text)
        return url, ""

    urls = extract_urls_from_text(text)
    if not urls:
        raise ValueError("未识别到 http(s) 链接；请粘贴完整分享内容或直接粘贴网址")

    url = next((u for u in urls if looks_like_video_url(u)), urls[0])
    title = guess_title_from_share(text, url)
    return url, title


def _strip_douyin_share_noise(head: str) -> str:
    return _strip_share_title_noise(head)

def fetch_video_title_sync(url: str) -> str:
    """用 yt-dlp 仅拉元数据拿标题（不下载媒体）。失败返回空串。"""
    try:
        import yt_dlp
    except ImportError:
        return ""

    resolved = resolve_media_url_sync(url)
    base = apply_ytdlp_network_opts(
        {
            "skip_download": True,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
        }
    )
    attempts: list[dict] = []
    cookie_file = _resolve_cookie_file()
    if cookie_file is not None:
        attempts.append({**base, "cookiefile": str(cookie_file)})
    attempts.append(dict(base))

    for target in (resolved, url):
        if not target:
            continue
        for opts in attempts:
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(target, download=False)
                if not info:
                    continue
                if info.get("_type") == "playlist" and info.get("entries"):
                    first = next((e for e in info["entries"] if e), None)
                    if first:
                        info = first
                title = (info.get("title") or info.get("fulltitle") or "").strip()
                if not title:
                    continue
                low = title.lower()
                if low in {"douyin video", "tiktok", "video"}:
                    continue
                title = re.sub(r"(?:\s*#[^\s#]+)+\s*$", "", title).strip()
                return title[:200] if title else ""
            except Exception:  # noqa: BLE001
                continue
    return ""

async def extract_webpage(url: str) -> str:
    import httpx

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(20.0, connect=8.0),
        follow_redirects=True,
        headers={"User-Agent": "KongkuBot/0.1 (+local knowledge base)"},
    ) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        ctype = (resp.headers.get("content-type") or "").lower()
        if "html" not in ctype and "text" not in ctype:
            raise ValueError(f"链接不是网页正文（content-type={ctype or 'unknown'}）")
        html = resp.text
    # 优先 trafilatura（若已安装）
    try:
        import trafilatura

        extracted = trafilatura.extract(html, include_comments=False, include_tables=False)
        if extracted and len(extracted.strip()) >= 40:
            return extracted.strip()
    except Exception:
        pass
    parser = _HTMLTextExtractor()
    parser.feed(html)
    text = parser.text()
    if len(text) < 40:
        raise ValueError("未能从网页抽出足够正文")
    return text


def _clean_subtitle_text(raw: str) -> str:
    lines: list[str] = []
    for line in raw.splitlines():
        s = line.strip()
        if not s or s.startswith("WEBVTT") or "-->" in s or s.isdigit():
            continue
        s = re.sub(r"<[^>]+>", "", s)
        lines.append(s)
    return "\n".join(lines).strip()


def _yt_dlp_cli() -> list[str] | None:
    """解析本机 yt-dlp 可执行文件（venv Scripts / PATH）。"""
    import shutil
    import sys

    which = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")
    if which:
        return [which]
    scripts = Path(sys.executable).resolve().parent
    for name in ("yt-dlp.exe", "yt-dlp"):
        candidate = scripts / name
        if candidate.is_file():
            return [str(candidate)]
    return None


def _is_cookie_gated_host(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return any(
        n in host
        for n in ("douyin.com", "iesdouyin.com", "tiktok.com", "xiaohongshu.com", "xhslink.com")
    )


def _is_dpapi_error(err: str) -> bool:
    low = (err or "").lower()
    return "dpapi" in low or "failed to decrypt" in low or "app-bound" in low


def _cookies_needed(err: str) -> bool:
    low = (err or "").lower()
    return (
        "cookie" in low
        or "登录" in (err or "")
        or "login" in low
        or _is_dpapi_error(err)
    )


def _friendly_subs_error(err: str, url: str) -> str:
    low = (err or "").lower()
    if any(
        k in low
        for k in (
            "proxy",
            "tunnel connection failed",
            "unable to connect to proxy",
        )
    ):
        return (
            "访问抖音失败：本机代理（Clash/VPN 等）拦截了请求，常被误报成需要登录。"
            "请关闭系统代理后重试，或「补贴文案」。"
        )
    if _is_dpapi_error(err):
        return (
            "无法从系统 Chrome/Edge 读取 Cookie（Windows DPAPI）。"
            "请在桌面端喂养页点「应用内登录抖音」，登录后关闭窗口，再点队列「重试」；"
            "或直接「补贴文案」。"
        )
    if "fresh cookies" in low:
        return (
            "抖音网页抓取接口已升级风控（不一定是未登录）。"
            "桌面端会改用应用内登录会话下载；请确认已「应用内登录抖音」后重试，或「补贴文案」。"
        )
    if _cookies_needed(err) and _is_cookie_gated_host(url):
        return (
            "抖音需要登录态才能抓取。"
            "请在桌面端点「应用内登录抖音」后重试，或「补贴文案」。"
        )
    msg = (err or "").strip()
    low = msg.lower()
    if (not msg) or "no subtitles" in low or "requested languages" in low:
        if _is_cookie_gated_host(url):
            return "该视频没有可下载字幕轨（抖音多数如此），将改用音轨语音转写。"
        return "该视频没有可下载字幕，将改用音轨语音转写。"
    if "data blocks" in low:
        return (
            "该视频没有可用字幕，且音轨 CDN 拉取为空。"
            "请关闭代理并重新「应用内登录抖音」后重试，或「补贴文案」。"
        )
    return f"未拿到字幕：{compact_tool_error(msg)}"


def extract_video_audio_transcript_sync(
    url: str,
    work_dir: Path,
    asr_cfg: dict[str, str] | None = None,
    creds: dict[str, str] | None = None,
) -> tuple[str, list, Path]:
    """下载音轨并转写。返回 (文本, cues, 音轨路径)。"""
    from app.modules.sources.asr import transcribe_video_audio_sync

    url = resolve_media_url_sync(url)
    cfg = dict(asr_cfg or {})
    if creds:
        cfg.setdefault("chat_base_url", creds.get("base_url") or "")
        cfg.setdefault("chat_api_key", creds.get("api_key") or "")
        if creds.get("asr_model"):
            cfg.setdefault("asr_model", creds["asr_model"])
    cfg.setdefault("asr_mode", cfg.get("asr_mode") or "auto")
    return transcribe_video_audio_sync(
        url, work_dir, cfg, cookie_file=_resolve_cookie_file()
    )


def extract_media_file_transcript_sync(
    media_path: Path,
    work_dir: Path,
    asr_cfg: dict[str, str] | None = None,
) -> tuple[str, list, Path]:
    """本地视频/音频 → ffmpeg 抽轨 → 转写。"""
    from app.modules.sources.asr import transcribe_media_file_sync

    cfg = dict(asr_cfg or {})
    cfg.setdefault("asr_mode", cfg.get("asr_mode") or "auto")
    return transcribe_media_file_sync(media_path, work_dir, cfg)


def _resolve_cookie_file() -> Path | None:
    import os

    env = (os.environ.get("KONGKU_YTDLP_COOKIES") or "").strip()
    if env:
        p = Path(env)
        if p.is_file():
            return p
    data_dir = (os.environ.get("DATA_DIR") or "data").strip() or "data"
    for name in ("yt-dlp-cookies.txt", "cookies.txt"):
        p = Path(data_dir) / name
        if p.is_file():
            return p
    return None


def _yt_dlp_option_sets(url: str) -> list[dict]:
    """生成尝试顺序：优先应用内 Cookie 文件；默认不读系统浏览器（避免钥匙串/DPAPI 弹窗）。"""
    import os

    base = {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["zh-Hans", "zh-CN", "zh", "en"],
        "subtitlesformat": "vtt/srt/best",
        "quiet": True,
        "no_warnings": True,
    }
    base = apply_ytdlp_network_opts(base)
    sets: list[dict] = []
    cookie_file = _resolve_cookie_file()
    gated = _is_cookie_gated_host(url)

    # 抖音等站点：只用桌面端导出的 Cookie 文件
    if cookie_file is not None:
        sets.append({**base, "cookiefile": str(cookie_file)})

    if not gated:
        sets.append(dict(base))

    # 仅当用户显式指定时才读系统浏览器（Chrome 会弹钥匙串 / Windows DPAPI）
    browser = (os.environ.get("KONGKU_YTDLP_BROWSER") or "").strip().lower()
    if browser in {"firefox", "chrome", "edge", "brave", "chromium", "safari"}:
        sets.append({**base, "cookiesfrombrowser": (browser,)})

    # 无 Cookie 文件时：抖音最后再试一次匿名（多数会失败，由友好错误引导登录）
    if gated and cookie_file is None:
        sets.append(dict(base))
    elif not sets:
        sets.append(dict(base))
    return sets


def extract_video_subs_sync(url: str, work_dir: Path) -> tuple[str, list]:
    """用 yt-dlp 拉字幕；返回 (文本, TimedCue 列表)。失败抛错。"""
    from app.modules.sources.cues import parse_subtitle_cues

    url = resolve_media_url_sync(url)
    work_dir.mkdir(parents=True, exist_ok=True)
    outtmpl = str(work_dir / "sub")
    err_tail = ""

    # 1) Python API（pip install yt-dlp / PyInstaller collect-all）
    try:
        import yt_dlp
    except ImportError:
        yt_dlp = None  # type: ignore[assignment]

    if yt_dlp is not None:
        last_exc = ""
        skip_chromium_cookies = False
        for opts in _yt_dlp_option_sets(url):
            browser = None
            if "cookiesfrombrowser" in opts:
                browser = (opts.get("cookiesfrombrowser") or (None,))[0]
                if skip_chromium_cookies and browser in {"edge", "chrome"}:
                    continue
            # 清理上次残留，避免误读旧字幕
            for old in work_dir.glob("sub*"):
                try:
                    old.unlink()
                except OSError:
                    pass
            attempt = {**opts, "outtmpl": outtmpl}
            try:
                with yt_dlp.YoutubeDL(attempt) as ydl:
                    ydl.download([url])
                last_exc = ""
                break
            except Exception as exc:  # noqa: BLE001
                last_exc = str(exc)
                if _is_dpapi_error(last_exc) and browser in {"edge", "chrome"}:
                    skip_chromium_cookies = True
                    continue
                if not _cookies_needed(last_exc):
                    break
                continue
        err_tail = last_exc
    else:
        cli = _yt_dlp_cli()
        if not cli:
            raise ValueError(
                "未安装 yt-dlp，无法自动提取视频字幕；"
                "请执行：apps/api 下 pip install yt-dlp，或补贴文案后重试"
            )
        cmd = [
            *cli,
            "--skip-download",
            "--write-auto-sub",
            "--write-sub",
            "--sub-lang",
            "zh-Hans,zh-CN,zh,en",
            "--sub-format",
            "vtt/srt/best",
            "-o",
            outtmpl,
            url,
        ]
        cookie_file = _resolve_cookie_file()
        if cookie_file is not None:
            cmd[1:1] = ["--cookies", str(cookie_file)]
        else:
            import os

            # 默认不读系统浏览器，避免钥匙串 / DPAPI；仅显式指定时启用
            browser = (os.environ.get("KONGKU_YTDLP_BROWSER") or "").strip().lower()
            if browser:
                cmd[1:1] = ["--cookies-from-browser", browser]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=180, check=False
            )
        except subprocess.TimeoutExpired as exc:
            raise ValueError("提取字幕超时") from exc
        err_tail = (proc.stderr or proc.stdout or "").strip()[-300:]

    subs = list(work_dir.glob("*.vtt")) + list(work_dir.glob("*.srt"))
    if not subs:
        raise ValueError(_friendly_subs_error(err_tail, url))

    raw = decode_bytes(subs[0].read_bytes())
    cues = parse_subtitle_cues(raw)
    text = _clean_subtitle_text(raw)
    if len(text) < 20:
        raise ValueError("字幕几乎为空，可补贴文案后重试")
    return text, cues
