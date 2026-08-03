/**
 * TipTap markdown 往返时，部分版本会把 `[[wikilink]]` 写成 `\[\[wikilink\]\]`。
 * 图谱解析依赖字面双链，导出前还原。
 */
export function restoreWikilinkMarkers(md: string): string {
  if (!md) return "";
  return md.replace(/\\\[\\\[([^\]\n]+?)\\\]\\\]/g, "[[$1]]").replace(/\\\[\[/g, "[[").replace(/\]\\\]/g, "]]");
}
