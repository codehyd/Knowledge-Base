import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Component,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Empty, Spin } from "antd";
import { api, type VaultGraph, type VaultGraphNode } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import styles from "./GraphView.module.css";

type GraphNode = VaultGraphNode & {
  id: string;
  phantom?: boolean;
  /** 双链连通分量（分类边不参与），用于散开无关节点 */
  compId: number;
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

/** 并查集：仅双链（+断链附着）决定「是否关联」；分类边不粘合无关节点 */
function assignComponents(nodes: GraphNode[], links: GraphLink[]) {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    if (!parent.has(x)) parent.set(x, x);
    while (p !== (parent.get(p) ?? p)) {
      const gp = parent.get(p) ?? p;
      parent.set(p, parent.get(gp) ?? gp);
      p = parent.get(p) ?? p;
    }
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const n of nodes) parent.set(n.id, n.id);
  for (const l of links) {
    if (l.kind === "in_category") continue;
    if (l.resolved || l.target.startsWith("broken:")) {
      union(l.source, l.target);
    }
  }

  const rootIndex = new Map<string, number>();
  let next = 0;
  for (const n of nodes) {
    const root = find(n.id);
    if (!rootIndex.has(root)) rootIndex.set(root, next++);
    n.compId = rootIndex.get(root)!;
  }
  return next;
}

/** Obsidian 风格初置：簇按圆周散开，孤立点落在更外圈 */
function layoutLikeObsidian(nodes: GraphNode[]) {
  const byComp = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const list = byComp.get(n.compId) || [];
    list.push(n);
    byComp.set(n.compId, list);
  }
  const comps = [...byComp.entries()].sort((a, b) => b[1].length - a[1].length);
  const clusters = comps.filter(([, ns]) => ns.length > 1);
  const isolates = comps.filter(([, ns]) => ns.length === 1);

  const clusterOrbit = 260 + Math.max(0, clusters.length - 1) * 36;
  clusters.forEach(([, ns], i) => {
    const angle =
      (i / Math.max(clusters.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const cx = Math.cos(angle) * clusterOrbit;
    const cy = Math.sin(angle) * clusterOrbit;
    const localR = 36 + Math.sqrt(ns.length) * 18;
    ns.forEach((n, j) => {
      const a2 = (j / Math.max(ns.length, 1)) * Math.PI * 2 + i * 0.35;
      const jitter = 8 + (j % 3) * 6;
      n.x = cx + Math.cos(a2) * (localR + jitter);
      n.y = cy + Math.sin(a2) * (localR + jitter);
      n.vx = 0;
      n.vy = 0;
    });
  });

  const isoOrbit = clusterOrbit + 200 + Math.min(isolates.length, 24) * 4;
  isolates.forEach(([, ns], i) => {
    const angle =
      (i / Math.max(isolates.length, 1)) * Math.PI * 2 + 0.4;
    // 外圈再按层错开，避免孤立点叠成一圈粥
    const ring = isoOrbit + (i % 3) * 48;
    ns[0].x = Math.cos(angle) * ring;
    ns[0].y = Math.sin(angle) * ring;
    ns[0].vx = 0;
    ns[0].vy = 0;
  });
}

function buildGraphData(raw: VaultGraph): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = raw.nodes.map((n) => ({
    ...n,
    id: n.id,
    phantom: false,
    compId: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
  }));
  const known = new Set(nodes.map((n) => n.id));
  const links: GraphLink[] = [];

  for (const e of raw.edges) {
    let targetId = e.target;
    if (!e.resolved) {
      targetId = `broken:${e.source}::${e.target}`;
      if (!known.has(targetId)) {
        known.add(targetId);
        nodes.push({
          id: targetId,
          title: e.label || e.target,
          path: e.target,
          source_id: null,
          degree: 0,
          phantom: true,
          compId: 0,
          x: 0,
          y: 0,
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

  assignComponents(nodes, links);
  layoutLikeObsidian(nodes);
  return { nodes, links };
}

function simStep(nodes: GraphNode[], links: GraphLink[], _width: number, _height: number) {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // 分量质心
  const centroids = new Map<number, { x: number; y: number; n: number }>();
  for (const n of nodes) {
    const c = centroids.get(n.compId) || { x: 0, y: 0, n: 0 };
    c.x += n.x;
    c.y += n.y;
    c.n += 1;
    centroids.set(n.compId, c);
  }
  for (const c of centroids.values()) {
    c.x /= c.n;
    c.y /= c.n;
  }

  // 簇与簇互相推开（Obsidian：无关子图分开）
  const comps = [...centroids.entries()];
  for (let i = 0; i < comps.length; i += 1) {
    for (let j = i + 1; j < comps.length; j += 1) {
      const [idA, ca] = comps[i];
      const [idB, cb] = comps[j];
      let dx = ca.x - cb.x;
      let dy = ca.y - cb.y;
      const dist2 = dx * dx + dy * dy || 0.01;
      const dist = Math.sqrt(dist2);
      const minDist = 220 + Math.min(ca.n, 12) * 8 + Math.min(cb.n, 12) * 8;
      if (dist >= minDist) continue;
      const push = ((minDist - dist) / minDist) * 0.35;
      dx = (dx / dist) * push;
      dy = (dy / dist) * push;
      for (const n of nodes) {
        if (n.compId === idA) {
          n.vx += dx;
          n.vy += dy;
        } else if (n.compId === idB) {
          n.vx -= dx;
          n.vy -= dy;
        }
      }
    }
  }

  // 点排斥：更强，并对不同分量额外加力
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      const dist2 = dx * dx + dy * dy || 0.01;
      const dist = Math.sqrt(dist2);
      const same = a.compId === b.compId;
      const charge = same ? 2800 : 7200;
      let force = charge / dist2;
      if (force > 8) force = 8;
      // 软碰撞：过近再顶开一点
      if (dist < 28) force += (28 - dist) * 0.08;
      dx = (dx / dist) * force;
      dy = (dy / dist) * force;
      a.vx += dx;
      a.vy += dy;
      b.vx -= dx;
      b.vy -= dy;
    }
  }

  // 弹簧：双链紧、分类边很长很弱（只作视觉提示，不把无关点粘成一团）
  for (const link of links) {
    const a = byId.get(link.source);
    const b = byId.get(link.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const isCat = link.kind === "in_category";
    const ideal = isCat ? 240 : link.resolved ? 95 : 130;
    const k = isCat ? 0.004 : 0.035;
    const f = (dist - ideal) * k;
    const fx = (dx / dist) * f;
    const fy = (dy / dist) * f;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  // 弱全局向心 + 分量内聚；孤立点几乎不向中心吸
  for (const n of nodes) {
    const c = centroids.get(n.compId);
    const size = c?.n ?? 1;
    if (c && size > 1) {
      n.vx += (c.x - n.x) * 0.018;
      n.vy += (c.y - n.y) * 0.018;
    }
    const globalG = size === 1 ? 0.0002 : 0.0006;
    n.vx += (0 - n.x) * globalG;
    n.vy += (0 - n.y) * globalG;
    n.vx *= 0.86;
    n.vy *= 0.86;
    n.x += n.vx;
    n.y += n.vy;
  }
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.2;

type ViewTransform = { tx: number; ty: number; scale: number };

function clampZoom(scale: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

/** 选中节点的一跳邻居（含自身） */
function focusNeighborhood(selectedId: string | null, links: GraphLink[]): Set<string> | null {
  if (!selectedId) return null;
  const ids = new Set<string>([selectedId]);
  for (const l of links) {
    if (l.source === selectedId) ids.add(l.target);
    if (l.target === selectedId) ids.add(l.source);
  }
  return ids;
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  nodeR: number,
  scale: number,
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const tipX = x2 - ux * (nodeR + 2);
  const tipY = y2 - uy * (nodeR + 2);
  const ah = 8 / scale;
  const aw = 5 / scale;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - ux * ah - uy * aw, tipY - uy * ah + ux * aw);
  ctx.lineTo(tipX - ux * ah + uy * aw, tipY - uy * ah - ux * aw);
  ctx.closePath();
  ctx.fill();
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
  const focusRef = useRef<Set<string> | null>(null);
  const viewRef = useRef<ViewTransform>({ tx: 0, ty: 0, scale: 1 });
  const userViewRef = useRef(false);
  /** 点选聚焦已完成：禁止布局结束后再次自动 fit，避免「先偏再居中」 */
  const focusSettledRef = useRef(false);
  const sizeRef = useRef({ w: width, h: height });
  sizeRef.current = { w: width, h: height };
  const [zoomPct, setZoomPct] = useState(100);
  const [focusCount, setFocusCount] = useState(0);
  const dragRef = useRef<
    | { mode: "node"; id: string; ox: number; oy: number }
    | { mode: "pan"; x: number; y: number; tx: number; ty: number }
    | null
  >(null);
  nodesRef.current = nodes;
  linksRef.current = links;
  selectedRef.current = selectedId;
  focusRef.current = focusNeighborhood(selectedId, links);

  const syncZoomLabel = useCallback(() => {
    setZoomPct(Math.round(viewRef.current.scale * 100));
  }, []);

  const applyZoomAt = useCallback(
    (screenX: number, screenY: number, nextScale: number, fromUser = true) => {
      const view = viewRef.current;
      const scale = clampZoom(nextScale);
      if (scale === view.scale) return;
      if (fromUser) userViewRef.current = true;
      const wx = (screenX - view.tx) / view.scale;
      const wy = (screenY - view.ty) / view.scale;
      view.scale = scale;
      view.tx = screenX - wx * scale;
      view.ty = screenY - wy * scale;
      syncZoomLabel();
    },
    [syncZoomLabel],
  );

  const fitView = useCallback(
    (fromUser = true, onlyIds: Set<string> | null = null) => {
      const ns = nodesRef.current;
      const { w, h } = sizeRef.current;
      const subset = onlyIds ? ns.filter((n) => onlyIds.has(n.id)) : ns;
      const targets = subset.length ? subset : ns;
      if (!targets.length || w < 10 || h < 10) return;
      if (fromUser) userViewRef.current = true;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of targets) {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x);
        maxY = Math.max(maxY, n.y);
      }
      // 单点或极少邻居时给最小包围盒，避免缩放过猛
      if (maxX - minX < 80) {
        const mid = (minX + maxX) / 2;
        minX = mid - 40;
        maxX = mid + 40;
      }
      if (maxY - minY < 80) {
        const mid = (minY + maxY) / 2;
        minY = mid - 40;
        maxY = mid + 40;
      }
      const pad = onlyIds ? 72 : 56;
      const bw = Math.max(maxX - minX, 40);
      const bh = Math.max(maxY - minY, 40);
      const maxScale = onlyIds ? 2.4 : 1.5;
      const scale = clampZoom(Math.min((w - pad * 2) / bw, (h - pad * 2) / bh, maxScale));
      viewRef.current = {
        scale,
        tx: w / 2 - ((minX + maxX) / 2) * scale,
        ty: h / 2 - ((minY + maxY) / 2) * scale,
      };
      syncZoomLabel();
    },
    [syncZoomLabel],
  );

  // 仅在 selectedId 变化时聚焦一次；等侧栏改宽完成后再取景，避免左右跳 + 数秒后再居中
  const prevSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    const focus = focusNeighborhood(selectedId, links);
    setFocusCount(focus ? Math.max(0, focus.size - 1) : 0);
    const prev = prevSelectedRef.current;
    if (prev === selectedId) return;
    prevSelectedRef.current = selectedId;

    if (!selectedId || !focus) {
      focusSettledRef.current = false;
      if (prev && !selectedId) {
        const t = window.setTimeout(() => fitView(false, null), 150);
        return () => window.clearTimeout(t);
      }
      return;
    }

    focusSettledRef.current = false;
    // 冻结节点速度，聚焦过程中不再漂移
    for (const n of nodesRef.current) {
      n.vx = 0;
      n.vy = 0;
    }
    const t = window.setTimeout(() => {
      fitView(false, focus);
      focusSettledRef.current = true;
      userViewRef.current = true;
    }, 150);
    return () => window.clearTimeout(t);
  }, [selectedId, links, fitView]);

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
    // 仅在图谱数据变更时重置视口
    userViewRef.current = false;
    focusSettledRef.current = false;
    viewRef.current = { tx: 0, ty: 0, scale: 1 };
    syncZoomLabel();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 刻意忽略 width/height
  }, [nodes, syncZoomLabel]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width < 10 || height < 10) return;

    const onWheelNative = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / Math.max(rect.width, 1);
      const sy = canvas.height / Math.max(rect.height, 1);
      const x = (ev.clientX - rect.left) * sx;
      const y = (ev.clientY - rect.top) * sy;
      const fine = Math.abs(ev.deltaY) < 40;
      const f = fine
        ? ev.deltaY < 0
          ? 1.08
          : 1 / 1.08
        : ev.deltaY < 0
          ? ZOOM_STEP
          : 1 / ZOOM_STEP;
      applyZoomAt(x, y, viewRef.current.scale * f);
    };
    canvas.addEventListener("wheel", onWheelNative, { passive: false });

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      canvas.removeEventListener("wheel", onWheelNative);
      return;
    }
    let raf = 0;
    let ticks = 0;
    let didFit = false;

    const draw = () => {
      const ns = nodesRef.current;
      const ls = linksRef.current;
      const view = viewRef.current;
      const sel = selectedRef.current;
      const focus = focusRef.current;
      const focusing = Boolean(focus && sel);
      // 点选聚焦时暂停力导向，避免节点继续漂、随后又被二次 fit
      if (ticks < 320 && !sel) {
        simStep(ns, ls, width, height);
        ticks += 1;
      } else if (!didFit && ticks >= 320) {
        didFit = true;
        if (!userViewRef.current && !focusSettledRef.current && !sel) {
          fitView(false, null);
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#f7f9fa";
      ctx.fillRect(0, 0, width, height);

      ctx.setTransform(view.scale, 0, 0, view.scale, view.tx, view.ty);

      const byId = new Map(ns.map((n) => [n.id, n]));

      const dimLinks: GraphLink[] = [];
      const hotLinks: GraphLink[] = [];
      for (const link of ls) {
        const hot =
          focusing &&
          (link.source === sel || link.target === sel);
        (hot ? hotLinks : dimLinks).push(link);
      }

      const strokeLink = (link: GraphLink, hot: boolean) => {
        const a = byId.get(link.source);
        const b = byId.get(link.target);
        if (!a || !b) return;
        const isCat = link.kind === "in_category";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        if (hot) {
          ctx.strokeStyle = !link.resolved ? "#f59e0b" : isCat ? "#64748b" : "#2a6f6a";
          ctx.lineWidth = (isCat ? 2 : 2.6) / view.scale;
          ctx.globalAlpha = 1;
        } else if (focusing) {
          ctx.strokeStyle = "#cbd5e1";
          ctx.lineWidth = 1 / view.scale;
          ctx.globalAlpha = 0.18;
        } else {
          ctx.strokeStyle = !link.resolved ? "#cbd5e1" : isCat ? "#d1d5db" : "#94a3b8";
          ctx.lineWidth = (link.resolved ? (isCat ? 1 : 1.4) : 1) / view.scale;
          ctx.globalAlpha = 1;
        }
        if (!link.resolved || isCat) ctx.setLineDash([5 / view.scale, 4 / view.scale]);
        else ctx.setLineDash([]);
        ctx.stroke();
        ctx.setLineDash([]);
        if (hot && link.resolved && !isCat) {
          ctx.fillStyle = "#2a6f6a";
          const tr = b.phantom ? 5 : b.kind === "category" ? 7 : 6 + Math.min(7, (b.degree || 0) * 0.55);
          drawArrow(ctx, a.x, a.y, b.x, b.y, tr, view.scale);
        }
        ctx.globalAlpha = 1;
      };

      for (const link of dimLinks) strokeLink(link, false);
      for (const link of hotLinks) strokeLink(link, true);

      const showLabels = focusing || view.scale >= 0.45;
      const fontPx = Math.max(10, Math.min(15, (focusing ? 13 : 12) / Math.sqrt(view.scale)));
      // 先画非焦点，再画焦点，保证关联节点在上层
      const ordered = focusing
        ? [...ns].sort((a, b) => {
            const af = focus!.has(a.id) ? 1 : 0;
            const bf = focus!.has(b.id) ? 1 : 0;
            if (af !== bf) return af - bf;
            if (a.id === sel) return 1;
            if (b.id === sel) return -1;
            return 0;
          })
        : ns;

      for (const n of ordered) {
        const isCat = n.kind === "category";
        const inFocus = !focusing || focus!.has(n.id);
        const isSel = n.id === sel;
        let r = n.phantom
          ? 5
          : isCat
            ? 7
            : 6 + Math.min(7, (n.degree || 0) * 0.55);
        if (isSel) r += 2;
        else if (inFocus && focusing) r += 1;

        ctx.globalAlpha = inFocus ? 1 : 0.14;
        ctx.beginPath();
        if (isCat) {
          const s = r * 1.2;
          ctx.rect(n.x - s, n.y - s, s * 2, s * 2);
        } else {
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        }
        ctx.fillStyle = kindColor(n.kind, isSel, Boolean(n.phantom));
        ctx.fill();

        if (isSel) {
          ctx.strokeStyle = "#1f5450";
          ctx.lineWidth = 2.5 / view.scale;
          ctx.stroke();
          // 外圈光晕，突出当前焦点
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 5, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(42, 111, 106, 0.35)";
          ctx.lineWidth = 3 / view.scale;
          ctx.stroke();
        } else if (inFocus && focusing) {
          ctx.strokeStyle = "rgba(42, 111, 106, 0.55)";
          ctx.lineWidth = 1.5 / view.scale;
          ctx.stroke();
        }

        const drawLabel = showLabels && (inFocus || !focusing);
        if (drawLabel) {
          const label = n.title || n.path;
          const maxLen = focusing && inFocus ? 22 : view.scale < 0.7 ? 10 : 16;
          const text = label.length > maxLen ? `${label.slice(0, maxLen)}…` : label;
          ctx.font = `${isSel ? "600 " : ""}${fontPx}px "IBM Plex Sans", "PingFang SC", sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = n.phantom ? "#94a3b8" : isSel ? "#0f172a" : "#334155";
          ctx.fillText(text, n.x, n.y + r + 4);
        }
        ctx.globalAlpha = 1;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("wheel", onWheelNative);
    };
  }, [width, height, applyZoomAt, fitView]);

  const canvasPoint = (
    e: Pick<ReactPointerEvent<HTMLCanvasElement>, "currentTarget" | "clientX" | "clientY">,
  ) => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / Math.max(rect.width, 1);
    const sy = canvas.height / Math.max(rect.height, 1);
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
    };
  };

  const toWorld = (screenX: number, screenY: number) => {
    const { tx, ty, scale } = viewRef.current;
    return { x: (screenX - tx) / scale, y: (screenY - ty) / scale };
  };

  const hitTest = (worldX: number, worldY: number) => {
    const scale = viewRef.current.scale;
    const focus = focusRef.current;
    let best: GraphNode | null = null;
    let bestScore = Infinity;
    for (const n of nodesRef.current) {
      const d = Math.hypot(n.x - worldX, n.y - worldY);
      const r = n.phantom ? 8 : 10 + Math.min(7, (n.degree || 0) * 0.55);
      if (d > r + 14 / scale) continue;
      // 聚焦时优先点中关联节点
      const score = d - (focus?.has(n.id) ? 4 / scale : 0);
      if (score < bestScore) {
        best = n;
        bestScore = score;
      }
    }
    return best;
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className={styles.canvasEl}
        onPointerDown={(e: ReactPointerEvent<HTMLCanvasElement>) => {
          const { x, y } = canvasPoint(e);
          const world = toWorld(x, y);
          const hit = hitTest(world.x, world.y);
          if (hit) {
            onSelect(hit.id);
            dragRef.current = {
              mode: "node",
              id: hit.id,
              ox: world.x - hit.x,
              oy: world.y - hit.y,
            };
          } else {
            onSelect(null);
            dragRef.current = {
              mode: "pan",
              x,
              y,
              tx: viewRef.current.tx,
              ty: viewRef.current.ty,
            };
          }
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e: ReactPointerEvent<HTMLCanvasElement>) => {
          const drag = dragRef.current;
          if (!drag) return;
          const { x, y } = canvasPoint(e);
          if (drag.mode === "pan") {
            userViewRef.current = true;
            viewRef.current.tx = drag.tx + (x - drag.x);
            viewRef.current.ty = drag.ty + (y - drag.y);
            return;
          }
          const world = toWorld(x, y);
          const node = nodesRef.current.find((n) => n.id === drag.id);
          if (!node) return;
          node.x = world.x - drag.ox;
          node.y = world.y - drag.oy;
          node.vx = 0;
          node.vy = 0;
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onDoubleClick={(e) => {
          const { x, y } = canvasPoint(e);
          applyZoomAt(x, y, viewRef.current.scale * ZOOM_STEP);
        }}
      />
      <div className={styles.zoomBar} aria-label="图谱缩放">
        {selectedId ? (
          <>
            <button
              type="button"
              className={styles.zoomBtn}
              title="重新聚焦到当前关联"
              onClick={() => {
                const focus = focusNeighborhood(selectedId, linksRef.current);
                fitView(true, focus);
              }}
            >
              关联{focusCount > 0 ? ` ${focusCount}` : ""}
            </button>
            <button
              type="button"
              className={styles.zoomBtn}
              title="退出聚焦，查看全图"
              onClick={() => {
                onSelect(null);
              }}
            >
              全图
            </button>
            <span className={styles.zoomDivider} />
          </>
        ) : null}
        <button
          type="button"
          className={styles.zoomBtn}
          title="缩小"
          onClick={() => applyZoomAt(width / 2, height / 2, viewRef.current.scale / ZOOM_STEP)}
        >
          −
        </button>
        <button
          type="button"
          className={styles.zoomLabel}
          title="点击适应画布"
          onClick={() => fitView()}
        >
          {zoomPct}%
        </button>
        <button
          type="button"
          className={styles.zoomBtn}
          title="放大"
          onClick={() => applyZoomAt(width / 2, height / 2, viewRef.current.scale * ZOOM_STEP)}
        >
          +
        </button>
        <button
          type="button"
          className={styles.zoomBtn}
          title="适应画布"
          onClick={() => {
            const focus = focusNeighborhood(selectedId, linksRef.current);
            fitView(true, focus);
          }}
        >
          适应
        </button>
      </div>
    </>
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
                  key={`${nonce}-${graphData.nodes.length}`}
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
                <span className={styles.hudTip}>
                  无双链的节点会散开在外围 · 点击查看关联 · 滚轮缩放 · 拖空白平移
                </span>
              </div>
            </div>

            {selected ? (
              <aside className={styles.side}>
                <h3 className={styles.sideTitle}>{selected.title}</h3>
                <p className={styles.sidePath}>
                  {kindLabel(selected.kind)}
                  {selected.path ? ` · ${selected.path}` : ""}
                </p>
                <p className={styles.focusBadge}>
                  聚焦关联 · 出链 {neighbors.out.length} · 回链 {neighbors.back.length}
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
