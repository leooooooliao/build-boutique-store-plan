#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareStableTags,
  parseStableTag,
  parsePublishedDigest,
} from "../scripts/sync_skill_release.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const updater = path.join(repositoryRoot, "scripts", "sync_skill_release.mjs");
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "boutique-self-update-test-"),
);

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runUpdater(
  arguments_,
  expectedStatus = 0,
  extraEnvironment = {},
  executable = updater,
) {
  const result = spawnSync(process.execPath, [executable, ...arguments_, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnvironment },
    stdio: "pipe",
  });
  if (result.status !== expectedStatus) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
  }
  assert.equal(result.status, expectedStatus);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function releaseFixture(tag, overrides = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [],
    ...overrides,
  };
}

function createInstalledSkill(root, version, marker) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "VERSION"), `${version}\n`);
  fs.writeFileSync(
    path.join(root, "SKILL.md"),
    "---\nname: build-boutique-store-plan\ndescription: test fixture\n---\n",
  );
  fs.writeFileSync(path.join(root, "old-marker.txt"), `${marker}\n`);
}

function createRuntimePackage(parent) {
  const packagedRoot = path.join(parent, "build-boutique-store-plan");
  for (const directory of ["agents", "scripts", "references", "assets", "dependencies"]) {
    fs.mkdirSync(path.join(packagedRoot, directory), { recursive: true });
  }
  for (const relative of [
    "VERSION",
    "SKILL.md",
    "README.md",
    "agents/openai.yaml",
    "scripts/sync_skill_release.mjs",
    "references/interaction.md",
    "references/data-contract.md",
    "assets/report-template.md",
    "dependencies/gcrm-core/browser-runbook.md",
  ]) {
    const destination = path.join(packagedRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, relative), destination);
  }
  return packagedRoot;
}

function zipRuntime(packageParent, archive) {
  const result = spawnSync(
    "zip",
    ["-qr", archive, "build-boutique-store-plan"],
    {
      cwd: packageParent,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "");
  }
  assert.equal(result.status, 0, "zip must be available for the updater test");
}

try {
  assert.deepEqual(parseStableTag("v1.10.0"), [1, 10, 0]);
  assert.equal(parseStableTag("1.10.0"), null);
  assert.equal(parseStableTag("v1.2.3-beta"), null);
  assert.equal(compareStableTags("v1.10.0", "v1.9.9"), 1);
  assert.equal(compareStableTags("v2.0.0", "v1.99.99"), 1);
  assert.equal(compareStableTags("v1.3.0", "v1.3.0"), 0);
  assert.equal(compareStableTags("v1.2.9", "v1.3.0"), -1);
  const publishedDigest = "a".repeat(64);
  assert.equal(
    parsePublishedDigest(
      `<code>build-boutique-store-plan-sha256: ${publishedDigest}</code>`,
    ),
    publishedDigest,
  );
  assert.equal(parsePublishedDigest("<p>no release digest</p>"), null);

  const sameRelease = path.join(temporaryRoot, "same.json");
  writeJson(sameRelease, releaseFixture("v1.3.1"));
  const same = runUpdater(["--release-json", sameRelease]);
  assert.equal(same.status, "up_to_date");
  assert.equal(same.comparison, "same");

  const updaterAliasRoot = path.join(temporaryRoot, "updater-alias");
  fs.symlinkSync(repositoryRoot, updaterAliasRoot, "dir");
  const aliasedUpdater = path.join(
    updaterAliasRoot,
    "scripts",
    "sync_skill_release.mjs",
  );
  const aliased = runUpdater(
    ["--release-json", sameRelease],
    0,
    {},
    aliasedUpdater,
  );
  assert.equal(aliased.status, "up_to_date");

  const olderRelease = path.join(temporaryRoot, "older.json");
  writeJson(olderRelease, releaseFixture("v1.2.0"));
  const older = runUpdater(["--release-json", olderRelease]);
  assert.equal(older.status, "up_to_date");
  assert.equal(older.comparison, "local_newer");

  const newerRelease = path.join(temporaryRoot, "newer.json");
  writeJson(newerRelease, releaseFixture("v1.10.0"));
  const newer = runUpdater(["--release-json", newerRelease]);
  assert.equal(newer.status, "update_available");
  assert.equal(newer.latest_version, "v1.10.0");

  const prerelease = path.join(temporaryRoot, "prerelease.json");
  writeJson(
    prerelease,
    releaseFixture("v1.4.0", { prerelease: true }),
  );
  assert.equal(
    runUpdater(["--release-json", prerelease]).status,
    "update_failed",
  );

  const invalidRelease = path.join(temporaryRoot, "invalid.json");
  writeJson(invalidRelease, releaseFixture("latest"));
  assert.equal(
    runUpdater(["--release-json", invalidRelease]).status,
    "update_failed",
  );

  assert.equal(
    runUpdater(["--assert-tag", "v1.3.1"]).status,
    "up_to_date",
  );
  runUpdater(["--assert-tag", "v9.9.9"], 1);

  const packageParent = path.join(temporaryRoot, "package");
  fs.mkdirSync(packageParent, { recursive: true });
  createRuntimePackage(packageParent);
  const archive = path.join(temporaryRoot, "release.zip");
  zipRuntime(packageParent, archive);
  const digest = crypto
    .createHash("sha256")
    .update(fs.readFileSync(archive))
    .digest("hex");
  const applyRelease = path.join(temporaryRoot, "apply.json");
  writeJson(
    applyRelease,
    releaseFixture("v1.3.1", {
      assets: [
        {
          name: "build-boutique-store-plan-v1.3.1.zip",
          browser_download_url: "https://example.invalid/release.zip",
          digest: `sha256:${digest}`,
        },
      ],
    }),
  );

  const installParent = path.join(temporaryRoot, "installed");
  const installRoot = path.join(installParent, "build-boutique-store-plan");
  createInstalledSkill(installRoot, "v1.2.0", "atomic-update");
  const applied = runUpdater(
    [
      "--apply",
      "--root",
      installRoot,
      "--release-json",
      applyRelease,
      "--asset-file",
      archive,
    ],
    0,
    { BOUTIQUE_SKILL_UPDATE_TEST_MODE: "1" },
  );
  assert.equal(applied.status, "updated");
  assert.equal(fs.readFileSync(path.join(installRoot, "VERSION"), "utf8").trim(), "v1.3.1");
  assert.equal(fs.existsSync(path.join(installRoot, "old-marker.txt")), false);
  assert.equal(
    fs.readFileSync(path.join(applied.backup_path, "old-marker.txt"), "utf8").trim(),
    "atomic-update",
  );

  const tamperedRoot = path.join(temporaryRoot, "tampered", "build-boutique-store-plan");
  createInstalledSkill(tamperedRoot, "v1.2.0", "digest-protected");
  const badDigestRelease = path.join(temporaryRoot, "bad-digest.json");
  writeJson(
    badDigestRelease,
    releaseFixture("v1.3.1", {
      assets: [
        {
          name: "build-boutique-store-plan-v1.3.1.zip",
          browser_download_url: "https://example.invalid/release.zip",
          digest: `sha256:${"0".repeat(64)}`,
        },
      ],
    }),
  );
  const rejected = runUpdater(
    [
      "--apply",
      "--root",
      tamperedRoot,
      "--release-json",
      badDigestRelease,
      "--asset-file",
      archive,
    ],
    0,
    { BOUTIQUE_SKILL_UPDATE_TEST_MODE: "1" },
  );
  assert.equal(rejected.status, "update_failed");
  assert.match(rejected.detail, /SHA-256/);
  assert.equal(
    fs.readFileSync(path.join(tamperedRoot, "old-marker.txt"), "utf8").trim(),
    "digest-protected",
  );

  const checkoutRoot = path.join(temporaryRoot, "checkout", "build-boutique-store-plan");
  createInstalledSkill(checkoutRoot, "v1.2.0", "git-protected");
  fs.mkdirSync(path.join(path.dirname(checkoutRoot), ".git"));
  const checkout = runUpdater(
    [
      "--apply",
      "--root",
      checkoutRoot,
      "--release-json",
      applyRelease,
      "--asset-file",
      archive,
    ],
    0,
    { BOUTIQUE_SKILL_UPDATE_TEST_MODE: "1" },
  );
  assert.equal(checkout.status, "update_failed");
  assert.match(checkout.detail, /Git checkout/);
  assert.equal(
    fs.readFileSync(path.join(checkoutRoot, "old-marker.txt"), "utf8").trim(),
    "git-protected",
  );

  const wrongRoot = path.join(temporaryRoot, "wrong", "another-skill");
  createInstalledSkill(wrongRoot, "v1.2.0", "identity-protected");
  fs.writeFileSync(
    path.join(wrongRoot, "SKILL.md"),
    "---\nname: another-skill\ndescription: test fixture\n---\n",
  );
  const wrongTarget = runUpdater(
    [
      "--apply",
      "--root",
      wrongRoot,
      "--release-json",
      applyRelease,
      "--asset-file",
      archive,
    ],
    0,
    { BOUTIQUE_SKILL_UPDATE_TEST_MODE: "1" },
  );
  assert.equal(wrongTarget.status, "update_failed");
  assert.match(wrongTarget.detail, /not the build-boutique-store-plan Skill/);
  assert.equal(
    fs.readFileSync(path.join(wrongRoot, "old-marker.txt"), "utf8").trim(),
    "identity-protected",
  );

  const symlinkParent = path.join(temporaryRoot, "symlink");
  const realRoot = path.join(symlinkParent, "real-skill");
  const linkedRoot = path.join(symlinkParent, "linked-skill");
  createInstalledSkill(realRoot, "v1.2.0", "symlink-protected");
  fs.symlinkSync(realRoot, linkedRoot, "dir");
  const linkedTarget = runUpdater(
    [
      "--apply",
      "--root",
      linkedRoot,
      "--release-json",
      applyRelease,
      "--asset-file",
      archive,
    ],
    0,
    { BOUTIQUE_SKILL_UPDATE_TEST_MODE: "1" },
  );
  assert.equal(linkedTarget.status, "update_failed");
  assert.match(linkedTarget.detail, /symbolic-link/);
  assert.equal(
    fs.readFileSync(path.join(realRoot, "old-marker.txt"), "utf8").trim(),
    "symlink-protected",
  );

  process.stdout.write("Self-update tests passed.\n");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
