import { describe, expect, it, vi } from "vitest";
import {
  PROMPT_SUGGESTION_REQUEST,
  PromptSuggestionSetting,
  parsePromptSuggestion,
  suggestNextInput,
} from "./gjc-sdk-prompt-suggestion.js";

function host(options: { enabled?: boolean; operations?: string[]; reply?: unknown; fail?: boolean }) {
  return {
    promptSuggestionsEnabled: vi.fn(async () => options.enabled ?? true),
    sdkOperations: vi.fn(async () => new Set(options.operations ?? ["btw.ask"])),
    controlSession: vi.fn(async () => {
      if (options.fail) throw new Error("busy");
      return { reply: options.reply };
    }),
  };
}

describe("parsePromptSuggestion", () => {
  it("accepts the sole suggestion string and trims it", () => {
    expect(parsePromptSuggestion('{"suggestion":"  테스트도 돌려줘  "}')).toBe("테스트도 돌려줘");
  });

  it("unwraps a single code fence around the JSON", () => {
    expect(parsePromptSuggestion('```json\n{"suggestion":"hi"}\n```')).toBe("hi");
    expect(parsePromptSuggestion('```\n{"suggestion":"hi"}\n```\n')).toBe("hi");
  });

  it.each([
    ["null suggestion", '{"suggestion":null}'],
    ["empty after trim", '{"suggestion":"   "}'],
    ["not JSON", "run the tests"],
    ["prose around fenced JSON", 'Sure:\n```json\n{"suggestion":"hi"}\n```'],
    ["array", '["hi"]'],
    ["wrong key", '{"text":"hi"}'],
    ["extra key", '{"suggestion":"hi","reason":"x"}'],
    ["duplicate key", '{"suggestion":"a","suggestion":"b"}'],
    ["non-string", '{"suggestion":3}'],
    ["multi-line", '{"suggestion":"a\\nb"}'],
    ["line separator", '{"suggestion":"a\\u2028b"}'],
    ["control character", '{"suggestion":"a\\u0007b"}'],
    ["unpaired surrogate", '{"suggestion":"a\\ud800b"}'],
    ["over 240 characters", JSON.stringify({ suggestion: "가".repeat(241) })],
  ])("rejects %s", (_name, reply) => {
    expect(parsePromptSuggestion(reply)).toBeNull();
  });

  it("counts characters, not UTF-16 units, against the 240 limit", () => {
    expect(parsePromptSuggestion(JSON.stringify({ suggestion: "😀".repeat(240) }))).toBe("😀".repeat(240));
    expect(parsePromptSuggestion(JSON.stringify({ suggestion: "😀".repeat(241) }))).toBeNull();
  });
});

describe("suggestNextInput", () => {
  it("asks btw.ask with GJC's request text and returns the parsed suggestion", async () => {
    const runtime = host({ reply: '{"suggestion":"이어서 테스트 추가해줘"}' });
    await expect(suggestNextInput(runtime, "s1")).resolves.toBe("이어서 테스트 추가해줘");
    expect(runtime.controlSession).toHaveBeenCalledWith(
      "s1",
      "btw.ask",
      { question: PROMPT_SUGGESTION_REQUEST },
      { timeoutMs: 30_000 },
    );
  });

  it("makes no call while the setting is off", async () => {
    const runtime = host({ enabled: false, reply: '{"suggestion":"x"}' });
    await expect(suggestNextInput(runtime, "s1")).resolves.toBeNull();
    expect(runtime.sdkOperations).not.toHaveBeenCalled();
    expect(runtime.controlSession).not.toHaveBeenCalled();
  });

  it("makes no call when the runtime does not advertise btw.ask", async () => {
    const runtime = host({ operations: ["turn.prompt"], reply: '{"suggestion":"x"}' });
    await expect(suggestNextInput(runtime, "s1")).resolves.toBeNull();
    expect(runtime.controlSession).not.toHaveBeenCalled();
  });

  it("returns null for a reply outside the contract", async () => {
    await expect(suggestNextInput(host({ reply: '{"suggestion":null}' }), "s1")).resolves.toBeNull();
    await expect(suggestNextInput(host({ reply: "Sure! Try this." }), "s1")).resolves.toBeNull();
    await expect(suggestNextInput(host({ reply: undefined }), "s1")).resolves.toBeNull();
  });

  it("returns null when the control call fails", async () => {
    await expect(suggestNextInput(host({ fail: true }), "s1")).resolves.toBeNull();
  });
});

describe("PromptSuggestionSetting", () => {
  function setting(listing: () => Promise<unknown>) {
    let clock = 0;
    const read = vi.fn(listing);
    return {
      read,
      advance: (ms: number) => {
        clock += ms;
      },
      setting: new PromptSuggestionSetting(
        async () => "gjc",
        () => clock,
        async () => (await read()) as never,
      ),
    };
  }
  const listed = (value: boolean | null) => [{ key: "promptSuggestions", type: "boolean", value }];

  it("reads true only when the listing says true", async () => {
    expect(await setting(async () => listed(true)).setting.enabled()).toBe(true);
    expect(await setting(async () => listed(false)).setting.enabled()).toBe(false);
    expect(await setting(async () => listed(null)).setting.enabled()).toBe(false);
    expect(await setting(async () => []).setting.enabled()).toBe(false);
  });

  it("treats an unreadable listing as off", async () => {
    expect(await setting(async () => Promise.reject(new Error("no gjc"))).setting.enabled()).toBe(false);
  });

  it("reuses the listing until it expires or settings are applied", async () => {
    const { read, advance, setting: cached } = setting(async () => listed(true));
    await cached.enabled();
    await cached.enabled();
    expect(read).toHaveBeenCalledTimes(1);
    advance(31_000);
    await cached.enabled();
    expect(read).toHaveBeenCalledTimes(2);
    cached.invalidate();
    await cached.enabled();
    expect(read).toHaveBeenCalledTimes(3);
  });
});
