import { MESSAGES } from "./i18n-messages";
import { installEnglishDictionary } from "./i18n";

// Production loads this dictionary only after the language resolves to English.
// Tests select English and translate in the same turn, so the dictionary is
// installed before any test body runs.
installEnglishDictionary(MESSAGES);
