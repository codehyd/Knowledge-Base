import { InfoCircleOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Radio,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import type { TestResult } from "../types";
import styles from "../SettingsPage.module.css";

type DatabaseSettingsPanelProps = {
  dbMode: "sqlite" | "postgres";
  sqlitePath: string;
  pgHost: string;
  pgPort: string;
  pgDatabase: string;
  pgUsername: string;
  pgPassword: string;
  postgresConfigured: boolean;
  dbConnected: boolean;
  dbSchemaReady: boolean;
  dbSchemaMessage: string;
  dbMissingTables: string[];
  dbLoading: boolean;
  dbSaving: boolean;
  dbTesting: boolean;
  dbInitializing: boolean;
  dbTestResult: TestResult | null;
  dbTestPassed: boolean;
  setPgHost: (v: string) => void;
  setPgPort: (v: string) => void;
  setPgDatabase: (v: string) => void;
  setPgUsername: (v: string) => void;
  setPgPassword: (v: string) => void;
  invalidateDbTest: () => void;
  onDbModeChange: (mode: "sqlite" | "postgres") => void;
  onDbTest: () => void;
  onDbSave: () => void;
  onDbInitSchema: () => void;
};

export function DatabaseSettingsPanel({
  dbMode,
  sqlitePath,
  pgHost,
  pgPort,
  pgDatabase,
  pgUsername,
  pgPassword,
  postgresConfigured,
  dbConnected,
  dbSchemaReady,
  dbSchemaMessage,
  dbMissingTables,
  dbLoading,
  dbSaving,
  dbTesting,
  dbInitializing,
  dbTestResult,
  dbTestPassed,
  setPgHost,
  setPgPort,
  setPgDatabase,
  setPgUsername,
  setPgPassword,
  invalidateDbTest,
  onDbModeChange,
  onDbTest,
  onDbSave,
  onDbInitSchema,
}: DatabaseSettingsPanelProps) {
  return (
    <>
      <div className={styles.content}>
        <div className={styles.contentHead}>
          <div>
            <h1>数据库</h1>
            <p className={styles.desc}>
              个人版默认本地 SQLite（首次启动自动建表）。Postgres 需先保存连接，再手动初始化表结构；换库不会自动迁移数据。
            </p>
          </div>
          <Space size={8} wrap>
            <Tag color={dbConnected ? "success" : "warning"}>
              {dbConnected ? "已连接" : "未连接"}
            </Tag>
            <Tag color={dbSchemaReady ? "success" : "warning"}>
              {dbSchemaReady ? "表结构就绪" : "表结构未就绪"}
            </Tag>
          </Space>
        </div>

        {dbLoading ? (
          <div className={styles.loading}>
            <Spin /> 正在加载数据库配置…
          </div>
        ) : (
          <>
            <div className={styles.contentBody}>
              <Form layout="vertical" className={styles.form}>
                <Form.Item label="模式" required>
                  <Radio.Group
                    value={dbMode}
                    onChange={(e) => onDbModeChange(e.target.value)}
                    optionType="button"
                    buttonStyle="solid"
                    options={[
                      { value: "sqlite", label: "本地 SQLite（推荐）" },
                      { value: "postgres", label: "自备 Postgres（高级）" },
                    ]}
                  />
                </Form.Item>

                {dbMode === "sqlite" ? (
                  <Form.Item
                    label="本地数据库"
                    extra="由应用自动管理；首次启动会自动创建表并写入默认配置。"
                  >
                    <Input value={sqlitePath || "kongku.db"} readOnly disabled />
                  </Form.Item>
                ) : (
                  <>
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 16 }}
                      message="需要你自己提供的 Postgres 连接信息"
                      description="先测试并保存连接，再点击「初始化表结构」创建业务表。不会自动迁移本地库数据。"
                    />
                    <Form.Item label="主机地址" required>
                      <Input
                        value={pgHost}
                        onChange={(e) => {
                          setPgHost(e.target.value);
                          invalidateDbTest();
                        }}
                        placeholder="请输入 Postgres 主机地址"
                        autoComplete="off"
                      />
                    </Form.Item>
                    <Form.Item label="端口" required>
                      <Input
                        value={pgPort}
                        onChange={(e) => {
                          setPgPort(e.target.value);
                          invalidateDbTest();
                        }}
                        placeholder="请输入 Postgres 端口"
                        autoComplete="off"
                      />
                    </Form.Item>
                    <Form.Item label="数据库名称" required>
                      <Input
                        value={pgDatabase}
                        onChange={(e) => {
                          setPgDatabase(e.target.value);
                          invalidateDbTest();
                        }}
                        placeholder="请输入 Postgres 数据库名称"
                        autoComplete="off"
                      />
                    </Form.Item>
                    <Form.Item label="用户名" required>
                      <Input
                        value={pgUsername}
                        onChange={(e) => {
                          setPgUsername(e.target.value);
                          invalidateDbTest();
                        }}
                        placeholder="请输入 Postgres 用户名"
                        autoComplete="off"
                      />
                    </Form.Item>
                    <Form.Item
                      label="密码"
                      required={!postgresConfigured}
                      extra={
                        postgresConfigured
                          ? "已保存过密码；留空则保持原密码，修改任意项后需重新测试。"
                          : undefined
                      }
                    >
                      <Input.Password
                        value={pgPassword}
                        onChange={(e) => {
                          setPgPassword(e.target.value);
                          invalidateDbTest();
                        }}
                        placeholder={
                          postgresConfigured ? "留空则保持原密码" : "请输入 Postgres 密码"
                        }
                        autoComplete="new-password"
                      />
                    </Form.Item>
                  </>
                )}

                {!dbSchemaReady && dbConnected ? (
                  <Alert
                    style={{ marginBottom: 12 }}
                    type="warning"
                    showIcon
                    message="表结构未就绪"
                    description={
                      dbMissingTables.length
                        ? `缺少表：${dbMissingTables.join("、")}。${dbSchemaMessage}`
                        : dbSchemaMessage || "请点击下方「初始化表结构」。"
                    }
                  />
                ) : null}

                {dbMode === "postgres" && !dbTestPassed ? (
                  <Alert
                    style={{ marginBottom: 12 }}
                    type="warning"
                    showIcon
                    message="请先测试连接成功后，才能保存自备 Postgres 配置"
                  />
                ) : null}

                {dbTestResult && (
                  <Alert
                    className={styles.testAlert}
                    type={dbTestResult.ok ? "success" : "error"}
                    showIcon
                    message={dbTestResult.ok ? "数据库测试成功" : "数据库测试失败"}
                    description={
                      <div>
                        <div>{dbTestResult.message}</div>
                        <div>时间：{dbTestResult.at}</div>
                      </div>
                    }
                  />
                )}
              </Form>
            </div>
            <div className={styles.contentFooter}>
              {dbMode === "postgres" ? (
                <>
                  <Button onClick={() => void onDbTest()} loading={dbTesting} disabled={dbSaving}>
                    测试连接
                  </Button>
                  <Button
                    type="primary"
                    loading={dbSaving}
                    disabled={dbTesting || !dbTestPassed}
                    onClick={() => void onDbSave()}
                  >
                    保存并切换
                  </Button>
                </>
              ) : (
                <Button type="primary" loading={dbSaving} onClick={() => void onDbSave()}>
                  切换回本地库
                </Button>
              )}
              <Button
                onClick={() => void onDbInitSchema()}
                loading={dbInitializing}
                disabled={!dbConnected || dbSaving || dbTesting}
              >
                初始化表结构
              </Button>
            </div>
          </>
        )}
      </div>

      <aside className={styles.tips}>
        <Card size="small" title={<><InfoCircleOutlined /> 说明</>}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            连接配置保存在本机 data/runtime-db.json。SQLite 启动时自动建表；Postgres
            保存连接后需手动初始化表结构。
          </Typography.Paragraph>
        </Card>
        <Card size="small" title={<><SafetyCertificateOutlined /> 注意</>}>
          <ul className={styles.checklist}>
            <li>本地 SQLite：首次启动自动对齐表与默认配置</li>
            <li>自备 Postgres：测试 → 保存 → 初始化表结构</li>
            <li>切换数据库不会自动迁移数据</li>
          </ul>
        </Card>
      </aside>
    </>
  );
}
