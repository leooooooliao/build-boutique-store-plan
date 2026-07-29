#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  process.stderr.write(
    "Usage: node .github/scripts/validate_public_package.mjs <package-root>\n",
  );
  process.exit(1);
}

const blockedExtensions = new Set([
  ".csv",
  ".tsv",
  ".xls",
  ".xlsx",
  ".parquet",
]);

const secretPatterns = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["GitHub/OpenAI-style token", /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/],
  [
    "credential assignment",
    /\b(?:authorization|cookie|access[_-]?token|refresh[_-]?token|session[_-]?id|password)\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9._~+/-]{16,}/i,
  ],
  ["local absolute path", /\/Users\/[^/\s]+\/|\.codex\/attachments\//],
  ["real product/shop ID", /\b\d{19}\b/],
];

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

const errors = [];
const files = walk(root);

for (const file of files) {
  const relative = path.relative(root, file);
  const extension = path.extname(file).toLowerCase();
  if (blockedExtensions.has(extension)) {
    errors.push(`${relative}: blocked customer-data extension ${extension}`);
    continue;
  }

  const content = fs.readFileSync(file, "utf8");
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(content)) errors.push(`${relative}: detected ${label}`);
  }
}

if (errors.length > 0) {
  process.stderr.write(`Public package validation failed:\n- ${errors.join("\n- ")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Public package validation passed: ${files.length} files; no customer-data files, credentials, local paths, or real product/shop IDs found. Internal workflow URLs are allowed.\n`,
);
