import { Suspense, lazy } from "react";
import { Route, Routes } from "react-router-dom";
import { AppLayout } from "@/shared/ui/AppLayout";

/**
 * 路由懒加载：避免首屏打进 force-graph / 语雀编辑器等重模块，
 * 否则 boot-splash「正在进入空库…」会卡很久。
 */
const HomePage = lazy(() =>
  import("@/features/home/HomePage").then((m) => ({ default: m.HomePage })),
);
const FeedPage = lazy(() =>
  import("@/features/feed/FeedPage").then((m) => ({ default: m.FeedPage })),
);
const ChatPage = lazy(() =>
  import("@/features/chat/ChatPage").then((m) => ({ default: m.ChatPage })),
);
const KnowledgePage = lazy(() =>
  import("@/features/knowledge/KnowledgePage").then((m) => ({
    default: m.KnowledgePage,
  })),
);
const SettingsPage = lazy(() =>
  import("@/features/settings/SettingsPage").then((m) => ({
    default: m.SettingsPage,
  })),
);
const SkillsPage = lazy(() =>
  import("@/features/skills/SkillsPage").then((m) => ({ default: m.SkillsPage })),
);
const NotesPage = lazy(() =>
  import("@/features/notes/NotesPage").then((m) => ({ default: m.NotesPage })),
);
const NotFoundPage = lazy(() =>
  import("@/features/not-found/NotFoundPage").then((m) => ({
    default: m.NotFoundPage,
  })),
);

function RouteFallback() {
  return (
    <div
      style={{
        padding: 48,
        color: "#64748b",
        fontSize: 14,
        fontFamily: '"IBM Plex Sans", "PingFang SC", sans-serif',
      }}
    >
      加载中…
    </div>
  );
}

export function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<HomePage />} />
          <Route path="feed" element={<FeedPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="knowledge" element={<KnowledgePage />} />
          <Route path="notes" element={<NotesPage />} />
          <Route path="skills" element={<SkillsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
