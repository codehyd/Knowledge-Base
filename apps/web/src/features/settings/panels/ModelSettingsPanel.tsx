import {
  DollarOutlined,
  InfoCircleOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import type { ProviderOption } from "@/shared/api/client";
import type { TestResult } from "../types";
import { pickRecommended } from "../utils/pickRecommended";
import styles from "../SettingsPage.module.css";

type ModelSettingsPanelProps = {
  loading: boolean;
  saving: boolean;
  testing: boolean;
  providers: ProviderOption[];
  providerId: string;
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  embedModel: string;
  customChat: boolean;
  customEmbed: boolean;
  masked: string;
  configured: boolean;
  chatMaxTokens: number;
  quoteRefineMaxTokens: number;
  testResult: TestResult | null;
  current: ProviderOption | undefined;
  chatOptions: ProviderOption["chat_models"];
  embedOptions: ProviderOption["embed_models"];
  setBaseUrl: (v: string) => void;
  setApiKey: (v: string) => void;
  setChatModel: (v: string) => void;
  setEmbedModel: (v: string) => void;
  setCustomChat: (v: boolean) => void;
  setCustomEmbed: (v: boolean) => void;
  setChatMaxTokens: (v: number) => void;
  setQuoteRefineMaxTokens: (v: number) => void;
  onProviderChange: (id: string) => void;
  onSave: () => void;
  onTest: () => void;
};

export function ModelSettingsPanel({
  loading,
  saving,
  testing,
  providers,
  providerId,
  baseUrl,
  apiKey,
  chatModel,
  embedModel,
  customChat,
  customEmbed,
  masked,
  configured,
  chatMaxTokens,
  quoteRefineMaxTokens,
  testResult,
  current,
  chatOptions,
  embedOptions,
  setBaseUrl,
  setApiKey,
  setChatModel,
  setEmbedModel,
  setCustomChat,
  setCustomEmbed,
  setChatMaxTokens,
  setQuoteRefineMaxTokens,
  onProviderChange,
  onSave,
  onTest,
}: ModelSettingsPanelProps) {
  return (
    <>
      <div className={styles.content}>
        <div className={styles.contentHead}>
          <div>
            <h1>模型与 Key</h1>
            <p className={styles.desc}>
              配置对话与入库所用的大模型服务商、API Key 与模型；输出额度用于控制费用。
              公版书源与视频转写请到「喂养」。
            </p>
          </div>
          <Tag color={configured ? "success" : "default"}>
            AI {configured ? "已配置" : "未配置"}
          </Tag>
        </div>

        {loading ? (
          <div className={styles.loading}>
            <Spin /> 正在加载服务商与配置…
          </div>
        ) : (
          <>
            <div className={styles.contentBody}>
              <Form layout="vertical" className={styles.form}>
                <p className={styles.tabHint}>
                  对话、AI 入库、向量检索等。Key 仅保存在本机。
                </p>
                <Form.Item label="服务商" required>
                  <Select
                    value={providerId}
                    onChange={onProviderChange}
                    options={providers.map((p) => ({ value: p.id, label: p.name }))}
                    placeholder="选择服务商"
                  />
                </Form.Item>

                <Form.Item
                  label="Base URL"
                  required
                  extra="API 基础地址，通常以 /v1 结尾。"
                >
                  <Input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    readOnly={
                      current
                        ? !current.allow_custom_base_url && Boolean(current.base_url)
                        : false
                    }
                  />
                </Form.Item>

                <Form.Item
                  label={`API Key${masked ? `（当前 ${masked}）` : ""}`}
                  extra={
                    <span>
                      用于请求大模型 API。
                      {current?.keys_url || current?.docs_url ? (
                        <>
                          {" "}
                          <Typography.Link
                            href={current.keys_url || current.docs_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            获取 / 管理 Key
                          </Typography.Link>
                          {current?.docs_url && current?.keys_url ? (
                            <>
                              {" · "}
                              <Typography.Link
                                href={current.docs_url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                文档
                              </Typography.Link>
                            </>
                          ) : null}
                        </>
                      ) : (
                        " 请到服务商控制台申请。"
                      )}
                    </span>
                  }
                >
                  <Input.Password
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={masked ? "留空则保持原 Key" : "粘贴你的 Key"}
                    autoComplete="off"
                  />
                </Form.Item>

                <Form.Item
                  label="对话模型"
                  required
                  extra="用于对话（Chat Completion）的模型名称。"
                >
                  {customChat ? (
                    <Space.Compact style={{ width: "100%" }}>
                      <Input
                        value={chatModel}
                        onChange={(e) => setChatModel(e.target.value)}
                        placeholder="例如 deepseek-v4-pro"
                      />
                      <Button
                        onClick={() => {
                          setCustomChat(false);
                          if (current) {
                            setChatModel(
                              pickRecommended(current.chat_models, "deepseek-v4-flash"),
                            );
                          }
                        }}
                      >
                        列表
                      </Button>
                    </Space.Compact>
                  ) : (
                    <Select
                      value={
                        chatOptions.some((m) => m.id === chatModel) ? chatModel : undefined
                      }
                      onChange={(v) => {
                        if (v === "__custom__") {
                          setCustomChat(true);
                          setChatModel("");
                          return;
                        }
                        setChatModel(v);
                      }}
                      options={[
                        ...chatOptions.map((m) => ({
                          value: m.id,
                          label: `${m.label}${m.recommended ? "（推荐）" : ""}`,
                        })),
                        { value: "__custom__", label: "其它（手动输入）…" },
                      ]}
                    />
                  )}
                </Form.Item>

                <Form.Item
                  label="Embedding 模型"
                  required
                  extra="用于向量嵌入；留空则使用服务商默认（当前必选一项）。"
                >
                  {customEmbed ? (
                    <Space.Compact style={{ width: "100%" }}>
                      <Input
                        value={embedModel}
                        onChange={(e) => setEmbedModel(e.target.value)}
                        placeholder="例如 text-embedding-3-small"
                      />
                      <Button
                        onClick={() => {
                          setCustomEmbed(false);
                          if (current) {
                            setEmbedModel(
                              pickRecommended(current.embed_models, "deepseek-v4-flash"),
                            );
                          }
                        }}
                      >
                        列表
                      </Button>
                    </Space.Compact>
                  ) : (
                    <Select
                      value={
                        embedOptions.some((m) => m.id === embedModel)
                          ? embedModel
                          : undefined
                      }
                      onChange={(v) => {
                        if (v === "__custom__") {
                          setCustomEmbed(true);
                          setEmbedModel("");
                          return;
                        }
                        setEmbedModel(v);
                      }}
                      options={[
                        ...embedOptions.map((m) => ({
                          value: m.id,
                          label: `${m.label}${m.recommended ? "（推荐）" : ""}`,
                        })),
                        { value: "__custom__", label: "其它（手动输入）…" },
                      ]}
                    />
                  )}
                </Form.Item>

                <Typography.Title level={5} style={{ marginTop: 8 }}>
                  输出额度（max_tokens）
                </Typography.Title>
                <p className={styles.tabHint}>
                  限制每次调用的输出 token 上限，直接影响费用。注意：推理模型（如
                  deepseek-v4-flash、R1 类）的「思考过程」也占这个额度——给太小会导致正文被挤没（空回复），
                  给太大会增加单次成本上限。
                </p>
                <Form.Item
                  label="对话主回答"
                  extra="每次提问 1 次调用。普通模型 1200 足够；推理模型建议 2000~4000。"
                >
                  <InputNumber
                    min={100}
                    max={128000}
                    step={100}
                    value={chatMaxTokens}
                    onChange={(v) => setChatMaxTokens(Number(v) || 1200)}
                    style={{ width: 220 }}
                  />
                </Form.Item>
                <Form.Item
                  label="知识点 AI 摘段"
                  extra="每次问答后 1 次调用，用于把知识点高亮摘成有头有尾的段落。推理模型建议 6000~8000；调为 0 附近的小值可变相关闭（摘段会静默回退为规则截取）。"
                >
                  <InputNumber
                    min={500}
                    max={128000}
                    step={500}
                    value={quoteRefineMaxTokens}
                    onChange={(v) => setQuoteRefineMaxTokens(Number(v) || 8000)}
                    style={{ width: 220 }}
                  />
                </Form.Item>

                {testResult && (
                  <Alert
                    className={styles.testAlert}
                    type={testResult.ok ? "success" : "error"}
                    showIcon
                    message={testResult.ok ? "连接测试成功" : "连接测试失败"}
                    description={
                      <div>
                        <div>{testResult.message}</div>
                        {testResult.latency_ms != null && (
                          <div>耗时：{testResult.latency_ms}ms</div>
                        )}
                        <div>模型：{chatModel}</div>
                        <div>时间：{testResult.at}</div>
                      </div>
                    }
                  />
                )}
              </Form>
            </div>
            <div className={styles.contentFooter}>
              <Button
                type="primary"
                loading={saving}
                disabled={testing}
                onClick={() => void onSave()}
              >
                保存 AI 配置
              </Button>
              <Button onClick={() => void onTest()} loading={testing} disabled={saving}>
                测试连接
              </Button>
            </div>
          </>
        )}
      </div>

      <aside className={styles.tips}>
        <Card size="small" title={<><DollarOutlined /> Token 消耗点</>}>
          <ul className={styles.checklist}>
            <li>
              <b>对话主回答</b>：每次提问 1 次（输入含检索到的资料片段+你的问题，输出受「对话主回答」额度限制）
            </li>
            <li>
              <b>知识点 AI 摘段</b>：每次问答后 1 次，精修知识点高亮范围
            </li>
            <li>
              <b>Embedding 向量化</b>：喂养入库时按切片批量调用；提问时问题本身 1 次
            </li>
          </ul>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8 }}>
            推理模型的思考过程也计入输出 token；想省钱可换非推理模型（如 deepseek-chat）。
          </Typography.Paragraph>
        </Card>
        <Card size="small" title={<><SafetyCertificateOutlined /> 安全提示</>}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Key 仅保存在本机；导出备份默认不包含 Key，避免泄露。
          </Typography.Paragraph>
        </Card>
        <Card size="small" title={<><InfoCircleOutlined /> 使用检查清单</>}>
          <ul className={styles.checklist}>
            <li>未配置 AI Key：对话 / AI 入库不可用</li>
            <li>未配置 Embedding：向量检索不可用</li>
            <li>公版书源 / 视频转写：见「喂养」</li>
          </ul>
        </Card>
      </aside>
    </>
  );
}
