import { describe, expect, it } from "vitest";
import { GjcSdkController } from "./gjc-sdk-controller.js";

describe("dispose completeness", () => {
  it("releases every Map and Set the controller holds", () => {
    // Teardown used to be maintained by hand, and six fields had been added since
    // anyone checked the list. Enumerating the instance instead of naming fields
    // means a new Map is covered the day it is introduced rather than the day
    // someone remembers it.
    const controller = new GjcSdkController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const collections = () =>
      Object.entries(controller as unknown as Record<string, unknown>).filter(
        (entry): entry is [string, Map<unknown, unknown> | Set<unknown>] =>
          entry[1] instanceof Map || entry[1] instanceof Set,
      );

    const fields = collections();
    // Guards the enumeration itself: a controller whose fields stopped being
    // visible here would make this test vacuously pass.
    expect(fields.length).toBeGreaterThan(30);
    // Teardown calls into some of the values it holds -- pending permissions get
    // resolved, watchers closed, timers cleared -- so the probe has to satisfy
    // those shapes rather than be a bare string.
    const probe = {
      resolve: () => undefined,
      reject: () => undefined,
      close: () => undefined,
      abort: () => undefined,
      unref: () => undefined,
      then: undefined,
    };
    for (const [, collection] of fields) {
      if (collection instanceof Map) collection.set("probe-session", probe);
      else collection.add("probe-session");
    }

    controller.dispose();

    const retained = collections()
      .filter(([, collection]) => collection.size > 0)
      .map(([name]) => name);
    expect(retained).toEqual([]);
  });
});
