/** A GJC setting the app can edit: `gjc config` reports its type, value and description. */
export type GjcSettingValue = boolean | number;

export interface GjcSetting {
  key: string;
  type: "boolean" | "number";
  /** `null` when GJC has no value for the key and falls back to its own default. */
  value: GjcSettingValue | null;
  description?: string;
}

export interface GjcSettingChange {
  key: string;
  value: GjcSettingValue;
}
