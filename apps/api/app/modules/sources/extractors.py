"""从原件 / URL 抽取纯文本。"""

from __future__ import annotations

import re
import subprocess
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse


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
    u = u.rstrip("，。！？；：、）)」』\"'.,;:!?/\\")
    return u


def extract_urls_from_text(text: str) -> list[str]:
    """从纯 URL 或抖音/B站等「复制分享」整段文案中抽出 http(s) 链接。"""
    found: list[str] = []
    seen: set[str] = set()
    for m in _SHARE_URL_RE.finditer(text or ""):
        u = _clean_extracted_url(m.group(0))
        if not u.startswith(("http://", "https://")):
            continue
        if u in seen:
            continue
        seen.add(u)
        found.append(u)
    return found


def guess_title_from_share(text: str, url: str) -> str:
    """从分享文案里猜标题（如抖音「标题 #标签 https://…」）。"""
    head = (text or "").split(url, 1)[0]
    head = re.split(r"\s+#", head, maxsplit=1)[0].strip()
    if not head:
        return ""
    # 取末尾偏中文的一段，去掉抖音口令前缀噪声
    m = re.search(
        r"([\u4e00-\u9fffA-Za-z0-9][\u4e00-\u9fffA-Za-z0-9，。！？、：；《》【】（）\-\s]{0,120})$",
        head,
    )
    title = (m.group(1) if m else head).strip(" /:：.-")
    # 过滤过短或纯口令
    if len(title) < 2:
        return ""
    if re.fullmatch(r"[\d\s\./@:a-zA-Z]+", title):
        return ""
    return title[:200]


def parse_share_input(raw: str) -> tuple[str, str]:
    """
    解析用户粘贴内容 → (规范 URL, 可选标题)。
    支持：
    - 纯链接
    - 抖音/视频 App「复制分享」整段口令文案
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

    # 优先视频站短链
    url = next((u for u in urls if looks_like_video_url(u)), urls[0])
    title = guess_title_from_share(text, url)
    return url, title


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
    if _is_dpapi_error(err):
        return (
            "无法从系统 Chrome/Edge 读取 Cookie（Windows DPAPI）。"
            "请在桌面端喂养页点「应用内登录抖音」，登录后关闭窗口，再点队列「重试」；"
            "或直接「补贴文案」。"
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
    return f"未拿到字幕：{msg[-280:]}"


def extract_video_audio_transcript_sync(
    url: str,
    work_dir: Path,
    asr_cfg: dict[str, str] | None = None,
    creds: dict[str, str] | None = None,
) -> str:
    """下载音轨并转写。asr_cfg 优先；兼容只传对话 creds。"""
    from app.modules.sources.asr import transcribe_video_audio_sync

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
    """生成尝试顺序：无 cookie → cookies 文件 → Firefox（避 DPAPI）→ Edge/Chrome。"""
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
    sets: list[dict] = []
    cookie_file = _resolve_cookie_file()
    gated = _is_cookie_gated_host(url)

    # 抖音等站点：优先用桌面端导出的 Cookie 文件，避免先无 Cookie 白跑
    if cookie_file is not None:
        sets.append({**base, "cookiefile": str(cookie_file)})
    if not gated:
        sets.append(dict(base))

    browser = (os.environ.get("KONGKU_YTDLP_BROWSER") or "").strip().lower()
    if browser:
        sets.append({**base, "cookiesfrombrowser": (browser,)})

    if gated:
        # Firefox 不走 Chromium DPAPI，Windows 上更稳；再试 edge/chrome
        for b in ("firefox", "edge", "chrome"):
            if b == browser:
                continue
            sets.append({**base, "cookiesfrombrowser": (b,)})
        # 最后再试一次无 Cookie（少数公开页）
        if cookie_file is not None:
            sets.append(dict(base))
    elif not sets:
        sets.append(dict(base))
    return sets


def extract_video_subs_sync(url: str, work_dir: Path) -> str:
    """用 yt-dlp 拉字幕；失败抛错。优先 Python API（开发/打包均可），再回退 CLI。"""
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

            browser = (os.environ.get("KONGKU_YTDLP_BROWSER") or "firefox").strip()
            if _is_cookie_gated_host(url) or browser:
                cmd[1:1] = ["--cookies-from-browser", browser or "firefox"]
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
    text = _clean_subtitle_text(raw)
    if len(text) < 20:
        raise ValueError("字幕几乎为空，可补贴文案后重试")
    return text
