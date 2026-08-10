import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  DeleteOutlined,
  EyeOutlined,
  HolderOutlined,
  ImportOutlined,
  ThunderboltOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Modal,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { api, type SkillDetail, type SkillItem } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import styles from "./SkillsPage.module.css";

export function SkillsPage() {
  const { message, modal } = App.useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [leftovers, setLeftovers] = useState<
    { skill_id: string; source_count: number; titles: string[] }[]
  >([]);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTab, setDetailTab] = useState("skill");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [purging, setPurging] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<{
    id: string;
    side: "before" | "after";
  } | null>(null);
  const reorderingRef = useRef(false);

  const refresh = useCallback(async () => {
    const list = await api.listSkills();
    setSkills(list.items);
    try {
      const left = await api.listSkillLeftovers();
      setLeftovers(left.items);
    } catch {
      // 残留扫描失败不挡主界面（未安装时仍应立刻看到安装入口）
      setLeftovers([]);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const list = await api.listSkills();
        if (!alive) return;
        setSkills(list.items);
        // 先结束加载，再扫残留，避免首次点进「技能」白屏/转圈
        setLoading(false);
        try {
          const left = await api.listSkillLeftovers();
          if (alive) setLeftovers(left.items);
        } catch {
          if (alive) setLeftovers([]);
        }
      } catch (err) {
        if (!alive) return;
        message.error(formatError(err));
        setSkills([]);
        setLeftovers([]);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [message]);

  async function doInstallZip(file: File, importKnowledge: boolean) {
    setInstalling(true);
    try {
      const res = await api.installSkillZip(file, importKnowledge, true);
      message.success(res.message || "安装成功");
      setPendingFile(null);
      await refresh();
    } catch (err) {
      message.error(formatError(err));
    } finally {
      setInstalling(false);
    }
  }

  async function toggleEnabled(item: SkillItem, enabled: boolean) {
    try {
      await api.setSkillEnabled(item.id, enabled);
      await refresh();
    } catch (err) {
      message.error(formatError(err));
    }
  }

  function clearDrag() {
    setDraggingId(null);
    setDragOver(null);
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }

  function resolveDropTarget(
    clientY: number,
    listEl: HTMLElement,
  ): { id: string; side: "before" | "after" } | null {
    if (!draggingId) return null;
    // 用原始顺序节点算落点，拖动中不挪 DOM，避免 dragend 丢失导致样式卡住
    const nodes = Array.from(
      listEl.querySelectorAll<HTMLElement>("[data-skill-id]"),
    ).filter((n) => n.dataset.skillId && n.dataset.skillId !== draggingId);
    if (nodes.length === 0) return null;
    let insertAt = nodes.length;
    for (let i = 0; i < nodes.length; i += 1) {
      const rect = nodes[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        insertAt = i;
        break;
      }
    }
    if (insertAt >= nodes.length) {
      return { id: nodes[nodes.length - 1].dataset.skillId!, side: "after" };
    }
    return { id: nodes[insertAt].dataset.skillId!, side: "before" };
  }

  function buildOrder(
    fromId: string,
    toId: string,
    side: "before" | "after",
    ids: string[] = skills.map((s) => s.id),
  ): string[] | null {
    if (!fromId || !toId || fromId === toId) return null;
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0) return null;
    const next = [...ids];
    next.splice(from, 1);
    let insertAt = next.indexOf(toId);
    if (insertAt < 0) return null;
    if (side === "after") insertAt += 1;
    next.splice(insertAt, 0, fromId);
    if (next.join("\0") === ids.join("\0")) return null;
    return next;
  }

  async function commitOrder(fromId: string, toId: string, side: "before" | "after") {
    if (reorderingRef.current) {
      clearDrag();
      return;
    }
    const next = buildOrder(fromId, toId, side);
    if (!next) {
      clearDrag();
      return;
    }
    const prev = skills;
    setSkills(next.map((id) => prev.find((s) => s.id === id)!).filter(Boolean));
    clearDrag();
    reorderingRef.current = true;
    try {
      const list = await api.reorderSkills(next);
      setSkills(list.items);
    } catch (err) {
      message.error(formatError(err));
      await refresh();
    } finally {
      reorderingRef.current = false;
    }
  }

  const sorting = Boolean(draggingId);
  const placeholderIndex = (() => {
    if (!draggingId || !dragOver) return null;
    const from = skills.findIndex((s) => s.id === draggingId);
    let insertAt = skills.findIndex((s) => s.id === dragOver.id);
    if (from < 0 || insertAt < 0) return null;
    if (dragOver.side === "after") insertAt += 1;
    // 落点相对当前位置没有变化
    if (insertAt === from || insertAt === from + 1) return null;
    return insertAt;
  })();

  useEffect(() => {
    if (!draggingId) return;
    const onEnd = () => clearDrag();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEnd();
    };
    window.addEventListener("dragend", onEnd, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("dragend", onEnd, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [draggingId]);

  async function showDetail(id: string) {
    try {
      const d = await api.getSkill(id);
      setDetail(d);
      setDetailTab(d.skill_md?.trim() ? "skill" : d.readme?.trim() ? "readme" : "info");
      setDetailOpen(true);
    } catch (err) {
      message.error(formatError(err));
    }
  }

  function confirmUninstall(item: SkillItem) {
    modal.confirm({
      title: `卸载「${item.name}」？`,
      content:
        "将删除技能包，并一并清理该技能导入过的附带材料（喂养来源、知识条目、「我的资源」目录）。你自己喂养的书不会受影响。",
      okText: "卸载并清理导入",
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const res = await api.uninstallSkill(item.id, true);
          message.success(res.message || "已卸载");
          await refresh();
        } catch (err) {
          message.error(formatError(err));
        }
      },
    });
  }

  function confirmPurgeLeftover(skillId: string) {
    modal.confirm({
      title: `清理「${skillId}」残留导入？`,
      content:
        "技能可能已卸载，但仍留下导入材料。将删除对应喂养来源、知识条目与「我的资源」目录。",
      okText: "清理",
      okButtonProps: { danger: true },
      onOk: async () => {
        setPurging(true);
        try {
          const res = await api.purgeSkillImported(skillId);
          message.success(res.message);
          await refresh();
        } catch (err) {
          message.error(formatError(err));
        } finally {
          setPurging(false);
        }
      },
    });
  }

  async function importKnowledge(item: SkillItem) {
    try {
      const res = await api.importSkillKnowledge(item.id);
      message.success(res.message);
      await refresh();
    } catch (err) {
      message.error(formatError(err));
    }
  }

  if (loading) {
    return (
      <section className={styles.page}>
        <div className={styles.loadingBox}>
          <Spin tip="加载技能…" />
        </div>
      </section>
    );
  }

  return (
    <section className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1>
            <ThunderboltOutlined style={{ marginRight: 8 }} />
            技能
          </h1>
          <p className={styles.desc}>
            像装编辑器插件一样安装 Skill：改变「怎么整理、怎么提问」，不改变「库里有什么」。
            空库时库外问题仍会拒答。可拖动排序：越靠后的技能对最终成文格式优先级越高（建议总结类放最后）。
          </p>
        </div>
        <div className={styles.actions}>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              if (!f) return;
              const lower = f.name.toLowerCase();
              if (!lower.endsWith(".zip")) {
                message.warning("请选择 .zip 技能包");
                return;
              }
              setPendingFile(f);
            }}
          />
          <Button
            type="primary"
            icon={<UploadOutlined />}
            loading={installing}
            onClick={() => fileRef.current?.click()}
          >
            从本地安装
          </Button>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        message="事实只认知识库"
        description="「安装并导入附带材料」会把技能包自带的小文件送进喂养并可能入库；不是去读你电脑上的书。卸载时默认会清掉这些导入物。「我的资源」本身没有删除按钮，请在本页清理残留或去知识/喂养页删除。"
      />

      {leftovers.length > 0 ? (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>残留的 Skill 导入</h2>
          <p className={styles.hint}>
            以下材料来自已导入的技能附带文件（标题以 [Skill·…] 开头），不是写死在程序里。可一键清理。
          </p>
          <div className={styles.cardList}>
            {leftovers.map((item) => (
              <article key={item.skill_id} className={styles.card}>
                <div className={styles.cardTop}>
                  <div>
                    <h3 className={styles.cardTitle}>{item.skill_id}</h3>
                    <div className={styles.meta}>
                      <Tag color="orange">{item.source_count} 条</Tag>
                    </div>
                  </div>
                  <Button
                    danger
                    size="small"
                    loading={purging}
                    icon={<DeleteOutlined />}
                    onClick={() => confirmPurgeLeftover(item.skill_id)}
                  >
                    清理
                  </Button>
                </div>
                <p className={styles.cardDesc}>{(item.titles || []).join("；")}</p>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>已安装</h2>
        {skills.length > 1 ? (
          <p className={styles.hint}>
            按左侧「拖动」把手排序；蓝色条表示将放到的位置。靠后的技能决定最终怎么写。
          </p>
        ) : null}
        {skills.length === 0 ? (
          <div className={styles.empty}>尚未安装技能。请上传符合规范的 .zip 技能包。</div>
        ) : (
          <div
            className={`${styles.cardList}${sorting ? ` ${styles.cardListSorting}` : ""}`}
            onDragOver={(e) => {
              if (!draggingId) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const next = resolveDropTarget(e.clientY, e.currentTarget);
              if (!next) return;
              setDragOver((prev) =>
                prev?.id === next.id && prev.side === next.side ? prev : next,
              );
            }}
            onDrop={(e) => {
              e.preventDefault();
              const fromId =
                e.dataTransfer.getData("text/kongku-skill") || draggingId || "";
              const target =
                dragOver || resolveDropTarget(e.clientY, e.currentTarget);
              if (fromId && target) {
                void commitOrder(fromId, target.id, target.side);
              } else {
                clearDrag();
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDragOver(null);
              }
            }}
          >
            {skills.map((item, index) => {
              const isDragging = draggingId === item.id;
              return (
              <Fragment key={item.id}>
              {placeholderIndex === index ? (
                <div className={styles.dropSlot} aria-hidden>
                  <span>放到这里</span>
                </div>
              ) : null}
              <article
                data-skill-id={item.id}
                className={`${styles.card}${sorting ? ` ${styles.cardSortMode}` : ""}${
                  isDragging ? ` ${styles.cardDragging}` : ""
                }`}
              >
                <div className={styles.cardTop}>
                  <div className={styles.cardHead}>
                    {skills.length > 1 ? (
                      <button
                        type="button"
                        className={`${styles.dragHandle}${
                          isDragging ? ` ${styles.dragHandleActive}` : ""
                        }`}
                        title="按住拖动排序"
                        aria-label={`拖动调整「${item.name}」顺序`}
                        draggable
                        onDragStart={(e) => {
                          setDraggingId(item.id);
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/kongku-skill", item.id);
                          e.dataTransfer.setData("text/plain", item.id);
                          const card = e.currentTarget.closest("article");
                          if (card instanceof HTMLElement) {
                            const rect = card.getBoundingClientRect();
                            e.dataTransfer.setDragImage(
                              card,
                              Math.min(36, e.clientX - rect.left),
                              Math.min(28, e.clientY - rect.top),
                            );
                          }
                        }}
                        onDragEnd={() => clearDrag()}
                      >
                        <HolderOutlined className={styles.dragHandleIcon} />
                        <span className={styles.dragHandleHint}>拖动</span>
                      </button>
                    ) : null}
                    <div>
                    <h3 className={styles.cardTitle}>
                      <span className={styles.orderBadge}>{index + 1}</span>
                      {item.name}
                    </h3>
                    <div className={styles.meta}>
                      <Tag>{item.id}</Tag>
                      <Tag color="blue">v{item.version}</Tag>
                      <Tag>{item.type}</Tag>
                      {item.enabled ? (
                        <Tag color="green">已启用</Tag>
                      ) : (
                        <Tag>已禁用</Tag>
                      )}
                      {item.has_knowledge ? (
                        <Tag color={item.knowledge_imported ? "cyan" : "default"}>
                          {item.knowledge_imported ? "附带材料已导过" : "含附带材料"}
                        </Tag>
                      ) : null}
                    </div>
                    </div>
                  </div>
                  <Space>
                    <Typography.Text type="secondary">启用</Typography.Text>
                    <Switch
                      checked={item.enabled}
                      onChange={(v) => void toggleEnabled(item, v)}
                    />
                  </Space>
                </div>
                {item.description ? (
                  <p className={styles.cardDesc}>{item.description}</p>
                ) : null}
                <div className={styles.cardActions}>
                  <Button
                    size="small"
                    icon={<EyeOutlined />}
                    onClick={() => void showDetail(item.id)}
                  >
                    查看
                  </Button>
                  {item.has_knowledge ? (
                    <Button
                      size="small"
                      icon={<ImportOutlined />}
                      onClick={() => void importKnowledge(item)}
                    >
                      导入附带材料
                    </Button>
                  ) : null}
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => confirmUninstall(item)}
                  >
                    卸载
                  </Button>
                </div>
              </article>
              </Fragment>
              );
            })}
            {placeholderIndex === skills.length ? (
              <div className={styles.dropSlot} aria-hidden>
                <span>放到这里</span>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <Modal
        title="安装技能包"
        open={!!pendingFile}
        onCancel={() => !installing && setPendingFile(null)}
        footer={null}
        destroyOnHidden
        centered
      >
        {pendingFile ? (
          <div className={styles.section}>
            <p>
              将安装 <strong>{pendingFile.name}</strong>。技能只改变流程与输出格式，事实仍只认知识库。
            </p>
            <p className={styles.hint}>
              若包内含附带材料（knowledge/），「安装并导入」会送入喂养队列；未确认入库前不会进入检索。
            </p>
            <Space wrap>
              <Button onClick={() => setPendingFile(null)} disabled={installing}>
                取消
              </Button>
              <Button
                type="primary"
                loading={installing}
                onClick={() => void doInstallZip(pendingFile, false)}
              >
                仅装流程
              </Button>
              <Button
                loading={installing}
                onClick={() => void doInstallZip(pendingFile, true)}
              >
                安装并导入附带材料
              </Button>
            </Space>
          </div>
        ) : null}
      </Modal>

      <Modal
        className={styles.detailModal}
        title={detail ? detail.name : "技能详情"}
        open={detailOpen}
        onCancel={() => setDetailOpen(false)}
        footer={null}
        width="min(720px, calc(100vw - 32px))"
        centered
        destroyOnHidden
      >
        {detail ? (
          <div className={styles.detailLayout}>
            <div className={styles.meta}>
              <Tag>{detail.id}</Tag>
              <Tag color="blue">v{detail.version}</Tag>
              <Tag>{detail.type}</Tag>
              {(detail.permissions || []).map((p) => (
                <Tag key={p}>{p}</Tag>
              ))}
            </div>
            <Tabs
              className={styles.detailTabs}
              size="small"
              activeKey={detailTab}
              onChange={setDetailTab}
              items={[
                {
                  key: "skill",
                  label: "SKILL.md",
                  children: (
                    <pre className={styles.detailPane}>
                      {detail.skill_md?.trim() || "（无内容）"}
                    </pre>
                  ),
                },
                ...(detail.readme?.trim()
                  ? [
                      {
                        key: "readme",
                        label: "说明",
                        children: (
                          <pre className={styles.detailPane}>{detail.readme}</pre>
                        ),
                      },
                    ]
                  : []),
                {
                  key: "info",
                  label: "信息",
                  children: (
                    <div className={styles.detailInfo}>
                      <Typography.Paragraph className={styles.detailInfoP}>
                        <Typography.Text type="secondary">简介</Typography.Text>
                        <br />
                        {detail.description?.trim() || "暂无简介"}
                      </Typography.Paragraph>
                      <Typography.Paragraph className={styles.detailInfoP}>
                        <Typography.Text type="secondary">策略</Typography.Text>
                        <br />
                        {detail.knowledge_policy || "library_only"}
                        {" · "}
                        事实只认知识库
                      </Typography.Paragraph>
                      {detail.author ? (
                        <Typography.Paragraph className={styles.detailInfoP}>
                          <Typography.Text type="secondary">作者</Typography.Text>
                          <br />
                          {detail.author}
                        </Typography.Paragraph>
                      ) : null}
                    </div>
                  ),
                },
              ]}
            />
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
