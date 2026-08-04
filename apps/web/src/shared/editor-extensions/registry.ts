import { WIKILINK_EXTENSION } from "./builtin/wikilink";
import type { DeclarativeSlashItem, EditorExtensionManifest } from "./types";

const builtin: EditorExtensionManifest[] = [WIKILINK_EXTENSION];

/** 首期仅内置；E1 可在此合并已启用的声明式包 */
let installed: EditorExtensionManifest[] = [];

export function listEditorExtensions(): EditorExtensionManifest[] {
  return [...builtin, ...installed];
}

/** 测试 / 后期装包用：替换已安装的声明式扩展列表 */
export function setInstalledEditorExtensions(exts: EditorExtensionManifest[]) {
  installed = exts.slice();
}

export function hasMark(mark: "wikilink"): boolean {
  return listEditorExtensions().some((e) => e.contributes.marks?.includes(mark));
}

export function getContributedSlashItems(): DeclarativeSlashItem[] {
  const out: DeclarativeSlashItem[] = [];
  const seen = new Set<string>();
  for (const ext of listEditorExtensions()) {
    for (const item of ext.contributes.slash || []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}
