import fs from "node:fs";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";

export interface ConfigDocument {
  value: Record<string, any>;
  text: string;
  writable: boolean;
  error?: string;
}

export function readConfigDocument(filePath: string): ConfigDocument {
  if (!fs.existsSync(filePath)) return { value: {}, text: "{}\n", writable: true };
  const text = fs.readFileSync(filePath, "utf-8");
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !value || typeof value !== "object" || Array.isArray(value)) {
    return {
      value: {},
      text,
      writable: false,
      error: "Configuration is not valid JSONC; editing is disabled to avoid overwriting it.",
    };
  }
  return { value: value as Record<string, any>, text, writable: true };
}

export function writeConfigDocument(filePath: string, document: ConfigDocument, key: string, value: unknown): void {
  if (!document.writable) return;
  document.text = applyEdits(document.text, modify(document.text, [key], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  }));
  fs.writeFileSync(filePath, document.text, "utf-8");
}
