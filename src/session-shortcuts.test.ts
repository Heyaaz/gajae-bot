import { describe, expect, it } from "vitest";
import { sessionShortcutForInput } from "../shared/settings-ipc";

const input = (
  key: string,
  overrides: Partial<Parameters<typeof sessionShortcutForInput>[0]> = {},
) => ({
  type: "keyDown",
  key,
  meta: true,
  control: false,
  alt: false,
  shift: false,
  ...overrides,
});

describe("sessionShortcutForInput", () => {
  it("maps Command-T and Command-1 through Command-9", () => {
    expect(sessionShortcutForInput(input("t"))).toEqual({ type: "new" });
    expect(sessionShortcutForInput(input("T"))).toEqual({ type: "new" });
    expect(sessionShortcutForInput(input("1"))).toEqual({
      type: "select",
      index: 0,
    });
    expect(sessionShortcutForInput(input("9"))).toEqual({
      type: "select",
      index: 8,
    });
  });

  it("ignores modified, key-up, and unsupported shortcuts", () => {
    expect(
      sessionShortcutForInput(input("t", { shift: true })),
    ).toBeUndefined();
    expect(
      sessionShortcutForInput(input("1", { control: true })),
    ).toBeUndefined();
    expect(
      sessionShortcutForInput(input("t", { type: "keyUp" })),
    ).toBeUndefined();
    expect(sessionShortcutForInput(input("0"))).toBeUndefined();
  });
  it("maps Escape to abort without modifiers", () => {
    expect(
      sessionShortcutForInput({
        type: "keyDown",
        key: "Escape",
        meta: false,
        control: false,
        alt: false,
        shift: false,
      }),
    ).toEqual({ type: "abort" });
    expect(sessionShortcutForInput(input("Escape"))).toBeUndefined();
  });
});
