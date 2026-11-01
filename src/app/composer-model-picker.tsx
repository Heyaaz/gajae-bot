import { useState, type ReactNode } from "react";
import { Check, Search, Star } from "lucide-react";
import type { AgentConfigOption, AgentConfigOptionValue } from "../../shared/agent-contract";
import { configOptionGroups } from "./format";
import { t } from "../i18n";

const FAVORITES_KEY = "gajae:model-favorites";
/** A catalog can list a thousand models; a search shows this many at most. */
const SEARCH_LIMIT = 60;

function readFavorites(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
    return Array.isArray(stored)
      ? stored.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function useFavorites() {
  const [favorites, setFavorites] = useState(readFavorites);
  function toggle(value: string) {
    setFavorites((current) => {
      const next = current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value];
      try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      } catch {
        // Favorites stay for this window when storage is unavailable.
      }
      return next;
    });
  }
  return { favorites, toggle };
}

type Tab = "presets" | "models";

/** In use first, then favorites in the order they were starred. */
function pinned(
  choices: AgentConfigOptionValue[],
  current: unknown,
  favorites: string[],
): AgentConfigOptionValue[] {
  const byValue = new Map(choices.map((choice) => [choice.value, choice]));
  const values = [
    ...(typeof current === "string" && byValue.has(current) ? [current] : []),
    ...favorites.filter((value) => value !== current && byValue.has(value)),
  ];
  return values.map((value) => byValue.get(value)!);
}

export function ModelPicker({
  option,
  header,
  onSelect,
}: {
  option: AgentConfigOption;
  /** Controls that sit beside the title, such as the Fast tier switch. */
  header?: ReactNode;
  onSelect(value: string): void;
}) {
  const { favorites, toggle } = useFavorites();
  const choices = option.options ?? [];
  const profiles = choices.filter((choice) => choice.kind !== "model");
  const models = choices.filter((choice) => choice.kind === "model");
  const currentIsModel = models.some((model) => model.value === option.currentValue);
  const [tab, setTab] = useState<Tab>(currentIsModel ? "models" : "presets");
  const [query, setQuery] = useState("");
  const shownTab: Tab = models.length > 0 ? tab : "presets";

  const sections = (() => {
    const list = shownTab === "presets" ? profiles : models;
    const top = pinned(list, option.currentValue, favorites);
    const topValues = new Set(top.map((choice) => choice.value));
    const head = top.length > 0 ? [{ name: t("사용 중·즐겨찾기"), options: top }] : [];
    if (shownTab === "presets")
      return [
        ...head,
        ...configOptionGroups(profiles.filter((choice) => !topValues.has(choice.value)))
          .filter((group) => group.options.length > 0),
      ];
    const needle = query.trim().toLowerCase();
    if (!needle) return head;
    const matches = models.filter(
      (model) =>
        model.value.toLowerCase().includes(needle) ||
        model.name.toLowerCase().includes(needle),
    );
    return [
      {
        name:
          matches.length > SEARCH_LIMIT
            ? t`검색 결과 ${matches.length}개 중 ${SEARCH_LIMIT}개`
            : t`검색 결과 ${matches.length}개`,
        options: matches.slice(0, SEARCH_LIMIT),
      },
    ];
  })();

  return (
    <span className="config-option-menu config-option-menu--model">
      <header>
        <strong>{t("모델")}</strong>
        {header}
        {models.length === 0 && (
          <small>
            {profiles.length}{t("개 사용 가능")} </small>
        )}
      </header>
      {models.length > 0 && (
        <span className="model-picker-tabs" role="tablist">
          {(["presets", "models"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={shownTab === id}
              className={shownTab === id ? "is-active" : ""}
              onClick={() => setTab(id)}
            >
              {id === "presets" ? t("프리셋") : t("모델")}
              <small>{id === "presets" ? profiles.length : models.length}</small>
            </button>
          ))}
        </span>
      )}
      {shownTab === "models" && (
        <label className="model-picker-search">
          <Search size={12} aria-hidden="true" />
          <input
            type="search"
            autoFocus
            value={query}
            placeholder={t("모델 이름이나 provider로 찾기")}
            aria-label={t("모델 찾기")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      <span className="config-option-scroll">
        {sections.map((group) => (
          <span className="config-option-group" key={group.name}>
            <strong>{group.name}</strong>
            {group.options.map((choice) => {
              const isCurrent = choice.value === option.currentValue;
              const isFavorite = favorites.includes(choice.value);
              return (
                <span className="model-choice" key={choice.value}>
                  <button
                    type="button"
                    className={isCurrent ? "is-current" : ""}
                    onClick={() => onSelect(choice.value)}
                  >
                    <span>
                      <strong>{choice.name}</strong>
                      {(choice.kind === "model" ? choice.value : choice.description) && (
                        <small>
                          {choice.kind === "model" ? choice.value : choice.description}
                        </small>
                      )}
                    </span>
                    {isCurrent && <Check size={13} />}
                  </button>
                  <button
                    type="button"
                    className={isFavorite ? "model-favorite is-on" : "model-favorite"}
                    aria-pressed={isFavorite}
                    aria-label={t`${choice.name} 즐겨찾기`}
                    title={isFavorite ? t("즐겨찾기에서 빼기") : t("즐겨찾기에 추가")}
                    onClick={() => toggle(choice.value)}
                  >
                    <Star size={12} fill={isFavorite ? "currentColor" : "none"} />
                  </button>
                </span>
              );
            })}
          </span>
        ))}
        {shownTab === "models" && !query.trim() && (
          <small className="model-picker-hint">
            {t`모델 ${models.length}개 중에서 이름이나 provider로 찾으세요.`}
          </small>
        )}
      </span>
    </span>
  );
}
