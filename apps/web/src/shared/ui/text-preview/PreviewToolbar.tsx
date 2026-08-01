import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { Button, Input, Select, Typography } from "antd";
import {
  FONT_SIZE_KEY,
  FONT_SIZE_OPTIONS,
  FONT_WEIGHT_KEY,
  FONT_WEIGHT_OPTIONS,
} from "./previewProgress";
import styles from "./TextPreviewModal.module.css";

type Props = {
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  searching: boolean;
  hitTotal: number;
  globalIndex: number;
  activeQuery: string;
  onGoHit: (delta: number) => void;
  fontSize: number;
  fontWeight: number;
  onFontSizeChange: (size: number) => void;
  onFontWeightChange: (weight: number) => void;
};

export function PreviewToolbar({
  query,
  onQueryChange,
  onSearch,
  searching,
  hitTotal,
  globalIndex,
  activeQuery,
  onGoHit,
  fontSize,
  fontWeight,
  onFontSizeChange,
  onFontWeightChange,
}: Props) {
  function changeFontSize(size: number) {
    onFontSizeChange(size);
    try {
      localStorage.setItem(FONT_SIZE_KEY, String(size));
    } catch {
      /* ignore */
    }
  }

  function changeFontWeight(weight: number) {
    onFontWeightChange(weight);
    try {
      localStorage.setItem(FONT_WEIGHT_KEY, String(weight));
    } catch {
      /* ignore */
    }
  }

  return (
    <div className={styles.toolbar}>
      <Input
        allowClear
        prefix={<SearchOutlined />}
        placeholder="搜索正文并跳转定位"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onPressEnter={() => void onSearch()}
        className={styles.searchInput}
      />
      <Button type="primary" loading={searching} onClick={() => void onSearch()}>
        搜索
      </Button>
      <div className={styles.hitNav}>
        <Button
          type="text"
          size="small"
          className={styles.hitNavBtn}
          icon={<ArrowUpOutlined />}
          disabled={!hitTotal}
          loading={searching}
          onClick={() => void onGoHit(-1)}
          aria-label="上一个"
        />
        <Button
          type="text"
          size="small"
          className={styles.hitNavBtn}
          icon={<ArrowDownOutlined />}
          disabled={!hitTotal}
          loading={searching}
          onClick={() => void onGoHit(1)}
          aria-label="下一个"
        />
      </div>
      <Typography.Text type="secondary" className={styles.hitMeta}>
        {hitTotal > 0 && globalIndex >= 0
          ? `${globalIndex + 1} / ${hitTotal}`
          : activeQuery
            ? "无匹配"
            : ""}
      </Typography.Text>
      <div className={styles.fontControls}>
        <Select
          size="small"
          value={fontSize}
          className={styles.fontSelect}
          options={FONT_SIZE_OPTIONS.map((n) => ({ value: n, label: `${n}px` }))}
          onChange={(v) => changeFontSize(Number(v))}
          aria-label="字号"
        />
        <Select
          size="small"
          value={fontWeight}
          className={styles.fontSelect}
          options={FONT_WEIGHT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => changeFontWeight(Number(v))}
          aria-label="字重"
        />
      </div>
    </div>
  );
}
