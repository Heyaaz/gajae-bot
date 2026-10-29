import type { Dispatch, SetStateAction } from "react";
import type { HistorySession } from "../../shared/agent-contract";
import type {
  AgentConfigOption,
  AgentControlPreferences,
  AgentSession,
} from "../backend/types";
import type { AgentBackend } from "../backend/agent-backend";
import { t } from "../i18n";
import { humanErrorMessage } from "./format";

export interface SessionActionsContext {
  backend: AgentBackend;
  configOptions: Record<string, AgentConfigOption[]>;
  resolveSessionId: (sessionId: string) => Promise<string>;
  setAppError: (message: string) => void;
  setConfigOptions: Dispatch<SetStateAction<Record<string, AgentConfigOption[]>>>;
  setPreferences: Dispatch<SetStateAction<AgentControlPreferences>>;
  setSessions: Dispatch<SetStateAction<AgentSession[]>>;
  setResumeOpen: Dispatch<SetStateAction<boolean>>;
  setHistoryLoading: Dispatch<SetStateAction<boolean>>;
  setHistoryError: Dispatch<SetStateAction<string>>;
  setHistorySessions: Dispatch<SetStateAction<HistorySession[]>>;
  setResumingId: Dispatch<SetStateAction<string | null>>;
}

export function createSessionActions(context: SessionActionsContext) {
  const {
    backend,
    configOptions,
    resolveSessionId,
    setAppError,
    setConfigOptions,
    setPreferences,
    setSessions,
    setResumeOpen,
    setHistoryLoading,
    setHistoryError,
    setHistorySessions,
    setResumingId,
  } = context;
  async function setSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const previousValue = configOptions[sessionId]?.find(
      (option) => option.id === configId,
    )?.currentValue;
    setConfigOptions((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).map((option) =>
        option.id === configId ? { ...option, currentValue: value } : option,
      ),
    }));
    try {
      await backend.setSessionConfig(
        await resolveSessionId(sessionId),
        configId,
        value,
      );
    } catch (error) {
      if (previousValue !== undefined) {
        setConfigOptions((current) => ({
          ...current,
          [sessionId]: (current[sessionId] ?? []).map((option) =>
            option.id === configId && option.currentValue === value
              ? { ...option, currentValue: previousValue }
              : option,
          ),
        }));
      }
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }

  async function cycleThinking(sessionId: string): Promise<void> {
    try {
      const level = await backend.cycleThinking(
        await resolveSessionId(sessionId),
      );
      if (!level) {
        setAppError(t("현재 모델은 추론 effort 전환을 지원하지 않습니다."));
      }
    } catch (error) {
      setAppError(humanErrorMessage(error));
    }
  }

  async function compactSession(sessionId: string): Promise<void> {
    try {
      await backend.compactSession(await resolveSessionId(sessionId));
    } catch (error) {
      setAppError(humanErrorMessage(error));
    }
  }

  async function flushQueuedNow(sessionId: string): Promise<void> {
    try {
      const resolved = await resolveSessionId(sessionId);
      await backend.flushQueuedNow(resolved);
    } catch (error) {
      setAppError(humanErrorMessage(error));
      throw error;
    }
  }

  async function renameWorkspace(label: string): Promise<void> {
    try {
      const saved =
        await window.agentControlDesktop?.settings.setWorkspaceLabel(label);
      if (saved)
        setPreferences((current) => ({ ...current, workspaceLabel: saved }));
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }

  async function renameSession(
    sessionId: string,
    title: string,
  ): Promise<void> {
    // The sidebar commits a rename from Enter or blur, so no caller holds this
    // promise: a refused rename reached the renderer's unhandled-rejection queue as
    // its only record. Reporting here also makes the promise it hands back resolve.
    try {
      await backend.renameSession(await resolveSessionId(sessionId), title);
    } catch (error) {
      setAppError(humanErrorMessage(error));
    }
  }

  function openResumePicker(): void {
    setResumeOpen(true);
    setHistoryLoading(true);
    setHistoryError("");
    void backend
      .listHistorySessions()
      .then(setHistorySessions)
      .catch((error) =>
        setHistoryError(
          error instanceof Error ? error.message : String(error),
        ),
      )
      .finally(() => setHistoryLoading(false));
  }

  async function resumeSession(sessionId: string): Promise<void> {
    setResumingId(sessionId);
    setAppError("");
    try {
      const resumed = await backend.resumeSession(
        await resolveSessionId(sessionId),
      );
      setSessions((current) =>
        current.map((item) => (item.id === resumed.id ? resumed : item)),
      );
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    } finally {
      setResumingId(null);
    }
  }

  return {
    setSessionConfig,
    cycleThinking,
    compactSession,
    flushQueuedNow,
    renameWorkspace,
    renameSession,
    openResumePicker,
    resumeSession,
  };
}
