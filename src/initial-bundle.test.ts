import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(file: string): string {
  return readFileSync(path.join(import.meta.dirname, file), "utf8");
}

/** Module specifiers of static `import ... from` declarations. */
function staticImports(text: string): string[] {
  return [
    ...text.matchAll(/^import\s[\s\S]*?from\s+["']([^"']+)["']/gm),
  ].map((match) => match[1] ?? "");
}

describe("initial renderer graph", () => {
  it("keeps settings, the repository, and the project list off the shell's static imports", () => {
    const imports = staticImports(source("app/shell.tsx"));
    expect(imports).not.toContain("./settings");
    expect(imports).not.toContain("./repo-view");
    expect(imports).not.toContain("./project-list");
    expect(imports).not.toContain("./remote-access-panel");
    expect(source("app/shell.tsx")).toContain("DeferredSettingsDialog");
    expect(source("app/shell.tsx")).toContain("DeferredRepoView");
    expect(source("app/shell.tsx")).toContain("DeferredProjectList");
  });

  it("loads the English dictionary and the mock backend only on demand", () => {
    expect(staticImports(source("i18n.ts"))).not.toContain("./i18n-messages");
    const main = source("main.tsx");
    expect(staticImports(main)).not.toContain("./backend/mock-agent-backend");
    expect(main).toContain("import('./backend/mock-agent-backend')");
    expect(main).toContain("__GAJAE_INCLUDE_MOCK__");
    expect(main).toContain("ensureEnglishDictionary");
  });

  it("loads the QR panel from the remote settings tab", () => {
    const settings = source("app/settings.tsx");
    expect(staticImports(settings)).not.toContain("./remote-access-panel");
    expect(settings).toContain('tab === "remote"');
    expect(settings).toContain('import("./remote-access-panel")');
  });
});
