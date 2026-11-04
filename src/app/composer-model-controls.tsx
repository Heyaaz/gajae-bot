import { Check, Zap } from "lucide-react";
import type { AgentCommand, AgentConfigOption } from "../backend/types";
import { t } from "../i18n";
import { FastTierControls } from "./composer-fast-tier";
import { ModelPicker } from "./composer-model-picker";

interface ModelControlsProps {
  modelOption: AgentConfigOption;
  thinkingOption: AgentConfigOption | undefined;
  modelDisplay: string | undefined;
  currentEffort: string;
  usagePercent: number | undefined;
  fastMode: boolean;
  fastBusy: boolean;
  readOnly: boolean;
  commands: AgentCommand[];
  configMenu: string | null;
  onToggleMenu: (id: string) => void;
  onSelectConfig: (configId: string, value: string) => void;
  onSetFastTier: (fast: boolean) => Promise<void>;
}

export function ModelControls({
  modelOption,
  thinkingOption,
  modelDisplay,
  currentEffort,
  usagePercent,
  fastMode,
  fastBusy,
  readOnly,
  commands,
  configMenu,
  onToggleMenu,
  onSelectConfig: selectConfig,
  onSetFastTier,
}: ModelControlsProps) {
  return (
            <span className="composer-model">
              {/* Left enabled during a run: this popover is where the Fast tier is
                  switched, and the runtime applies a tier to the open session. A
                  model change mid-turn is refused by the runtime and surfaced by the
                  shell, which is better than hiding both controls until the turn ends. */}
              <button
                type="button"
                title="Model: /model · Effort: ⇧⇥"
                onClick={() => onToggleMenu(modelOption.id)}
              >
                <strong>
                  {modelOption.options?.find(
                    (choice) => choice.value === modelOption.currentValue,
                  )?.name ??
                    modelDisplay ??
                    String(modelOption.currentValue)}
                </strong>
                <i />
                <span>{currentEffort}</span>
                <i />
                <span>
                  {usagePercent === undefined
                    ? "—"
                    : `${usagePercent.toFixed(1)}%`}
                </span>
                {fastMode && (
                  <>
                    <i />
                    <span
                      className="composer-fast-mode"
                      title={t("Fast 모드 켜짐")}
                      aria-label={t("Fast 모드 켜짐")}
                    >
                      <Zap size={10} aria-hidden="true" />
                      Fast
                    </span>
                  </>
                )}
              </button>
              {configMenu === modelOption.id && (
                <ModelPicker
                  option={modelOption}
                  header={
                    <FastTierControls
                      commands={commands}
                      fastMode={fastMode}
                      busy={fastBusy}
                      readOnly={readOnly}
                      onSelect={(fast) => void onSetFastTier(fast)}
                    />
                  }
                  onSelect={(value) => selectConfig(modelOption.id, value)}
                />
              )}
              {thinkingOption && configMenu === thinkingOption.id && (
                <span className="config-option-menu config-option-menu--effort">
                  <header>
                    <strong>{t("추론 Effort")}</strong>
                    <small>⇧⇥</small>
                  </header>
                  {thinkingOption.options?.map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      className={
                        choice.value === thinkingOption.currentValue
                          ? "is-current"
                          : ""
                      }
                      onClick={() =>
                        selectConfig(thinkingOption.id, choice.value)
                      }
                    >
                      <span>{choice.name}</span>
                      {choice.value === thinkingOption.currentValue && (
                        <Check size={12} />
                      )}
                    </button>
                  ))}
                </span>
              )}
            </span>
  );
}
