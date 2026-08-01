import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SettingsSubNav } from "./SettingsSubNav";
import { useAiSettings } from "./hooks/useAiSettings";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { useDbSettings } from "./hooks/useDbSettings";
import { useFeedSettings } from "./hooks/useFeedSettings";
import { useLibrarySettings } from "./hooks/useLibrarySettings";
import { AboutSettingsPanel } from "./panels/AboutSettingsPanel";
import { DatabaseSettingsPanel } from "./panels/DatabaseSettingsPanel";
import { FeedSettingsPanel } from "./panels/FeedSettingsPanel";
import { LibrarySettingsPanel } from "./panels/LibrarySettingsPanel";
import { ModelSettingsPanel } from "./panels/ModelSettingsPanel";
import type { FeedTab, SubNav } from "./types";
import styles from "./SettingsPage.module.css";

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [subNav, setSubNav] = useState<SubNav>("model");
  const [feedTab, setFeedTab] = useState<FeedTab>("general");

  const ai = useAiSettings();
  const feed = useFeedSettings(subNav === "feed");
  const db = useDbSettings(subNav === "database");
  const library = useLibrarySettings(subNav === "library");
  const update = useAppUpdate();

  useEffect(() => {
    const keys = (searchParams.get("keys") || "").trim().toLowerCase();
    if (keys === "books" || keys === "ctext") {
      setSubNav("feed");
      setFeedTab("books");
    } else if (keys === "media" || keys === "asr" || keys === "video") {
      setSubNav("feed");
      setFeedTab("media");
    } else if (keys === "ai" || keys === "model") {
      setSubNav("model");
    }
  }, [searchParams]);

  return (
    <section className={styles.page}>
      <SettingsSubNav subNav={subNav} onSubNavChange={setSubNav} />

      {subNav === "model" ? (
        <ModelSettingsPanel
          loading={ai.loading}
          saving={ai.saving}
          testing={ai.testing}
          providers={ai.providers}
          providerId={ai.providerId}
          baseUrl={ai.baseUrl}
          apiKey={ai.apiKey}
          chatModel={ai.chatModel}
          embedModel={ai.embedModel}
          customChat={ai.customChat}
          customEmbed={ai.customEmbed}
          masked={ai.masked}
          configured={ai.configured}
          chatMaxTokens={ai.chatMaxTokens}
          quoteRefineMaxTokens={ai.quoteRefineMaxTokens}
          testResult={ai.testResult}
          current={ai.current}
          chatOptions={ai.chatOptions}
          embedOptions={ai.embedOptions}
          setBaseUrl={ai.setBaseUrl}
          setApiKey={ai.setApiKey}
          setChatModel={ai.setChatModel}
          setEmbedModel={ai.setEmbedModel}
          setCustomChat={ai.setCustomChat}
          setCustomEmbed={ai.setCustomEmbed}
          setChatMaxTokens={ai.setChatMaxTokens}
          setQuoteRefineMaxTokens={ai.setQuoteRefineMaxTokens}
          onProviderChange={ai.onProviderChange}
          onSave={ai.onSave}
          onTest={ai.onTest}
        />
      ) : null}

      {subNav === "database" ? (
        <DatabaseSettingsPanel
          dbMode={db.dbMode}
          sqlitePath={db.sqlitePath}
          pgHost={db.pgHost}
          pgPort={db.pgPort}
          pgDatabase={db.pgDatabase}
          pgUsername={db.pgUsername}
          pgPassword={db.pgPassword}
          postgresConfigured={db.postgresConfigured}
          dbConnected={db.dbConnected}
          dbSchemaReady={db.dbSchemaReady}
          dbSchemaMessage={db.dbSchemaMessage}
          dbMissingTables={db.dbMissingTables}
          dbLoading={db.dbLoading}
          dbSaving={db.dbSaving}
          dbTesting={db.dbTesting}
          dbInitializing={db.dbInitializing}
          dbTestResult={db.dbTestResult}
          dbTestPassed={db.dbTestPassed}
          setPgHost={db.setPgHost}
          setPgPort={db.setPgPort}
          setPgDatabase={db.setPgDatabase}
          setPgUsername={db.setPgUsername}
          setPgPassword={db.setPgPassword}
          invalidateDbTest={db.invalidateDbTest}
          onDbModeChange={db.onDbModeChange}
          onDbTest={db.onDbTest}
          onDbSave={db.onDbSave}
          onDbInitSchema={db.onDbInitSchema}
        />
      ) : null}

      {subNav === "feed" ? (
        <FeedSettingsPanel
          feedTab={feedTab}
          onFeedTabChange={setFeedTab}
          setSearchParams={setSearchParams}
          feedLoading={feed.feedLoading}
          feedSaving={feed.feedSaving}
          directIngest={feed.directIngest}
          feedDesc={feed.feedDesc}
          ctextKey={feed.ctextKey}
          ctextMasked={feed.ctextMasked}
          ctextConfigured={feed.ctextConfigured}
          ctextKeysUrl={feed.ctextKeysUrl}
          ctextDocsUrl={feed.ctextDocsUrl}
          ctextHint={feed.ctextHint}
          ctextSaving={feed.ctextSaving}
          mirrorRepo={feed.mirrorRepo}
          mirrorRef={feed.mirrorRef}
          mirrorHint={feed.mirrorHint}
          mirrorPresets={feed.mirrorPresets}
          mirrorSaving={feed.mirrorSaving}
          mediaCookiesReady={feed.mediaCookiesReady}
          mediaLoginBusy={feed.mediaLoginBusy}
          allowLocalAudio={ai.allowLocalAudio}
          asrMode={ai.asrMode}
          asrBaseUrl={ai.asrBaseUrl}
          asrApiKey={ai.asrApiKey}
          asrMasked={ai.asrMasked}
          asrModel={ai.asrModel}
          asrLocalModel={ai.asrLocalModel}
          saving={ai.saving}
          desktop={feed.desktop}
          setDirectIngest={feed.setDirectIngest}
          setCtextKey={feed.setCtextKey}
          setMirrorRepo={feed.setMirrorRepo}
          setMirrorRef={feed.setMirrorRef}
          setAllowLocalAudio={ai.setAllowLocalAudio}
          setAsrMode={ai.setAsrMode}
          setAsrLocalModel={ai.setAsrLocalModel}
          setAsrBaseUrl={ai.setAsrBaseUrl}
          setAsrApiKey={ai.setAsrApiKey}
          setAsrModel={ai.setAsrModel}
          onSaveFeedSettings={feed.onSaveFeedSettings}
          onSaveCtextKey={feed.onSaveCtextKey}
          onClearCtextKey={feed.onClearCtextKey}
          onSaveMirror={feed.onSaveMirror}
          onLoginDouyin={feed.onLoginDouyin}
          onSaveMediaSettings={ai.onSaveMediaSettings}
        />
      ) : null}

      {subNav === "library" ? (
        <LibrarySettingsPanel
          library={library.library}
          libraryLoading={library.libraryLoading}
          libraryRebuilding={library.libraryRebuilding}
          libraryCatKey={library.libraryCatKey}
          libraryCats={library.libraryCats}
          activeLibraryCat={library.activeLibraryCat}
          setLibraryCatKey={library.setLibraryCatKey}
          navigate={library.navigate}
          onRebuildLibrary={library.onRebuildLibrary}
          onOpenLibraryPath={library.onOpenLibraryPath}
          onDeleteLibraryItem={library.onDeleteLibraryItem}
        />
      ) : null}

      {subNav === "about" ? (
        <AboutSettingsPanel
          desktop={update.desktop}
          appVersion={update.appVersion}
          isPackaged={update.isPackaged}
          checkingUpdate={update.checkingUpdate}
          downloadingUpdate={update.downloadingUpdate}
          updatePercent={update.updatePercent}
          updateTransferred={update.updateTransferred}
          updateTotal={update.updateTotal}
          updateSpeed={update.updateSpeed}
          remoteVersion={update.remoteVersion}
          updateReady={update.updateReady}
          updateStatus={update.updateStatus}
          onCheckUpdate={update.onCheckUpdate}
          onDownloadUpdate={update.onDownloadUpdate}
          onInstallUpdate={update.onInstallUpdate}
          onOpenReleases={update.onOpenReleases}
        />
      ) : null}
    </section>
  );
}
