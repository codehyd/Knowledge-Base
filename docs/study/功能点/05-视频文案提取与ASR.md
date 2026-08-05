# 功能点 05：视频文案提取与语音转写（从零到一）

> 本篇回答：**用户丢来一个抖音/B站/YouTube 链接，系统怎样拿到文案？有字幕拉字幕，没字幕就语音识别——还要对付平台风控。**

---

## 1. 这个功能解决什么问题？

视频是知识的重要载体，但视频内容没法直接检索——必须先变成文字。链路按难度分三层：

1. **有字幕**：yt-dlp 直接拉字幕文件（最准最快）；
2. **没字幕**：下载音轨，用语音识别（ASR）转写成文字；
3. **被风控**：抖音等平台反爬，yt-dlp 直接抓会 403——需要桌面端"已登录浏览器"这个杀手锏。

另外，真实用户不会粘贴"干净的 URL"，他们粘的是"7.23 复制打开抖音… https://v.douyin.com/xxx/ …"整段分享口令。

## 2. 先修概念

- **yt-dlp**：youtube-dl 的活跃分支，支持上千个站点的视频元数据/字幕/音轨下载。
- **ASR（自动语音识别）**：音频 → 文字。云端方案走 OpenAI 兼容 `/audio/transcriptions`；本地方案用 faster-whisper。
- **VTT/SRT**：两种字幕文件格式，时间戳写法略不同（`.` vs `,` 分隔毫秒）。
- **Netscape Cookie 文件**：yt-dlp 认的 Cookie 格式，7 列 tab 分隔。

## 3. 从零推导

### 第一步：先理解用户粘贴了什么——分享口令解析

```python
# apps/api/app/modules/sources/extractors.py:453-472
def parse_share_input(raw: str) -> tuple[str, str]:
    """解析用户粘贴内容 → (URL, 可选标题)。支持纯链接与抖音「复制分享」整段口令。"""
    text = (raw or "").strip()
    if text.startswith(("http://", "https://")) and not re.search(r"\s", text):
        url = _clean_extracted_url(text)
        return url, ""
    urls = extract_urls_from_text(text)
    if not urls:
        raise ValueError("未识别到 http(s) 链接；请粘贴完整分享内容或直接粘贴网址")
    url = next((u for u in urls if looks_like_video_url(u)), urls[0])
    title = guess_title_from_share(text, url)
    return url, title
```

**为什么这样写**：把脏输入分层处理——整段文本里正则抽出所有 URL，优先选视频平台的（一段口令里可能有好几个链接），剩余文案拿来"猜标题"（喂给后续的归类）。短链（`v.douyin.com`）再用 httpx 跟跳拿到真实视频页，因为 yt-dlp 对短链常报 Unsupported URL。**对用户的脏输入宽容，产品就少了 80% 的"用不了"反馈。**

### 第二步：yt-dlp 拉字幕——按错误类型决策的重试

```python
# extractors.py:748-783（节选）
    for opts in _yt_dlp_option_sets(url):
        # 清理上次残留，避免误读旧字幕
        for old in work_dir.glob("sub*"):
            old.unlink()
        try:
            with yt_dlp.YoutubeDL(attempt) as ydl:
                ydl.download([url])
            break
        except Exception as exc:
            last_exc = str(exc)
            if _is_dpapi_error(last_exc) and browser in {"edge", "chrome"}:
                skip_chromium_cookies = True   # Windows 读浏览器 Cookie 的 DPAPI 坑
                continue
            if not _cookies_needed(last_exc):
                break                          # 非 Cookie 错误，不再浪费尝试
            continue
```

**设计解读**：
- **Python API 优先、CLI 兜底**：PyInstaller 打包后可自带 yt_dlp 模块；CLI 兼容手动安装场景。
- **重试不是盲目循环，而是按错误类型决策**：DPAPI 解密失败（Windows 读 Chrome Cookie 的经典坑）→ 跳过所有 chromium 系浏览器；非 Cookie 类错误 → 直接放弃。每一轮尝试前清理 `sub*` 残留文件，防止把上次失败的旧字幕误当成功。
- **Cookie 三级来源**：`KONGKU_YTDLP_COOKIES` 环境变量 → `data/yt-dlp-cookies.txt`（桌面端登录导出）→ 系统浏览器。**默认不读系统浏览器**是刻意决策：macOS 会弹钥匙串授权、Windows 触发 DPAPI——不惊扰用户优先。

### 第三步：没字幕怎么办——ASR 计划列表

```python
# apps/api/app/modules/sources/asr.py:432-487（节选）
def resolve_asr_plan(cfg: dict[str, str]) -> list[tuple[str, dict[str, str]]]:
    """返回 [(engine, params), ...]，engine 为 cloud|local。"""
    mode = (cfg.get("asr_mode") or "auto").strip().lower()
    if mode in {"off", "none", "disabled"}:
        return []
    ...
    # 独立 ASR Key 优先；否则尝试对话 Key（仅当接口支持转写）
    if not use_key and chat_key and cloud_asr_supported(chat_base):
        use_base, use_key = cloud_base or chat_base, chat_key
    ...
    if cloud_ok:
        plan.append(("cloud", {...}))
    plan.append(("local", {"model_size": local_model}))
    return plan
```

**为什么把"模式选择"做成纯函数**：输入配置、输出**按序尝试的引擎计划列表**，与执行完全分离。`off` 返回空列表（上层转 `need_transcript` 等用户补贴文案）；`auto` 是"云端优先、本地兜底"。凭证推断很务实——没配独立 ASR Key 就借用对话 Key，但先过能力检查：

```python
# asr.py:36-63（节选）
def cloud_asr_supported(base_url: str) -> bool:
    if "deepseek" in low:
        return False          # DeepSeek 没有音频端点，显式拉黑
    return any(n in low for n in ("openai.com", "siliconflow", "groq.com", ...)) \
        or low.endswith("/v1") or "/compatible-mode" in low

def default_cloud_asr_model(base_url: str) -> str:
    if "siliconflow" in low: return "FunAudioLLM/SenseVoiceSmall"
    if "groq" in low:        return "whisper-large-v3"
    return "whisper-1"
```

**为什么用 URL 关键字启发式**：OpenAI 兼容接口没有"能力发现"协议，无法问服务器"你支持转写吗"。启发式 + 可覆盖的默认值，让用户只填一个 Key 就能跑通——**对不完美的外部世界，先给一个大概率对的答案**。

### 第四步：本地 Whisper 的国内适配

```python
# asr.py:80-101（节选）
def configure_hf_hub(*, prefer_mirror: bool = False) -> None:
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "600")
    data_root = Path((os.environ.get("DATA_DIR") or "data"))
    os.environ.setdefault("HF_HOME", str(data_root / "huggingface"))
    ...
    if not endpoint:
        # 未配置时默认走国内镜像，避免 Mac 首次下载 Whisper 超时
        os.environ["HF_ENDPOINT"] = HF_MIRROR   # https://hf-mirror.com
        os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
```

**三个面向国内个人开发者的实事**：① 默认走 hf-mirror 镜像并关掉镜像不支持的 xet 协议；② 模型缓存统一定位到 `DATA_DIR/huggingface`（而非 `~/.cache`），桌面端与开发环境行为一致；③ 转写参数 `language="zh" + vad_filter + beam_size=1` 是速度优先的选择——个人知识库场景，快比对齐率更重要；zhconv 繁转简是可选增强。

### 第五步：平台风控的终局方案——桌面桥

```python
# asr.py:173-198（节选）
def _download_via_desktop_bridge(url: str, work_dir: Path) -> Path | None:
    """桌面端桥：用已登录 Electron 会话抓抖音媒体（绕过 yt-dlp 网页接口风控）。"""
    bridge = (os.environ.get("KONGKU_DESKTOP_BRIDGE") or "").strip().rstrip("/")
    if not bridge:
        return None
    if "douyin" not in url.lower() and "iesdouyin" not in url.lower():
        return None
    try:
        with httpx.Client(timeout=150.0, trust_env=False) as client:
            resp = client.post(f"{bridge}/douyin/fetch", json={"url": url, "out_dir": str(work_dir)})
    except Exception:
        return None
    ...
```

**设计解读**：yt-dlp 走网页接口会被抖音反爬，但 Electron 桌面端里有用户**真实登录的浏览器会话**。于是桌面端起一个本地 HTTP 服务（默认 18766），后端 POST url 过去，桌面端用自己的会话下载后回填文件路径（桌面端实现见功能点 12）。**所有失败路径静默返回 None**——桥是"增强"不是"依赖"，纯 API 部署（无桌面端）时整个机制自动隐身。调用时机也讲究：开头先试一次，yt-dlp 全部失败后再试一次（桥可能刚就绪）。

### 第六步：句级时间轴——跟读功能的数据源

```python
# apps/api/app/modules/sources/cues.py:11-32
@dataclass
class TimedCue:
    start: float  # 秒
    end: float
    text: str

def write_cues_file(path: Path, cues: list[TimedCue]) -> None:
    payload = {"version": 1, "cues": [c.to_dict() for c in cues]}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
```

**设计解读**：字幕/转写段落统一成 `TimedCue`（秒级起止 + 文本），落盘为带 `"version": 1` 的 JSON——**预留版本号是文件格式设计的廉价保险**，将来改结构时旧文件可识别。`cues_to_text` 把 cues 拼成正文写入 extracted.txt，两者同源——**保证跟读高亮的句子与入库检索的正文字字对应**。VTT/SRT 解析用一个正则同时吃两种格式（`[.,]` 分隔符 + 可选小时组），解析策略是"宽松跳过"而非严格报错：找不到 `-->` 跳过、`end < start` 钳位——字幕来源鱼龙混杂，宽松解析远比标准符合性重要。

## 4. 完整流程图

```
用户粘贴链接/口令
   │ parse_share_input：抽 URL、猜标题、短链跟跳
   ▼
yt-dlp 拉字幕（Python API → CLI 兜底；Cookie：环境变量→cookies.txt→浏览器）
   ├─ 成功 → cues.json + extracted.txt
   └─ 无字幕
        ▼
   下载音轨：桌面桥先试 → yt-dlp → 桌面桥再试（ffmpeg 由 imageio-ffmpeg 提供）
        ▼
   ASR 计划（auto = cloud → local）
        ├─ cloud：POST /audio/transcriptions（模型按 base_url 推断；无句级时间轴）
        └─ local：faster-whisper（HF 镜像下载；TimedCue 句级时间轴）
        ▼
   cues.json + extracted.txt → ready
   （全失败 → need_transcript，等用户补贴文案）
```

## 5. 关键文件与配置对照

| 文件 | 职责 |
|------|------|
| `apps/api/app/modules/sources/extractors.py` | 口令解析、yt-dlp 字幕/音轨 |
| `apps/api/app/modules/sources/asr.py` | ASR 计划、云端/本地转写、桌面桥回调 |
| `apps/api/app/modules/sources/cues.py` | TimedCue、VTT/SRT 解析、cues.json |
| `apps/desktop/electron/lib/douyin-bridge.cjs` | 桌面端 18766 桥（见功能点 12） |
| `apps/api/scripts/prefetch_whisper.py` | 预下载 Whisper 模型 |

| 配置项 | 位置 | 说明 |
|--------|------|------|
| `asr_mode`（auto/local/cloud/off） | 设置页 | 转写策略 |
| `asr_base_url / asr_api_key / asr_model` | 设置页 | 云端转写凭据（可借对话 Key） |
| `asr_local_model`（默认 base） | 设置页 | 本地 Whisper 模型规格 |
| `KONGKU_YTDLP_COOKIES` | 环境变量 | Cookie 文件（默认 `data/yt-dlp-cookies.txt`） |
| `KONGKU_DESKTOP_BRIDGE` | 桌面端注入 | 桌面桥地址（默认 `http://127.0.0.1:18766`） |
| `HF_ENDPOINT` | 环境变量 | 默认 `https://hf-mirror.com` |
| `KONGKU_FFMPEG` | 环境变量 | 指定 ffmpeg（否则用 imageio-ffmpeg 内置） |
