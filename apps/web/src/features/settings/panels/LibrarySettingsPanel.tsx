import { DeleteOutlined, FolderOpenOutlined, InfoCircleOutlined, SyncOutlined } from "@ant-design/icons";
import { Button, Card, Spin, Tabs, Tag, Typography } from "antd";
import type { NavigateFunction } from "react-router-dom";
import type { LibraryOut } from "@/shared/api/client";
import { formatBytes } from "../utils/formatBytes";
import styles from "../SettingsPage.module.css";

type LibrarySettingsPanelProps = {
  library: LibraryOut | null;
  libraryLoading: boolean;
  libraryRebuilding: boolean;
  libraryCatKey: string;
  libraryCats: LibraryOut["categories"];
  activeLibraryCat: LibraryOut["categories"][number] | null;
  setLibraryCatKey: (key: string) => void;
  navigate: NavigateFunction;
  onRebuildLibrary: () => void;
  onOpenLibraryPath: (path: string) => void;
  onDeleteLibraryItem: (sourceId: number, title: string) => void;
};

export function LibrarySettingsPanel({
  library,
  libraryLoading,
  libraryRebuilding,
  libraryCats,
  activeLibraryCat,
  setLibraryCatKey,
  navigate,
  onRebuildLibrary,
  onOpenLibraryPath,
  onDeleteLibraryItem,
}: LibrarySettingsPanelProps) {
  return (
    <>
      <div className={styles.content}>
        <div className={styles.contentHead}>
          <div>
            <h1>我的资源</h1>
            <p className={styles.desc}>
              顶部按「书籍 / 视频 / 网页 / 笔记」切换；每项以书名或标题建文件夹，内含正文、音轨等。
            </p>
          </div>
          <Tag>{library?.total_items ?? 0} 项</Tag>
        </div>

        {libraryLoading ? (
          <div className={styles.loading}>
            <Spin /> 正在加载资源库…
          </div>
        ) : (
          <>
            <div className={styles.contentBody}>
              <Tabs
                className={styles.libraryTabs}
                activeKey={
                  activeLibraryCat
                    ? activeLibraryCat.key || activeLibraryCat.label
                    : undefined
                }
                onChange={(key) => setLibraryCatKey(key)}
                tabBarExtraContent={
                  activeLibraryCat ? (
                    <Button
                      size="small"
                      icon={<FolderOpenOutlined />}
                      onClick={() =>
                        void onOpenLibraryPath(activeLibraryCat.absolute_path)
                      }
                    >
                      打开此分类
                    </Button>
                  ) : null
                }
                items={libraryCats.map((cat) => ({
                  key: cat.key || cat.label,
                  label: (
                    <span className={styles.libraryTabLabel}>
                      {cat.label}
                      <Tag>{cat.item_count}</Tag>
                    </span>
                  ),
                  children:
                    cat.items.length === 0 ? (
                      <p className={styles.libraryEmpty}>暂无资源</p>
                    ) : (
                      <div className={styles.libraryItems}>
                        {cat.items.map((item) => (
                          <div
                            key={`${cat.label}-${item.source_id}-${item.folder_name}`}
                            className={styles.libraryItem}
                          >
                            <div className={styles.libraryItemBody}>
                              <p className={styles.libraryItemTitle}>{item.title}</p>
                              <ul className={styles.libraryFiles}>
                                {item.files.length === 0 ? (
                                  <li>空文件夹</li>
                                ) : (
                                  item.files.map((f) => (
                                    <li key={f.name}>
                                      {f.name}
                                      {f.size > 0 ? ` · ${formatBytes(f.size)}` : ""}
                                    </li>
                                  ))
                                )}
                              </ul>
                              {cat.key === "vault" ? (
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  路径：library/笔记库/{item.folder_name}
                                </Typography.Text>
                              ) : null}
                            </div>
                            {cat.key === "vault" && item.source_id ? (
                              <Button
                                size="small"
                                type="link"
                                onClick={() => navigate(`/notes?id=${item.source_id}`)}
                              >
                                打开编辑
                              </Button>
                            ) : null}
                            <Button
                              size="small"
                              danger
                              type="text"
                              icon={<DeleteOutlined />}
                              aria-label="删除资源"
                              onClick={() =>
                                void onDeleteLibraryItem(item.source_id, item.title)
                              }
                            />
                          </div>
                        ))}
                      </div>
                    ),
                }))}
              />
            </div>
            <div className={styles.contentFooter}>
              <Button
                icon={<SyncOutlined />}
                loading={libraryRebuilding}
                onClick={() => void onRebuildLibrary()}
              >
                重建目录
              </Button>
              <Button
                type="primary"
                icon={<FolderOpenOutlined />}
                disabled={!library?.absolute_root}
                onClick={() => {
                  if (library?.absolute_root) void onOpenLibraryPath(library.absolute_root);
                }}
              >
                打开资源根目录
              </Button>
            </div>
          </>
        )}
      </div>

      <aside className={styles.tips}>
        <Card size="small" title={<><FolderOpenOutlined /> 目录说明</>}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            喂养镜像：data/library/分类/标题/；手写笔记：data/library/笔记库/（可多级文件夹）
          </Typography.Paragraph>
          <ul className={styles.checklist}>
            <li>笔记库 · Obsidian 式多级 .md，与书籍/视频同在资源根下，侧栏「笔记」编辑</li>
            <li>正文.txt · 抽取或转写文案</li>
            <li>音轨.* · 授权后下载的跟读音频</li>
            <li>时间轴.json · 跟读高亮</li>
            <li>原件.* · 电子书等原始文件</li>
          </ul>
        </Card>
        <Card size="small" title={<><InfoCircleOutlined /> 提示</>}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            「笔记库」在侧栏「笔记」中编辑，保存即入库。其它分类是喂养镜像；访达里删文件夹后点重建会再出现，永久删除请用列表右侧删除。
          </Typography.Paragraph>
        </Card>
      </aside>
    </>
  );
}
