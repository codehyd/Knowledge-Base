import { useEffect, useState } from "react";
import { App } from "antd";
import { api } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import type { TestResult } from "../types";

export function useDbSettings(active: boolean) {
  const { message } = App.useApp();
  const [dbMode, setDbMode] = useState<"sqlite" | "postgres">("sqlite");
  const [sqlitePath, setSqlitePath] = useState("data/kongku.db");
  const [pgHost, setPgHost] = useState("");
  const [pgPort, setPgPort] = useState("5432");
  const [pgDatabase, setPgDatabase] = useState("");
  const [pgUsername, setPgUsername] = useState("");
  const [pgPassword, setPgPassword] = useState("");
  const [postgresConfigured, setPostgresConfigured] = useState(false);
  const [dbConnected, setDbConnected] = useState(false);
  const [dbSchemaReady, setDbSchemaReady] = useState(false);
  const [dbSchemaMessage, setDbSchemaMessage] = useState("");
  const [dbMissingTables, setDbMissingTables] = useState<string[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbSaving, setDbSaving] = useState(false);
  const [dbTesting, setDbTesting] = useState(false);
  const [dbInitializing, setDbInitializing] = useState(false);
  const [dbTestResult, setDbTestResult] = useState<TestResult | null>(null);
  const [dbTestPassed, setDbTestPassed] = useState(false);
  const [dbTestedKey, setDbTestedKey] = useState("");

  function applyDbSnapshot(db: Awaited<ReturnType<typeof api.getDbSettings>>) {
    setDbMode(db.mode);
    setSqlitePath(db.sqlite_path || "kongku.db");
    setPostgresConfigured(db.postgres_configured);
    setPgHost(db.postgres_host || "");
    setPgPort(db.postgres_port || "5432");
    setPgDatabase(db.postgres_database || "");
    setPgUsername(db.postgres_username || "");
    setPgPassword("");
    setDbConnected(db.connected);
    setDbSchemaReady(Boolean(db.schema_ready));
    setDbSchemaMessage(db.schema_message || "");
    setDbMissingTables(db.missing_tables || []);
  }

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      setDbLoading(true);
      try {
        const db = await api.getDbSettings();
        if (cancelled) return;
        applyDbSnapshot(db);
        setDbTestPassed(false);
        setDbTestedKey("");
        setDbTestResult(null);
      } catch (err) {
        if (!cancelled) message.error(formatError(err, "读取数据库配置失败"));
      } finally {
        if (!cancelled) setDbLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, message]);

  function postgresFormKey() {
    return [
      pgHost.trim(),
      pgPort.trim() || "5432",
      pgDatabase.trim(),
      pgUsername.trim(),
      pgPassword ? pgPassword : postgresConfigured ? "__saved_pwd__" : "",
    ].join("|");
  }

  function invalidateDbTest() {
    setDbTestPassed(false);
    setDbTestedKey("");
  }

  async function onDbTest() {
    if (dbMode === "postgres") {
      if (!pgHost.trim() || !pgDatabase.trim() || !pgUsername.trim()) {
        message.warning("请填写主机、数据库名和用户名");
        return;
      }
      if (!pgPassword && !postgresConfigured) {
        message.warning("请填写密码");
        return;
      }
    }
    setDbTesting(true);
    try {
      const data = await api.testDbSettings({
        mode: dbMode,
        sqlite_path: sqlitePath || "kongku.db",
        postgres_host: pgHost,
        postgres_port: pgPort || "5432",
        postgres_database: pgDatabase,
        postgres_username: pgUsername,
        postgres_password: pgPassword || undefined,
      });
      const result: TestResult = {
        ok: data.ok,
        message: data.message,
        at: new Date().toLocaleString(),
      };
      setDbTestResult(result);
      if (data.ok) {
        setDbTestPassed(true);
        setDbTestedKey(postgresFormKey());
        message.success("数据库连接成功");
      } else {
        invalidateDbTest();
        message.error(data.message || "连接失败");
      }
    } catch (err) {
      invalidateDbTest();
      message.error(formatError(err, "测试失败"));
      setDbTestResult({
        ok: false,
        message: formatError(err, "测试失败"),
        at: new Date().toLocaleString(),
      });
    } finally {
      setDbTesting(false);
    }
  }

  async function onDbSave() {
    if (dbMode === "postgres") {
      if (!dbTestPassed) {
        message.warning("请先测试连接成功后再保存");
        return;
      }
      if (dbTestedKey !== postgresFormKey()) {
        message.warning("连接信息已变更，请重新测试连接");
        return;
      }
    }
    setDbSaving(true);
    try {
      const db = await api.saveDbSettings({
        mode: dbMode,
        sqlite_path: sqlitePath || "kongku.db",
        postgres_host: pgHost,
        postgres_port: pgPort || "5432",
        postgres_database: pgDatabase,
        postgres_username: pgUsername,
        postgres_password: pgPassword || undefined,
      });
      applyDbSnapshot(db);
      if (dbMode === "postgres" && !db.schema_ready) {
        message.success("已切换到 Postgres，请点击「初始化表结构」完成建表");
      } else {
        message.success("已切换数据库，正在刷新…");
        window.setTimeout(() => {
          window.location.reload();
        }, 400);
        return;
      }
    } catch (err) {
      message.error(formatError(err, "切换失败"));
    } finally {
      setDbSaving(false);
    }
  }

  async function onDbInitSchema() {
    setDbInitializing(true);
    try {
      const result = await api.initDbSchema();
      const db = await api.getDbSettings();
      applyDbSnapshot(db);
      if (result.ok && result.schema_ready) {
        message.success(result.message || "表结构已初始化");
        window.setTimeout(() => {
          window.location.reload();
        }, 500);
      } else {
        message.error(result.message || "初始化未完成");
      }
    } catch (err) {
      message.error(formatError(err, "初始化失败"));
    } finally {
      setDbInitializing(false);
    }
  }

  function onDbModeChange(next: "sqlite" | "postgres") {
    setDbMode(next);
    invalidateDbTest();
    setDbTestResult(null);
  }

  return {
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
  };
}
