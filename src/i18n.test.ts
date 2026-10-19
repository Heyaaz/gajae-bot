import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  MESSAGES,
  readLanguageMode,
  resolveLanguage,
  setLanguageMode,
  storeLanguageMode,
  systemLanguage,
  t,
} from "./i18n";

afterEach(() => setLanguageMode("ko"));

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(file);
    return /\.(?:ts|tsx)$/u.test(entry.name) && !entry.name.includes(".test.")
      ? [file]
      : [];
  });
}

function translatedKeys(): Array<{ key: string; file: string; line: number }> {
  const keys: Array<{ key: string; file: string; line: number }> = [];
  for (const file of productionSources("src")) {
    if (file.endsWith("i18n.ts") || file.endsWith("i18n-messages.ts"))
      continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const add = (key: string, node: ts.Node): void => {
      keys.push({
        key,
        file,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "t" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        add(node.arguments[0].text, node);
      } else if (
        ts.isTaggedTemplateExpression(node) &&
        node.tag.getText(source) === "t"
      ) {
        const template = node.template;
        if (ts.isTemplateExpression(template)) {
          let key = template.head.text;
          for (const [index, span] of template.templateSpans.entries())
            key += `{${index}}${span.literal.text}`;
          add(key, node);
        } else {
          add(template.text, node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return keys;
}

describe("i18n", () => {
  it("translates Korean source strings when English is selected", () => {
    setLanguageMode("en");
    expect(t("세션이 없습니다")).toBe("No sessions");
    expect(t("지난 세션 보기")).toBe("View past sessions");
  });

  it("keeps Korean as the source language", () => {
    setLanguageMode("ko");
    expect(t("세션이 없습니다")).toBe("세션이 없습니다");
  });

  it("interpolates tagged templates in either language", () => {
    expect(t`세션이 없습니다`).toBe("세션이 없습니다");
    expect(t`파일 ${3}개 수정 (+${1} −${2})`).toBe("파일 3개 수정 (+1 −2)");
    setLanguageMode("en");
    expect(t`세션이 없습니다`).toBe("No sessions");
    expect(t`파일 ${3}개 수정 (+${1} −${2})`).toBe("3 files changed (+1 −2)");
  });

  it("resolves the system language from the OS locale", () => {
    expect(systemLanguage(["ko-KR", "en-US"])).toBe("ko");
    expect(systemLanguage(["en-US"])).toBe("en");
    expect(resolveLanguage("system", "en")).toBe("en");
    expect(resolveLanguage("ko", "en")).toBe("ko");
  });

  it("persists the selected mode", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    storeLanguageMode("en", storage);
    expect(readLanguageMode(storage)).toBe("en");
    storeLanguageMode("system", storage);
    expect(readLanguageMode(storage)).toBe("system");
  });

  it("has no Korean left in the English dictionary", () => {
    const untranslated = Object.entries(MESSAGES).filter(([, value]) =>
      /[\uAC00-\uD7A3]/u.test(value),
    );
    expect(untranslated).toEqual([]);
  });

  it("keeps placeholder sets aligned between Korean and English", () => {
    const placeholders = (value: string): string =>
      [...value.matchAll(/\{(\d+)\}/gu)]
        .map((match) => match[1])
        .sort()
        .join(",");
    const mismatched = Object.entries(MESSAGES).filter(
      ([key, value]) => placeholders(key) !== placeholders(value),
    );
    expect(mismatched).toEqual([]);
  });

  it("covers every t() key used by production source", () => {
    const missing = translatedKeys().filter(({ key }) => !(key in MESSAGES));
    expect(missing).toEqual([]);
  });
});
