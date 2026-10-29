import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  AgentControlPreferences,
  ToolViewMode,
} from "../backend/types";
import { t } from "../i18n";
import { humanErrorMessage } from "./format";

export function usePreferenceToggles(
  settingsBridge: NonNullable<Window["agentControlDesktop"]>["settings"] | undefined,
  preferencesRef: MutableRefObject<AgentControlPreferences>,
  setPreferences: Dispatch<SetStateAction<AgentControlPreferences>>,
  setAppError: (message: string) => void,
) {
  // A card's 펼치기/접기 is optimistic: the click has to land on every visible card at
  // once, and the store is what says whether the write happened. A refused write puts
  // the previous value back, so the window never shows a preference it did not save.
  const toggleThoughtsExpanded = useCallback((): void => {
    const current = preferencesRef.current.thoughtsExpanded;
    const next = !current;
    if (!settingsBridge) {
      // A browser is the remote client of a host, and the preference belongs to the host.
      setAppError(t("설정은 Gajae 데스크톱 앱에서 열 수 있습니다."));
      return;
    }
    setPreferences((latest) => ({ ...latest, thoughtsExpanded: next }));
    void settingsBridge.setThoughtsExpanded(next).then(
      (saved) =>
        setPreferences((latest) => ({
          ...latest,
          thoughtsExpanded: saved,
        })),
      (error: unknown) => {
        setPreferences((latest) => ({
          ...latest,
          thoughtsExpanded: current,
        }));
        setAppError(humanErrorMessage(error));
      },
    );
  }, [settingsBridge]);
  // The header density selector is optimistic for the same reason as the thought
  // toggle: the click has to land immediately, while the store is the authority on
  // whether it persisted. A browser has no host settings bridge, so the density
  // stays local to that client instead of pretending to save on the host.
  const changeToolViewMode = useCallback(
    (next: ToolViewMode): void => {
      const current = preferencesRef.current.toolViewMode;
      if (next === current) return;
      setPreferences((latest) => ({ ...latest, toolViewMode: next }));
      if (!settingsBridge) return;
      void settingsBridge.setToolViewMode(next).then(
        (saved) =>
          setPreferences((latest) => ({ ...latest, toolViewMode: saved })),
        (error: unknown) => {
          setPreferences((latest) => ({
            ...latest,
            toolViewMode: current,
          }));
          setAppError(humanErrorMessage(error));
        },
      );
    },
    [settingsBridge],
  );

  return { toggleThoughtsExpanded, changeToolViewMode };
}
