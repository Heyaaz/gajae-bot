import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MESSAGES } from "./i18n-messages";
import { installEnglishDictionary } from "./i18n";

// Unit tests must not read the developer's real GJC broker index or ledger: cache
// decisions and session listings then depend on that machine's history instead of
// the fixture. Each worker gets a throwaway agent directory, including when the
// shell already exports the real one.
process.env.GJC_CODING_AGENT_DIR = mkdtempSync(
  path.join(tmpdir(), "gajae-test-agent-"),
);

// Production loads this dictionary only after the language resolves to English.
// Tests select English and translate in the same turn, so the dictionary is
// installed before any test body runs.
installEnglishDictionary(MESSAGES);
