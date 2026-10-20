import { Component, type ReactNode } from "react";
import { t } from "../i18n";

interface LazyViewBoundaryState {
  failed: boolean;
}

/**
 * Keeps a failed screen chunk from blanking the rest of the app.
 *
 * The first paint does not need these screens, so they load on demand. A stale
 * deployment or a dropped connection can make that import reject; without a
 * boundary the rejection unmounts the whole shell. Reloading is the one retry
 * that is guaranteed to fetch a fresh chunk.
 */
export class LazyViewBoundary extends Component<
  { children: ReactNode },
  LazyViewBoundaryState
> {
  state: LazyViewBoundaryState = { failed: false };

  static getDerivedStateFromError(): LazyViewBoundaryState {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="lazy-view-error" role="alert">
        <strong>{t("화면을 불러오지 못했습니다.")}</strong>
        <button
          type="button"
          className="button-secondary"
          onClick={() => window.location.reload()}
        >
          {t("다시 불러오기")}
        </button>
      </div>
    );
  }
}
