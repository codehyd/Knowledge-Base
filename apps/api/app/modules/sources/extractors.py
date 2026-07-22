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
        "tiktok.com",
        "vimeo.com",
    )
    return any(n in host for n in needles)


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


def extract_video_subs_sync(url: str, work_dir: Path) -> str:
    """用 yt-dlp 拉字幕；失败抛错。"""
    work_dir.mkdir(parents=True, exist_ok=True)
    outtmpl = str(work_dir / "sub")
    cmd = [
        "yt-dlp",
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
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
    except FileNotFoundError as exc:
        raise ValueError("未安装 yt-dlp，无法自动提取视频字幕；请补贴文案或安装 yt-dlp") from exc
    except subprocess.TimeoutExpired as exc:
        raise ValueError("提取字幕超时") from exc

    subs = list(work_dir.glob("*.vtt")) + list(work_dir.glob("*.srt"))
    if not subs:
        err = (proc.stderr or proc.stdout or "").strip()[-300:]
        raise ValueError("未拿到字幕" + (f"：{err}" if err else "，可补贴文案后重试"))

    raw = decode_bytes(subs[0].read_bytes())
    # 粗清洗 VTT/SRT
    lines: list[str] = []
    for line in raw.splitlines():
        s = line.strip()
        if not s or s.startswith("WEBVTT") or "-->" in s or s.isdigit():
            continue
        s = re.sub(r"<[^>]+>", "", s)
        lines.append(s)
    text = "\n".join(lines).strip()
    if len(text) < 20:
        raise ValueError("字幕几乎为空，可补贴文案后重试")
    return text
