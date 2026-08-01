import { InfoCircleOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Typography,
} from "antd";
import type { SetURLSearchParams } from "react-router-dom";
import type { KongkuDesktopBridge } from "@/shared/desktop";
import type { FeedTab } from "../types";
import styles from "../SettingsPage.module.css";

type FeedSettingsPanelProps = {
  feedTab: FeedTab;
  onFeedTabChange: (tab: FeedTab) => void;
  setSearchParams: SetURLSearchParams;
  feedLoading: boolean;
  feedSaving: boolean;
  directIngest: boolean;
  feedDesc: string;
  ctextKey: string;
  ctextMasked: string;
  ctextConfigured: boolean;
  ctextKeysUrl: string;
  ctextDocsUrl: string;
  ctextHint: string;
  ctextSaving: boolean;
  mirrorRepo: string;
  mirrorRef: string;
  mirrorHint: string;
  mirrorPresets: { id: string; name: string; repo: string; ref: string; desc?: string }[];
  mirrorSaving: boolean;
  mediaCookiesReady: boolean;
  mediaLoginBusy: boolean;
  allowLocalAudio: boolean;
  asrMode: string;
  asrBaseUrl: string;
  asrApiKey: string;
  asrMasked: string;
  asrModel: string;
  asrLocalModel: string;
  saving: boolean;
  desktop: KongkuDesktopBridge | undefined;
  setDirectIngest: (v: boolean) => void;
  setCtextKey: (v: string) => void;
  setMirrorRepo: (v: string) => void;
  setMirrorRef: (v: string) => void;
  setAllowLocalAudio: (v: boolean) => void;
  setAsrMode: (v: string) => void;
  setAsrLocalModel: (v: string) => void;
  setAsrBaseUrl: (v: string) => void;
  setAsrApiKey: (v: string) => void;
  setAsrModel: (v: string) => void;
  onSaveFeedSettings: () => void;
  onSaveCtextKey: () => void;
  onClearCtextKey: () => void;
  onSaveMirror: () => void;
  onLoginDouyin: () => void;
  onSaveMediaSettings: () => void;
};

export function FeedSettingsPanel({
  feedTab,
  onFeedTabChange,
  setSearchParams,
  feedLoading,
  feedSaving,
  directIngest,
  feedDesc,
  ctextKey,
  ctextMasked,
  ctextConfigured,
  ctextKeysUrl,
  ctextDocsUrl,
  ctextHint,
  ctextSaving,
  mirrorRepo,
  mirrorRef,
  mirrorHint,
  mirrorPresets,
  mirrorSaving,
  mediaCookiesReady,
  mediaLoginBusy,
  allowLocalAudio,
  asrMode,
  asrBaseUrl,
  asrApiKey,
  asrMasked,
  asrModel,
  asrLocalModel,
  saving,
  desktop,
  setDirectIngest,
  setCtextKey,
  setMirrorRepo,
  setMirrorRef,
  setAllowLocalAudio,
  setAsrMode,
  setAsrLocalModel,
  setAsrBaseUrl,
  setAsrApiKey,
  setAsrModel,
  onSaveFeedSettings,
  onSaveCtextKey,
  onClearCtextKey,
  onSaveMirror,
  onLoginDouyin,
  onSaveMediaSettings,
}: FeedSettingsPanelProps) {
  return (
    <>
      <div className={styles.content}>
        <div className={styles.contentHead}>
          <div>
            <h1>喂养</h1>
            <p className={styles.desc}>
              公版书入库选项、书源镜像 / ctext Key，以及视频转写与抖音登录。
            </p>
          </div>
          <Space size={8} wrap>
            <Tag color={directIngest ? "success" : "default"}>
              {directIngest ? "直接入库已开" : "直接入库关闭"}
            </Tag>
            <Tag color={ctextConfigured ? "success" : "default"}>
              ctext {ctextConfigured ? "已配置" : "未配置"}
            </Tag>
            <Tag color={allowLocalAudio ? "success" : "default"}>
              {allowLocalAudio ? "音轨已授权" : "音轨未授权"}
            </Tag>
          </Space>
        </div>

        {feedLoading ? (
          <div className={styles.loading}>
            <Spin /> 正在加载喂养设置…
          </div>
        ) : (
          <>
            <div className={styles.contentBody}>
              <Tabs
                className={styles.keyTabs}
                activeKey={feedTab}
                onChange={(key) => {
                  const next = key as FeedTab;
                  onFeedTabChange(next);
                  setSearchParams(
                    (prev) => {
                      const p = new URLSearchParams(prev);
                      if (next === "books") p.set("keys", "books");
                      else if (next === "media") p.set("keys", "media");
                      else p.delete("keys");
                      return p;
                    },
                    { replace: true },
                  );
                }}
                items={[
                  {
                    key: "general",
                    label: "公版书入库",
                    children: (
                      <Form layout="vertical" className={styles.form}>
                        <Alert
                          type="info"
                          showIcon
                          style={{ marginBottom: 16 }}
                          message="公版书说明"
                          description={
                            feedDesc ||
                            "仅对接公版/开放书源（首期 Gutenberg）。开启后，搜索结果可使用「直接入库」。"
                          }
                        />
                        <Form.Item
                          label="公版书搜索结果允许直接入库"
                          extra="默认关闭：只能「下载到喂养」，抽取后预览再入库。开启后显示「直接入库」按钮。"
                        >
                          <Switch checked={directIngest} onChange={setDirectIngest} />
                        </Form.Item>
                      </Form>
                    ),
                  },
                  {
                    key: "books",
                    label: `公版书源${ctextConfigured ? " · ctext已配置" : ""}`,
                    children: (
                      <Form layout="vertical" className={styles.form}>
                        <p className={styles.tabHint}>
                          「中文公版」默认用推荐镜像动态搜书，一般不用改。ctext Key
                          仅中国哲书库需要。
                        </p>

                        <Form.Item label="中文公版 · 镜像仓库" extra={mirrorHint}>
                          <Space direction="vertical" style={{ width: "100%" }} size={10}>
                            {mirrorPresets.length > 0 ? (
                              <Select
                                value={
                                  mirrorPresets.some((p) => p.repo === mirrorRepo)
                                    ? mirrorRepo
                                    : "__custom__"
                                }
                                onChange={(v) => {
                                  if (v === "__custom__") return;
                                  const p = mirrorPresets.find((x) => x.repo === v);
                                  if (p) {
                                    setMirrorRepo(p.repo);
                                    setMirrorRef(p.ref || "master");
                                  }
                                }}
                                options={[
                                  ...mirrorPresets.map((p) => ({
                                    value: p.repo,
                                    label: p.name,
                                  })),
                                  { value: "__custom__", label: "自定义…" },
                                ]}
                              />
                            ) : null}
                            <Input
                              value={mirrorRepo}
                              onChange={(e) => setMirrorRepo(e.target.value)}
                              placeholder="owner/repo，例如 xp44mm/hanchuancaolu"
                            />
                            <Input
                              value={mirrorRef}
                              onChange={(e) => setMirrorRef(e.target.value)}
                              placeholder="分支，默认 master"
                              addonBefore="分支"
                            />
                          </Space>
                        </Form.Item>

                        <Form.Item
                          label={`ctext API Key${ctextMasked ? `（当前 ${ctextMasked}）` : ""}`}
                          extra={
                            <span>
                              {ctextHint}{" "}
                              <Typography.Link
                                href={ctextKeysUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                机构订阅 / 申请说明
                              </Typography.Link>
                              {" · "}
                              <Typography.Link
                                href={ctextDocsUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                API 文档
                              </Typography.Link>
                            </span>
                          }
                        >
                          <Input.Password
                            value={ctextKey}
                            onChange={(e) => setCtextKey(e.target.value)}
                            placeholder={
                              ctextMasked
                                ? "粘贴新 Key 以覆盖"
                                : "粘贴 ctext API Key（可选）"
                            }
                            autoComplete="off"
                          />
                        </Form.Item>
                      </Form>
                    ),
                  },
                  {
                    key: "media",
                    label: "视频转写",
                    children: (
                      <Form layout="vertical" className={styles.form}>
                        <p className={styles.tabHint}>
                          抖音等视频多数没有字幕轨。无字幕时需下载音轨做语音转写；跟读功能也会缓存音轨。
                          默认不下载，需你明确授权。Mac 首次本地转写还需下载 Whisper 模型。
                        </p>
                        <Form.Item
                          label="抖音登录（抓取用）"
                          extra="桌面端会弹出网页窗口登录；登录态供 yt-dlp 抓取文案/字幕。也可在「喂养 → 视频链接」处登录。"
                        >
                          <Space wrap>
                            <Button
                              type="primary"
                              loading={mediaLoginBusy}
                              disabled={!desktop?.loginMediaSite}
                              onClick={() => void onLoginDouyin()}
                            >
                              应用内登录抖音
                            </Button>
                            {mediaCookiesReady ? (
                              <Tag color="success">已保存登录态</Tag>
                            ) : desktop?.loginMediaSite ? (
                              <Tag>未登录</Tag>
                            ) : (
                              <Tag color="warning">仅桌面安装包可用</Tag>
                            )}
                          </Space>
                        </Form.Item>
                        <Form.Item
                          label="允许下载音轨到本机"
                          extra="开启后：无字幕可自动语音转写，并缓存音轨供「文案跟读」。关闭时仅尝试拉字幕，否则需补贴文案。音轨保存在本机 data/uploads，删除来源会一并清理。"
                        >
                          <Switch
                            checked={allowLocalAudio}
                            onChange={setAllowLocalAudio}
                            checkedChildren="已授权"
                            unCheckedChildren="未授权"
                          />
                        </Form.Item>
                        <Form.Item
                          label="转写方式"
                          extra="自动：优先云端（若已配置），否则本地。需先开启「允许下载音轨」。"
                        >
                          <Select
                            value={asrMode}
                            onChange={setAsrMode}
                            disabled={!allowLocalAudio}
                            options={[
                              { value: "auto", label: "自动（推荐）" },
                              { value: "local", label: "仅本地 Whisper" },
                              { value: "cloud", label: "仅云端 ASR" },
                              { value: "off", label: "关闭（只能补贴文案）" },
                            ]}
                          />
                        </Form.Item>
                        <Form.Item
                          label="本地模型"
                          extra="首次会下载到 data/models；base 较快，small 更准。"
                        >
                          <Select
                            value={asrLocalModel}
                            onChange={setAsrLocalModel}
                            disabled={!allowLocalAudio}
                            options={[
                              { value: "tiny", label: "tiny（最快）" },
                              { value: "base", label: "base（推荐）" },
                              { value: "small", label: "small（更准）" },
                              { value: "medium", label: "medium（慢）" },
                            ]}
                          />
                        </Form.Item>
                        <Form.Item
                          label="云端转写 Base URL"
                          extra="可空。常用：https://api.siliconflow.cn/v1 或 https://api.openai.com/v1"
                        >
                          <Input
                            value={asrBaseUrl}
                            onChange={(e) => setAsrBaseUrl(e.target.value)}
                            placeholder="https://api.siliconflow.cn/v1"
                          />
                        </Form.Item>
                        <Form.Item
                          label={`云端转写 API Key${asrMasked ? `（当前 ${asrMasked}）` : ""}`}
                          extra="可与对话 Key 分开；DeepSeek 不能用于转写。"
                        >
                          <Input.Password
                            value={asrApiKey}
                            onChange={(e) => setAsrApiKey(e.target.value)}
                            placeholder={
                              asrMasked ? "留空则保持原 Key" : "可选，硅基流动 / OpenAI"
                            }
                            autoComplete="off"
                          />
                        </Form.Item>
                        <Form.Item
                          label="云端转写模型"
                          extra="可空自动选择。硅基流动可用 FunAudioLLM/SenseVoiceSmall"
                        >
                          <Input
                            value={asrModel}
                            onChange={(e) => setAsrModel(e.target.value)}
                            placeholder="留空则自动"
                          />
                        </Form.Item>
                      </Form>
                    ),
                  },
                ]}
              />
            </div>
            <div className={styles.contentFooter}>
              {feedTab === "general" ? (
                <Button
                  type="primary"
                  loading={feedSaving}
                  onClick={() => void onSaveFeedSettings()}
                >
                  保存
                </Button>
              ) : feedTab === "books" ? (
                <>
                  <Button
                    type="primary"
                    loading={mirrorSaving}
                    onClick={() => void onSaveMirror()}
                  >
                    保存镜像设置
                  </Button>
                  <Button
                    type="primary"
                    loading={ctextSaving}
                    onClick={() => void onSaveCtextKey()}
                  >
                    保存 ctext Key
                  </Button>
                  <Button
                    danger
                    disabled={!ctextConfigured && !ctextMasked}
                    loading={ctextSaving}
                    onClick={() => void onClearCtextKey()}
                  >
                    清除
                  </Button>
                </>
              ) : (
                <Button
                  type="primary"
                  loading={saving}
                  onClick={() => void onSaveMediaSettings()}
                >
                  保存转写设置
                </Button>
              )}
            </div>
          </>
        )}
      </div>

      <aside className={styles.tips}>
        {feedTab === "general" ? (
          <Card size="small" title={<><InfoCircleOutlined /> 说明</>}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              配置保存在 data/runtime-feed.json。与数据库连接配置相互独立。
            </Typography.Paragraph>
          </Card>
        ) : feedTab === "books" ? (
          <>
            <Card size="small" title={<><InfoCircleOutlined /> 公版书源</>}>
              <ul className={styles.checklist}>
                <li>镜像仓库用于「中文公版」动态搜书</li>
                <li>ctext 为机构订阅制，个人通常无需配置</li>
                <li>未配置 ctext 不影响「中文公版」下载</li>
              </ul>
            </Card>
            <Card size="small" title={<><SafetyCertificateOutlined /> 安全</>}>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                Key 仅保存在本机；导出备份默认不包含 Key。
              </Typography.Paragraph>
            </Card>
          </>
        ) : (
          <>
            <Card size="small" title={<><InfoCircleOutlined /> 视频转写</>}>
              <ul className={styles.checklist}>
                <li>云端转写按音频时长计费，未授权音轨下载时不会发生</li>
                <li>DeepSeek 对话 Key 不能用于转写</li>
                <li>本地 Whisper 首次会下载模型到 data/models</li>
              </ul>
            </Card>
          </>
        )}
      </aside>
    </>
  );
}
