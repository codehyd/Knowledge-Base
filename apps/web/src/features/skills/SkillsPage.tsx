import { useCallback, useEffect, useRef, useState } from "react";
import {
  DeleteOutlined,
  EyeOutlined,
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
            空库时库外问题仍会拒答。
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
        {skills.length === 0 ? (
          <div className={styles.empty}>尚未安装技能。请上传符合规范的 .zip 技能包。</div>
        ) : (
          <div className={styles.cardList}>
            {skills.map((item) => (
              <article key={item.id} className={styles.card}>
                <div className={styles.cardTop}>
                  <div>
                    <h3 className={styles.cardTitle}>{item.name}</h3>
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
            ))}
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
