"""
从网页字标生成 Electron 应用图标（方图 + Windows .ico）。

用法（仓库根目录）：
  python apps/desktop/scripts/generate-icons.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "apps" / "web" / "public" / "logo-wordmark.png"
OUT_DIR = ROOT / "apps" / "desktop" / "build"
ELECTRON_ICON = ROOT / "apps" / "desktop" / "electron" / "icon.png"

# 品牌色（与前端 --color-accent 接近）
ACCENT = (42, 111, 106, 255)
BG = (255, 255, 255, 255)


def content_bbox(im: Image.Image, threshold: int = 245) -> tuple[int, int, int, int]:
    """非近白像素包围盒。"""
    rgba = im.convert("RGBA")
    px = rgba.load()
    w, h = rgba.size
    min_x, min_y, max_x, max_y = w, h, 0, 0
    found = False
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 16:
                continue
            if r >= threshold and g >= threshold and b >= threshold:
                continue
            found = True
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x)
            max_y = max(max_y, y)
    if not found:
        return (0, 0, w, h)
    return (min_x, min_y, max_x + 1, max_y + 1)


def extract_mark_icon(src: Image.Image) -> Image.Image:
    """
    字标左侧为书本图形：取内容包围盒左侧接近正方形区域，做成应用图标。
    """
    box = content_bbox(src)
    x0, y0, x1, y1 = box
    content_h = y1 - y0
    # 左侧图标宽度约等于内容高度
    side = max(content_h, int(content_h * 1.05))
    left = x0
    right = min(src.width, left + side)
    top = y0
    bottom = min(src.height, top + side)
    # 若裁切偏矮，垂直居中扩展
    if bottom - top < side:
        pad = (side - (bottom - top)) // 2
        top = max(0, top - pad)
        bottom = min(src.height, top + side)
    crop = src.crop((left, top, right, bottom)).convert("RGBA")
    return crop


def make_square(icon: Image.Image, size: int = 1024, pad_ratio: float = 0.14) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), BG)
    inner = int(size * (1 - pad_ratio * 2))
    fitted = icon.copy()
    fitted.thumbnail((inner, inner), Image.Resampling.LANCZOS)
    x = (size - fitted.width) // 2
    y = (size - fitted.height) // 2
    canvas.paste(fitted, (x, y), fitted)
    return canvas


def save_ico(square: Image.Image, path: Path) -> None:
    # Pillow 会按 sizes 从源图生成多分辨率 ICO
    square.convert("RGBA").save(
        path,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"找不到字标：{SRC}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    src = Image.open(SRC)
    mark = extract_mark_icon(src)
    square = make_square(mark, 1024)

    png_path = OUT_DIR / "icon.png"
    ico_path = OUT_DIR / "icon.ico"
    square.convert("RGBA").save(png_path, format="PNG")
    save_ico(square, ico_path)

    # 主进程窗口图标（打进 asar）
    ELECTRON_ICON.parent.mkdir(parents=True, exist_ok=True)
    square.resize((256, 256), Image.Resampling.LANCZOS).save(ELECTRON_ICON, format="PNG")

    # 轻量校验：画一圈透明无操作，仅确保文件可读
    _ = ImageDraw.Draw(square)

    print(f"wrote {png_path}")
    print(f"wrote {ico_path}")
    print(f"wrote {ELECTRON_ICON}")


if __name__ == "__main__":
    main()
