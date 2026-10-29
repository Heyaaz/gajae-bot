import { useCallback, useMemo } from "react";
import type {
  AgentCommand,
  AgentConfigOption,
  AgentSession,
  BackendConnection,
} from "../backend/types";
import type { AgentBackend } from "../backend/agent-backend";
import { DEFAULT_MODEL_PRESET } from "../../shared/agent-contract";
import { t } from "../i18n";
import { BUNDLED_GJC_COMMANDS } from "./format";

export function useComposerModel(
  backend: AgentBackend,
  commands: Record<string, AgentCommand[]>,
  configOptions: Record<string, AgentConfigOption[]>,
  selectedId: string | null,
  selectedSession: AgentSession | null,
  connection: BackendConnection,
  language: string,
) {
  const selectedCommands = useMemo(() => {
    const live = selectedId ? (commands[selectedId] ?? []) : [];
    return [
      ...new Map(
        [...BUNDLED_GJC_COMMANDS, ...live].map((command) => [
          command.name,
          {
            ...command,
            description: t(command.description),
            ...(command.hint ? { hint: t(command.hint) } : {}),
          },
        ]),
      ).values(),
    ];
  }, [commands, selectedId, language]);
  const selectedConfigOptions = useMemo(
    () => (selectedId && configOptions[selectedId]) || [],
    [configOptions, selectedId],
  );
  // An undefined command list means the live palette has not arrived yet. A
  // terminal-only or recovering row has no SDK endpoint to answer, so it is not
  // left claiming a load that can never finish.
  const commandsPending =
    selectedId !== null &&
    commands[selectedId] === undefined &&
    selectedSession?.attachment !== "terminal-only" &&
    selectedSession?.attachment !== "recovering";
  const onCommandPaletteOpen = useCallback(() => {
    if (!selectedId) return;
    void backend.refreshSessionContext?.(selectedId).catch(() => undefined);
  }, [backend, selectedId]);
  const composerModelPreset =
    selectedSession?.model ?? connection.modelPreset ?? DEFAULT_MODEL_PRESET;
  const composerConfigOptions = useMemo(() => {
    if (
      selectedConfigOptions.some(
        (option) => option.category === "model" || option.id === "model",
      )
    )
      return selectedConfigOptions;
    return [
      {
        id: "model",
        name: t("프리셋"),
        category: "model",
        type: "select" as const,
        currentValue: composerModelPreset,
        options: [
          {
            value: composerModelPreset,
            name: selectedSession?.modelDisplay ?? t("모델 확인 중…"),
          },
        ],
      },
      ...selectedConfigOptions,
    ];
  }, [
    composerModelPreset,
    language,
    selectedConfigOptions,
    selectedSession?.modelDisplay,
  ]);

  return {
    selectedCommands,
    commandsPending,
    onCommandPaletteOpen,
    composerConfigOptions,
  };
}
