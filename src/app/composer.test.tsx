import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MessageInput } from "../backend/types";
import { isImmediateSdkCommandSubmission } from "../composer-utils";
import {
  FastTierControls,
  fastTierBusy,
  requestFastTier,
  selectedCommandDraft,
} from "./composer";
import type { FastTierControlsProps } from "./composer";

const FAST = {
  name: "fast",
  description: "Enable or disable priority service tier",
};

function controls(
  overrides: Partial<FastTierControlsProps> = {},
): FastTierControlsProps {
  return {
    commands: [FAST],
    fastMode: false,
    busy: false,
    readOnly: false,
    onSelect: () => undefined,
    ...overrides,
  };
}

function render(props: Partial<FastTierControlsProps> = {}): string {
  return renderToStaticMarkup(createElement(FastTierControls, controls(props)));
}

interface TestElement {
  props: {
    children?: unknown;
    onClick?: () => void;
  };
}

/** The buttons hold plain text, so a label finds its own element in either form. */
function childButtons(node: TestElement): TestElement[] {
  const children = Array.isArray(node.props.children)
    ? node.props.children
    : [node.props.children];
  return children.filter(
    (child): child is TestElement =>
      typeof child === "object" && child !== null && "props" in child,
  );
}

function buttonMarkup(markup: string, label: string): string {
  const found = [...markup.matchAll(/<button\b[^>]*>[^<]*<\/button>/gu)]
    .map((match) => match[0])
    .find((html) => html.endsWith(`>${label}</button>`));
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

function buttonElement(
  props: Partial<FastTierControlsProps>,
  label: string,
): TestElement {
  const group = FastTierControls(controls(props)) as unknown as TestElement;
  const found = childButtons(group).find(
    (child) => child.props.children === label,
  );
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

describe("Composer Fast tier controls", () => {
  it("offers both tiers only when the runtime advertises /fast", () => {
    // The tier belongs to the runtime, so a backend that publishes no `/fast`
    // command gets no buttons rather than a control that could never apply.
    expect(render({ commands: [{ name: "model" }, { name: "context" }] })).toBe(
      "",
    );
    const markup = render();
    expect(markup).toContain('class="config-option-menu-fast"');
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Fast 모드"');
    expect(buttonMarkup(markup, "Fast on")).toBeTruthy();
    expect(buttonMarkup(markup, "Fast off")).toBeTruthy();
  });

  it("marks the tier the session reports instead of a local guess", () => {
    const off = render({ fastMode: false });
    expect(buttonMarkup(off, "Fast on")).toContain('aria-pressed="false"');
    expect(buttonMarkup(off, "Fast off")).toContain('aria-pressed="true"');

    const on = render({ fastMode: true });
    expect(buttonMarkup(on, "Fast on")).toContain('aria-pressed="true"');
    expect(buttonMarkup(on, "Fast off")).toContain('aria-pressed="false"');
  });

  it("refuses a press only on a view-only device or while one is in flight", () => {
    // A running turn is deliberately not one of those reasons: the runtime applies
    // the tier to the open session, so no running state is passed to this control.
    for (const blocked of [{ readOnly: true }, { busy: true }]) {
      const markup = render(blocked);
      expect(buttonMarkup(markup, "Fast on")).toContain("disabled");
      expect(buttonMarkup(markup, "Fast off")).toContain("disabled");
    }
    const idle = render();
    expect(buttonMarkup(idle, "Fast on")).not.toContain("disabled");
    expect(buttonMarkup(idle, "Fast off")).not.toContain("disabled");
  });

  it("asks for one tier per press and leaves the menu to the caller", () => {
    const picks: boolean[] = [];
    const on = buttonElement({ onSelect: (fast) => picks.push(fast) }, "Fast on");
    on.props.onClick!();
    const off = buttonElement(
      { onSelect: (fast) => picks.push(fast) },
      "Fast off",
    );
    off.props.onClick!();
    expect(picks).toEqual([true, false]);
    // Reaching Fast is the whole contract of these buttons: neither carries a close
    // or navigation handler, so the model list the popover was opened for is still
    // there afterwards.
    expect(Object.keys(on.props).filter((key) => key.startsWith("on"))).toEqual([
      "onClick",
    ]);
  });
});

describe("requestFastTier", () => {
  it("sends the tier as a bare runtime command with no attachments", async () => {
    const sent: MessageInput[] = [];
    const send = async (input: MessageInput) => {
      sent.push(input);
      return "prompt" as const;
    };
    await requestFastTier({ fast: true, send, report: () => undefined });
    await requestFastTier({ fast: false, send, report: () => undefined });
    // Attachments are what decide whether the runtime reads this as its own
    // service-tier control or as prompt text steered into the open turn.
    expect(sent).toEqual([
      { text: "/fast on", images: [], files: [] },
      { text: "/fast off", images: [], files: [] },
    ]);
  });

  it("reports a refused request and consumes its rejection", async () => {
    const reported: string[] = [];
    await expect(
      requestFastTier({
        fast: true,
        send: async () => {
          throw new Error("service_tier.set is not advertised");
        },
        report: (message) => reported.push(message),
      }),
    ).resolves.toBeUndefined();
    expect(reported).toEqual(["service_tier.set is not advertised"]);

    // A runtime that rejects with something other than an Error still has to reach
    // the composer's error line as text.
    await requestFastTier({
      fast: false,
      send: async () => {
        throw "refused";
      },
      report: (message) => reported.push(message),
    });
    expect(reported).toEqual([
      "service_tier.set is not advertised",
      "refused",
    ]);
  });
});

describe("fastTierBusy", () => {
  it("keeps an unfinished request from another session out of this one", () => {
    // One composer serves every session, so a request sent from a row the user has
    // left behind must not hold the next row's buttons disabled.
    expect(fastTierBusy({ sessionId: "session-a" }, "session-b")).toBe(false);
    expect(fastTierBusy({ sessionId: "session-b" }, "session-b")).toBe(true);
    expect(fastTierBusy(null, "session-b")).toBe(false);
  });
});

describe("selectedCommandDraft", () => {
  it("ends the palette query for a skill that advertises no hint", () => {
    // A hint-less `skill:*` left the textarea on exactly the `/skill:name` value the
    // palette matched, so the palette stayed open for it and the next Enter
    // re-selected the skill instead of submitting it.
    expect(selectedCommandDraft("skill:deep-interview")).toBe(
      "/skill:deep-interview ",
    );
    expect(selectedCommandDraft("skill:ralplan")).toBe("/skill:ralplan ");

    // And the skill stays agent work: it is not one of the controls that fire
    // straight at the runtime, so the draft is what actually gets submitted.
    expect(
      isImmediateSdkCommandSubmission(
        selectedCommandDraft("skill:deep-interview"),
        [{ name: "skill:deep-interview" }],
        false,
      ),
    ).toBe(false);
  });
});
