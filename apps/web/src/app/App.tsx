import { Route, Routes } from "react-router-dom";
import { AppLayout } from "@/shared/ui/AppLayout";
import { HomePage } from "@/features/home/HomePage";
import { FeedPage } from "@/features/feed/FeedPage";
import { ChatPage } from "@/features/chat/ChatPage";
import { KnowledgePage } from "@/features/knowledge/KnowledgePage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { NotFoundPage } from "@/features/not-found/NotFoundPage";

/**
 * 前端也按功能分目录（features/*）。
 * 新增功能：加 feature 目录 + 这里一条 Route 即可。
 */
export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<HomePage />} />
        <Route path="feed" element={<FeedPage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
