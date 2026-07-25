import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PauseCircleOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { App, Button, Empty, Spin, Typography } from "antd";
import { api, type TimedCue } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import styles from "./FollowAlongPlayer.module.css";

type Props = {
  sourceId: number;
  title?: string;
  compact?: boolean;
};

const PROGRESS_PREFIX = "kongku:follow-along:";
/** 距结尾不足该秒数视为读完，下次从头开始 */
const END_EPS = 1.5;
/** 节流写入进度，避免 timeupdate 过于频繁 */
const SAVE_INTERVAL_MS = 800;

function progressKey(sourceId: number) {
  return `${PROGRESS_PREFIX}${sourceId}`;
}

function loadProgress(sourceId: number): number {
  try {
    const raw = localStorage.getItem(progressKey(sourceId));
    if (!raw) return 0;
    const t = Number(raw);
    return Number.isFinite(t) && t > 0 ? t : 0;
  } catch {
    return 0;
  }
}

function saveProgress(sourceId: number, t: number, duration?: number) {
  try {
    if (!Number.isFinite(t) || t <= 0) {
      localStorage.removeItem(progressKey(sourceId));
      return;
    }
    if (duration && Number.isFinite(duration) && duration > 0 && t >= duration - END_EPS) {
      localStorage.removeItem(progressKey(sourceId));
      return;
    }
    localStorage.setItem(progressKey(sourceId), String(Math.floor(t * 10) / 10));
  } catch {
    /* 隐私模式等忽略 */
  }
}

function clearProgress(sourceId: number) {
  try {
    localStorage.removeItem(progressKey(sourceId));
  } catch {
    /* ignore */
  }
}

function formatTime(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function FollowAlongPlayer({ sourceId, title, compact = false }: Props) {
  const { message } = App.useApp();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const restoredRef = useRef(false);
  const lastSaveRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [cues, setCues] = useState<TimedCue[]>([]);
  const [mediaUrl, setMediaUrl] = useState("");
  const [hasMedia, setHasMedia] = useState(false);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [resumeHint, setResumeHint] = useState(0);

  useEffect(() => {
    let cancelled = false;
    restoredRef.current = false;
    lastSaveRef.current = 0;
    setLoading(true);
    setCurrent(0);
    setActiveIdx(-1);
    setResumeHint(0);
    void (async () => {
      try {
        const res = await api.getSourceCues(sourceId);
        if (cancelled) return;
        setCues(res.cues || []);
        setHasMedia(Boolean(res.has_media));
        setMediaUrl(res.has_media ? api.sourceMediaUrl(sourceId) : "");
        const saved = loadProgress(sourceId);
        if (saved > 0) setResumeHint(saved);
      } catch (err) {
        if (!cancelled) {
          setCues([]);
          setHasMedia(false);
          setMediaUrl("");
          message.error(formatError(err, "加载跟读数据失败"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      const el = audioRef.current;
      if (el && !el.paused) {
        saveProgress(sourceId, el.currentTime, el.duration);
      } else if (el) {
        saveProgress(sourceId, el.currentTime, el.duration);
      }
      el?.pause();
    };
  }, [message, sourceId]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIdx]);

  function syncActive(t: number) {
    if (!cues.length) {
      setActiveIdx(-1);
      return;
    }
    let idx = -1;
    for (let i = 0; i < cues.length; i += 1) {
      const c = cues[i];
      if (t >= c.start && t < Math.max(c.end, c.start + 0.05)) {
        idx = i;
        break;
      }
      if (t >= c.start) idx = i;
    }
    setActiveIdx(idx);
  }

  function applySavedProgress(el: HTMLAudioElement) {
    if (restoredRef.current) return;
    const saved = loadProgress(sourceId);
    restoredRef.current = true;
    if (saved <= 0) return;
    const dur = el.duration;
    if (Number.isFinite(dur) && dur > 0) {
      if (saved >= dur - END_EPS) {
        clearProgress(sourceId);
        setResumeHint(0);
        return;
      }
      el.currentTime = Math.min(saved, Math.max(0, dur - 0.25));
    } else {
      el.currentTime = saved;
    }
    const t = el.currentTime;
    setCurrent(t);
    setResumeHint(t);
    syncActive(t);
  }

  function persistNow(el: HTMLAudioElement, force = false) {
    const now = Date.now();
    if (!force && now - lastSaveRef.current < SAVE_INTERVAL_MS) return;
    lastSaveRef.current = now;
    saveProgress(sourceId, el.currentTime, el.duration);
  }

  function togglePlay() {
    const el = audioRef.current;
    if (!el || !mediaUrl) return;
    if (el.paused) {
      void el.play().catch(() => message.warning("无法播放音轨"));
    } else {
      el.pause();
    }
  }

  function seekTo(cue: TimedCue, idx: number) {
    const el = audioRef.current;
    if (!el || !mediaUrl) return;
    el.currentTime = Math.max(0, cue.start);
    setActiveIdx(idx);
    setCurrent(cue.start);
    persistNow(el, true);
    void el.play().catch(() => undefined);
  }

  if (loading) {
    return (
      <div className={styles.loading}>
        <Spin size="small" />
      </div>
    );
  }

  // 没有本地音轨：不渲染播放器，避免误点
  if (!hasMedia || !mediaUrl) {
    return (
      <div className={styles.empty}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span>
              本条没有可播放的本地音轨，因此无法跟读播放。请先在{" "}
              <Link to="/settings">设置 → AI</Link>{" "}
              开启「允许下载音轨到本机」，再到喂养页对该视频点「重试」。
            </span>
          }
        />
      </div>
    );
  }

  return (
    <div className={`${styles.wrap}${compact ? ` ${styles.compact}` : ""}`}>
      <audio
        ref={audioRef}
        src={mediaUrl}
        preload="metadata"
        onLoadedMetadata={(e) => applySavedProgress(e.currentTarget)}
        onCanPlay={(e) => applySavedProgress(e.currentTarget)}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          const t = el.currentTime;
          setCurrent(t);
          syncActive(t);
          persistNow(el);
        }}
        onPlay={() => setPlaying(true)}
        onPause={(e) => {
          setPlaying(false);
          persistNow(e.currentTarget, true);
        }}
        onEnded={() => {
          setPlaying(false);
          setActiveIdx(-1);
          clearProgress(sourceId);
          setResumeHint(0);
        }}
      />

      <div className={styles.controls}>
        <Button
          type="primary"
          icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
          onClick={togglePlay}
        >
          {playing ? "暂停" : resumeHint > 1 ? "继续跟读" : "跟读播放"}
        </Button>
        <Typography.Text type="secondary" className={styles.time}>
          {formatTime(current)}
          {title ? ` · ${title}` : ""}
          {!playing && resumeHint > 1 && current < 0.5
            ? ` · 上次到 ${formatTime(resumeHint)}`
            : ""}
        </Typography.Text>
      </div>

      <div className={styles.cues}>
        {cues.length === 0 ? (
          <Typography.Text type="secondary">
            已有音轨，但没有句级时间轴（云端转写可能不带时间戳）。仍可播放；若要高亮跟读，请改用本地 Whisper 后重试。
          </Typography.Text>
        ) : (
          cues.map((cue, idx) => (
            <button
              key={`${cue.start}-${idx}`}
              ref={idx === activeIdx ? activeRef : undefined}
              type="button"
              className={`${styles.cue}${idx === activeIdx ? ` ${styles.cueActive}` : ""}`}
              onClick={() => seekTo(cue, idx)}
            >
              <span className={styles.cueTime}>{formatTime(cue.start)}</span>
              <span className={styles.cueText}>{cue.text}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
