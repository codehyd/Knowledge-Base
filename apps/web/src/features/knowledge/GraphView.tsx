import { useCallback, useEffect, useMemo, useRef, useState, Component, type ReactNode } from "react";
import { Empty, Spin } from "antd";
import { api, type VaultGraph, type VaultGraphNode } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import styles from "./GraphView.module.css";

type GraphNode = VaultGraphNode & {
  id: string;
  phantom?: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

type GraphLink = {
  source: string;
  target: string;
  resolved: boolean;
  label: string;
  kind: string;
};

type GraphViewProps = {
  onOpenNode: (node: VaultGraphNode) => void;
  onError?: (msg: string) => void;
};

function kindColor(kind: string | undefined, selected: boolean, phantom: boolean): string {
  if (phantom) return "#cbd5e1";
  if (selected) return "#2a6f6a";
  switch (kind) {
    case "note":
      return "#3d8b84";
    case "book":
      return "#b45309";
    case "video":
      return "#7c3aed";
    case "url":
    case "web":
      return "#0369a1";
    case "category":
      return "#64748b";
    default:
      return "#475569";
  }
}

function kindLabel(kind: string | undefined): string {
  switch (kind) {
    case "note":
      return "笔记";
    case "book":
      return "书籍";
    case "video":
      return "视频";
    case "url":
    case "web":
      return "网页";
    case "category":
      return "分类";
    default:
      return "条目";
  }
}

class GraphErrorBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  render() {
    if (this.state.error) {
      return (
        <div className={styles.center}>
          <Empty
            description={
              <span>
                图谱渲染失败：{this.state.error}
                <br />
                <button type="button" className={styles.refreshBtn} onClick={this.props.onRetry}>
                  重试
                </button>
              </span>
            }
          />
        </div>
      );
    }
    return this.props.children;
  }
}

function buildGraphData(raw: VaultGraph): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = raw.nodes.map((n, i) => {
    const angle = (i / Math.max(raw.nodes.length, 1)) * Math.PI * 2;
    const r = 80 + (i % 5) * 18;
    return {
      ...n,
      id: n.id,
      phantom: false,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
      vx: 0,
      vy: 0,
    };
  });
  const known = new Set(nodes.map((n) => n.id));
  const links: GraphLink[] = [];
  let phantomIdx = 0;

  for (const e of raw.edges) {
    let targetId = e.target;
    if (!e.resolved) {
      targetId = `broken:${e.source}::${e.target}`;
      if (!known.has(targetId)) {
        known.add(targetId);
        const angle = phantomIdx++ * 0.9;
        nodes.push({
          id: targetId,
          title: e.label || e.target,
          path: e.target,
          source_id: null,
          degree: 0,
          phantom: true,
          x: Math.cos(angle) * 160,
          y: Math.sin(angle) * 160,
          vx: 0,
          vy: 0,
        });
      }
    }
    links.push({
      source: e.source,
      target: targetId,
      resolved: e.resolved,
      label: e.label || e.target,
      kind: e.kind || "wikilink",
    });
  }

  return { nodes, links };
}

function simStep(nodes: GraphNode[], links: GraphLink[], width: number, height: number) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cx = width / 2;
  const cy = height / 2;

  // repulsion
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let dist2 = dx * dx + dy * dy || 0.01;
      const dist = Math.sqrt(dist2);
      const force = 1200 / dist2;
      dx = (dx / dist) * force;
      dy = (dy / dist) * force;
      a.vx += dx;
      a.vy += dy;
      b.vx -= dx;
      b.vy -= dy;
    }
  }

  // springs
  for (const link of links) {
    const a = byId.get(link.source);
    const b = byId.get(link.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const ideal = link.resolved ? 110 : 140;
    const f = (dist - ideal) * 0.02;
    const fx = (dx / dist) * f;
    const fy = (dy / dist) * f;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  // center gravity + integrate
  for (const n of nodes) {
    n.vx += (cx - n.x) * 0.005;
    n.vy += (cy - n.y) * 0.005;
    n.vx *= 0.85;
    n.vy *= 0.85;
    n.x += n.vx;
    n.y += n.vy;
    n.x = Math.min(width - 24, Math.max(24, n.x));
    n.y = Math.min(height - 24, Math.max(24, n.y));
  }
}

function CanvasGraph({
  nodes,
  links,
  selectedId,
  width,
  height,
  onSelect,
}: {
  nodes: GraphNode[];
  links: GraphLink[];
  selectedId: string | null;
  width: number;
  height: number;
  onSelect: (id: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef(nodes);
  const linksRef = useRef(links);
  const selectedRef = useRef(selectedId);
  const dragRef = useRef<{ id: string; ox: number; oy: number } | null>(null);
  nodesRef.current = nodes;
  linksRef.current = links;
  selectedRef.current = selectedId;

  useEffect(() => {
    const cx = width / 2;
    const cy = height / 2;
    if (!nodes.length) return;
    const avgX = nodes.reduce((s, n) => s + n.x, 0) / nodes.length;
    const avgY = nodes.reduce((s, n) => s + n.y, 0) / nodes.length;
    const dx = cx - avgX;
    const dy = cy - avgY;
    if (Math.hypot(dx, dy) > 8) {
      for (const n of nodes) {
        n.x += dx;
        n.y += dy;
        n.vx = 0;
        n.vy = 0;
      }
    }
  }, [nodes, width, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width < 10 || height < 10) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let ticks = 0;

    const draw = () => {
      const ns = nodesRef.current;
      const ls = linksRef.current;
      if (ticks < 180) {
        simStep(ns, ls, width, height);
        ticks += 1;
      }
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#f7f9fa";
      ctx.fillRect(0, 0, width, height);

      const byId = new Map(ns.map((n) => [n.id, n]));
      for (const link of ls) {
        const a = byId.get(link.source);
        const b = byId.get(link.target);
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        const isCat = link.kind === "in_category";
        ctx.strokeStyle = !link.resolved ? "#cbd5e1" : isCat ? "#d1d5db" : "#94a3b8";
        ctx.lineWidth = link.resolved ? (isCat ? 1 : 1.4) : 1;
        if (!link.resolved || isCat) ctx.setLineDash([5, 4]);
        else ctx.setLineDash([]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const sel = selectedRef.current;
      for (const n of ns) {
        const isCat = n.kind === "category";
        const r = n.phantom
          ? 5
          : isCat
            ? 7
            : 6 + Math.min(7, (n.degree || 0) * 0.55);
        ctx.beginPath();
        if (isCat) {
          const s = r * 1.2;
          ctx.rect(n.x - s, n.y - s, s * 2, s * 2);
        } else {
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        }
        ctx.fillStyle = kindColor(n.kind, n.id === sel, Boolean(n.phantom));
        ctx.fill();
        if (n.id === sel) {
          ctx.strokeStyle = "#1f5450";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        const label = n.title || n.path;
        const text = label.length > 16 ? `${label.slice(0, 16)}…` : label;
        ctx.font = '12px "IBM Plex Sans", "PingFang SC", sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = n.phantom ? "#94a3b8" : "#334155";
        ctx.fillText(text, n.x, n.y + r + 4);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [width, height]);

  const hitTest = (x: number, y: number) => {
    let best: GraphNode | null = null;
    let bestD = 16;
    for (const n of nodesRef.current) {
      const d = Math.hypot(n.x - x, n.y - y);
      const r = n.phantom ? 8 : 10 + Math.min(7, (n.degree || 0) * 0.55);
      if (d <= r + 4 && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  };

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={styles.canvasEl}
      onPointerDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const hit = hitTest(x, y);
        if (hit) {
          onSelect(hit.id);
          dragRef.current = { id: hit.id, ox: x - hit.x, oy: y - hit.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        } else {
          onSelect(null);
        }
      }}
      onPointerMove={(e) => {
        const drag = dragRef.current;
        if (!drag) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const node = nodesRef.current.find((n) => n.id === drag.id);
        if (!node) return;
        node.x = x - drag.ox;
        node.y = y - drag.oy;
        node.vx = 0;
        node.vy = 0;
      }}
      onPointerUp={() => {
        dragRef.current = null;
      }}
    />
  );
}

export function GraphView({ onOpenNode, onError }: GraphViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<VaultGraph | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getVaultGraph();
      setData(res);
    } catch (err) {
      onError?.(formatError(err));
      setData({ nodes: [], edges: [], broken_links: [] });
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh, nonce]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({
        w: Math.max(320, Math.floor(rect.width)),
        h: Math.max(420, Math.floor(rect.height || 480)),
      });
    };
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading, data]);

  const graphData = useMemo(() => {
    if (!data) return { nodes: [] as GraphNode[], links: [] as GraphLink[] };
    return buildGraphData(data);
  }, [data]);

  const selected = useMemo(
    () => graphData.nodes.find((n) => n.id === selectedId) || null,
    [graphData.nodes, selectedId],
  );

  const neighbors = useMemo(() => {
    if (!selected || selected.phantom) return { out: [] as GraphLink[], back: [] as GraphLink[] };
    const out = graphData.links.filter((l) => l.source === selected.id);
    const back = graphData.links.filter((l) => l.target === selected.id && l.resolved);
    return { out, back };
  }, [graphData.links, selected]);

  const canvasW = Math.max(280, size.w - (selected ? 260 : 0));
  const canvasH = Math.max(400, size.h);

  return (
    <div className={styles.wrap} ref={wrapRef}>
      {loading ? (
        <div className={styles.center}>
          <Spin tip="构建知识关系图…" />
        </div>
      ) : !graphData.nodes.length ? (
        <div className={styles.center}>
          <Empty
            description={
              <span>
                知识库还没有可展示的内容。入库书籍 / 视频 / 笔记后，或在正文里写{" "}
                <code>[[名称]]</code>，这里会显示关系图。
              </span>
            }
          />
        </div>
      ) : (
        <GraphErrorBoundary onRetry={() => setNonce((n) => n + 1)}>
          <div className={styles.body}>
            <div className={styles.canvas}>
              {canvasW > 0 && canvasH > 0 ? (
                <CanvasGraph
                  key={`${nonce}-${graphData.nodes.length}-${canvasW}x${canvasH}`}
                  nodes={graphData.nodes}
                  links={graphData.links}
                  selectedId={selectedId}
                  width={canvasW}
                  height={canvasH}
                  onSelect={setSelectedId}
                />
              ) : null}
              <div className={styles.hud}>
                <span>
                  {graphData.nodes.filter((n) => !n.phantom && n.kind !== "category").length} 条知识
                </span>
                <span>
                  {graphData.nodes.filter((n) => n.kind === "category").length} 个分类
                </span>
                <span>
                  {graphData.links.filter((l) => l.resolved && l.kind === "wikilink").length} 条双链
                </span>
                <span>
                  {graphData.links.filter((l) => l.resolved && l.kind === "in_category").length}{" "}
                  条分类关系
                </span>
                {(data?.broken_links.length || 0) > 0 ? (
                  <span className={styles.hudWarn}>{data?.broken_links.length} 条断链</span>
                ) : null}
                <span className={styles.hudLegend}>
                  <i data-k="note" />笔记 <i data-k="book" />书 <i data-k="video" />视频{" "}
                  <i data-k="url" />网页 <i data-k="category" />分类
                </span>
                <button type="button" className={styles.refreshBtn} onClick={() => void refresh()}>
                  刷新
                </button>
              </div>
            </div>

            {selected ? (
              <aside className={styles.side}>
                <h3 className={styles.sideTitle}>{selected.title}</h3>
                <p className={styles.sidePath}>
                  {kindLabel(selected.kind)}
                  {selected.path ? ` · ${selected.path}` : ""}
                </p>
                {selected.phantom ? (
                  <p className={styles.sideHint}>断链目标：库中尚无对应条目</p>
                ) : (
                  <>
                    <p className={styles.sideMeta}>连接度 {selected.degree}</p>
                    {selected.kind === "category" ? (
                      <button
                        type="button"
                        className={styles.openBtn}
                        onClick={() => onOpenNode(selected)}
                      >
                        在列表中查看分类
                      </button>
                    ) : selected.kind === "note" && selected.source_id ? (
                      <button
                        type="button"
                        className={styles.openBtn}
                        onClick={() => onOpenNode(selected)}
                      >
                        打开笔记
                      </button>
                    ) : selected.entry_id || selected.source_id ? (
                      <button
                        type="button"
                        className={styles.openBtn}
                        onClick={() => onOpenNode(selected)}
                      >
                        在知识库中打开
                      </button>
                    ) : (
                      <p className={styles.sideHint}>无法定位到知识条目</p>
                    )}
                    <div className={styles.linkBlock}>
                      <h4>出链</h4>
                      {neighbors.out.length === 0 ? (
                        <p className={styles.sideHint}>无</p>
                      ) : (
                        <ul>
                          {neighbors.out.map((l) => {
                            const title =
                              graphData.nodes.find((n) => n.id === l.target)?.title || l.label;
                            return (
                              <li key={`${l.source}-${l.target}`}>
                                <button type="button" onClick={() => setSelectedId(l.target)}>
                                  {title}
                                  {l.kind === "in_category"
                                    ? "（分类）"
                                    : !l.resolved
                                      ? "（断）"
                                      : ""}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                    <div className={styles.linkBlock}>
                      <h4>回链</h4>
                      {neighbors.back.length === 0 ? (
                        <p className={styles.sideHint}>无</p>
                      ) : (
                        <ul>
                          {neighbors.back.map((l) => {
                            const title =
                              graphData.nodes.find((n) => n.id === l.source)?.title || l.source;
                            return (
                              <li key={`${l.source}-${l.target}-back`}>
                                <button type="button" onClick={() => setSelectedId(l.source)}>
                                  {title}
                                  {l.kind === "in_category" ? "（分类）" : ""}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  </>
                )}
              </aside>
            ) : null}
          </div>
        </GraphErrorBoundary>
      )}
    </div>
  );
}
