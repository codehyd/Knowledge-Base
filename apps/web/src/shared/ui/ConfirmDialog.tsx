import type { ReactNode } from "react";
import styles from "./ConfirmDialog.module.css";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  titleId: string;
  onMaskClick?: () => void;
  maskCloseDisabled?: boolean;
  children: ReactNode;
  actions: ReactNode;
};

export function ConfirmDialog({
  open,
  title,
  titleId,
  onMaskClick,
  maskCloseDisabled,
  children,
  actions,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div
      className={styles.confirmMask}
      onClick={() => {
        if (!maskCloseDisabled) onMaskClick?.();
      }}
      role="presentation"
    >
      <div
        className={styles.confirmCard}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div id={titleId} className={styles.confirmTitle}>
          {title}
        </div>
        <div className={styles.confirmBody}>{children}</div>
        <div className={styles.confirmActions}>{actions}</div>
      </div>
    </div>
  );
}

export { styles as confirmDialogStyles };
