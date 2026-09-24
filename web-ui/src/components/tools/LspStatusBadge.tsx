import type { FileScope } from "@/api/types";
import { useLspStatus } from "@/hooks/useLspStatus";

interface LspStatusBadgeProps {
  api: unknown;
  worktreeId: string | null;
  scope?: FileScope;
  path?: string | null;
}

export function LspStatusBadge({ api, worktreeId, scope = "worktree", path }: LspStatusBadgeProps) {
  const { status, text, isClickable, title, onClick } = useLspStatus(api, worktreeId, scope, path);

  if (!status || !text) return null;

  return (
    <span
      className={`lsp-status-badge lsp-status-badge--${status}${isClickable ? " lsp-status-badge--clickable" : ""}`}
      data-status={status}
      title={title ?? text}
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={isClickable ? onClick : undefined}
    >
      {text}
    </span>
  );
}
