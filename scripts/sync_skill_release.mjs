#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "build-boutique-store-plan";
const REPOSITORY = "leooooooliao/build-boutique-store-plan";
const LATEST_RELEASE_PAGE = `https://github.com/${REPOSITORY}/releases/latest`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const RELEASE_TAG_API = `https://api.github.com/repos/${REPOSITORY}/releases/tags`;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function parseStableTag(value) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(
    String(value || "").trim(),
  );
  if (!match) return null;
  return match.slice(1).map((part) => Number(part));
}

export function compareStableTags(left, right) {
  const leftParts = parseStableTag(left);
  const rightParts = parseStableTag(right);
  if (!leftParts || !rightParts) {
    throw new Error(`Only stable SemVer tags are allowed: ${left}, ${right}`);
  }
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

function parseArguments(argv) {
  const options = {
    apply: false,
    json: false,
    root: DEFAULT_ROOT,
    releaseJson: null,
    assetFile: null,
    assertTag: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") options.apply = true;
    else if (value === "--json") options.json = true;
    else if (value === "--root") options.root = path.resolve(argv[++index] || "");
    else if (value === "--release-json") {
      options.releaseJson = path.resolve(argv[++index] || "");
    } else if (value === "--asset-file") {
      options.assetFile = path.resolve(argv[++index] || "");
    } else if (value === "--assert-tag") {
      options.assertTag = argv[++index] || "";
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if ((options.releaseJson || options.assetFile) && options.apply) {
    if (process.env.BOUTIQUE_SKILL_UPDATE_TEST_MODE !== "1") {
      throw new Error(
        "--release-json/--asset-file with --apply is restricted to test mode.",
      );
    }
  }
  return options;
}

function readLocalTag(root) {
  const versionFile = path.join(root, "VERSION");
  const tag = fs.readFileSync(versionFile, "utf8").trim();
  if (!parseStableTag(tag)) {
    throw new Error(`Invalid local VERSION: ${tag || "(empty)"}`);
  }
  return tag;
}

function githubHeaders() {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": `${SKILL_NAME}-release-sync`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  return fetch(url, {
    redirect: "follow",
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function tagFromReleaseUrl(value) {
  const url = new URL(value);
  if (url.hostname !== "github.com") return null;
  const expectedPrefix = `/${REPOSITORY}/releases/tag/`;
  if (!url.pathname.startsWith(expectedPrefix)) return null;
  const tag = decodeURIComponent(url.pathname.slice(expectedPrefix.length));
  return parseStableTag(tag) ? tag : null;
}

async function readJsonResponse(response, label) {
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function resolveLatestRelease(options) {
  if (options.releaseJson) {
    return {
      release: JSON.parse(fs.readFileSync(options.releaseJson, "utf8")),
      checkedUrl: options.releaseJson,
      resolution: "test_fixture",
    };
  }

  const failures = [];
  try {
    const response = await fetchWithTimeout(LATEST_RELEASE_PAGE, {
      method: "HEAD",
    });
    if (!response.ok) {
      throw new Error(`release page returned HTTP ${response.status}`);
    }
    const tag = tagFromReleaseUrl(response.url);
    if (!tag) {
      throw new Error(`release page did not resolve to a stable tag: ${response.url}`);
    }
    return {
      release: { tag_name: tag },
      checkedUrl: LATEST_RELEASE_PAGE,
      resolution: "release_page_redirect",
    };
  } catch (error) {
    failures.push(error.message);
  }

  try {
    const response = await fetchWithTimeout(LATEST_RELEASE_API, {
      headers: githubHeaders(),
    });
    const release = await readJsonResponse(response, "GitHub Releases API");
    return {
      release,
      checkedUrl: LATEST_RELEASE_API,
      resolution: "releases_api_fallback",
    };
  } catch (error) {
    failures.push(error.message);
  }

  throw new Error(failures.join("; "));
}

async function hydrateRelease(release, options) {
  if (Array.isArray(release.assets)) return release;
  if (options.releaseJson) return release;

  const tag = release.tag_name;
  const response = await fetchWithTimeout(
    `${RELEASE_TAG_API}/${encodeURIComponent(tag)}`,
    { headers: githubHeaders() },
  );
  return readJsonResponse(response, `GitHub Release ${tag}`);
}

function expectedAssetName(tag) {
  return `${SKILL_NAME}-${tag}.zip`;
}

function validateOfficialAsset(asset, tag, testMode = false) {
  if (!asset || asset.name !== expectedAssetName(tag)) {
    throw new Error(`Release is missing exact asset ${expectedAssetName(tag)}.`);
  }
  if (!testMode) {
    const url = new URL(asset.browser_download_url);
    const expectedPrefix = `/${REPOSITORY}/releases/download/${tag}/`;
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      !url.pathname.startsWith(expectedPrefix) ||
      path.basename(url.pathname) !== expectedAssetName(tag)
    ) {
      throw new Error("Release asset URL is not the expected official GitHub URL.");
    }
  }
  if (!/^sha256:[a-f0-9]{64}$/i.test(String(asset.digest || ""))) {
    throw new Error("Release asset is missing a valid GitHub SHA-256 digest.");
  }
}

async function downloadArchive(asset, destination, options) {
  if (options.assetFile) {
    fs.copyFileSync(options.assetFile, destination);
    return;
  }

  const response = await fetchWithTimeout(
    asset.browser_download_url,
    { headers: { "User-Agent": `${SKILL_NAME}-release-sync` } },
    120_000,
  );
  if (!response.ok) {
    throw new Error(`Release ZIP returned HTTP ${response.status}.`);
  }
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > MAX_ARCHIVE_BYTES) {
    throw new Error(`Release ZIP exceeds ${MAX_ARCHIVE_BYTES} bytes.`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MAX_ARCHIVE_BYTES) {
    throw new Error("Release ZIP is empty or exceeds the size limit.");
  }
  fs.writeFileSync(destination, buffer);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function extractArchive(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const commands =
    process.platform === "win32"
      ? [
          [
            "powershell",
            [
              "-NoProfile",
              "-Command",
              "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
              archive,
              destination,
            ],
          ],
          ["tar", ["-xf", archive, "-C", destination]],
        ]
      : [
          ["unzip", ["-q", archive, "-d", destination]],
          ["ditto", ["-x", "-k", archive, destination]],
          ["tar", ["-xf", archive, "-C", destination]],
        ];

  const failures = [];
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status === 0) return command;
    failures.push(`${command}: ${result.error?.message || result.stderr || result.status}`);
  }
  throw new Error(`No archive extractor succeeded: ${failures.join("; ")}`);
}

function walkRejectingLinks(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`Release package contains a symbolic link: ${entry.name}`);
    }
    if (stat.isDirectory()) walkRejectingLinks(absolute);
  }
}

function validateExtractedSkill(extractRoot, expectedTag) {
  const topLevel = fs
    .readdirSync(extractRoot, { withFileTypes: true })
    .filter((entry) => entry.name !== "__MACOSX");
  if (
    topLevel.length !== 1 ||
    !topLevel[0].isDirectory() ||
    topLevel[0].name !== SKILL_NAME
  ) {
    throw new Error(`Release ZIP must contain exactly one ${SKILL_NAME} root.`);
  }

  const skillRoot = path.join(extractRoot, SKILL_NAME);
  walkRejectingLinks(skillRoot);
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
    if (!fs.existsSync(path.join(skillRoot, relative))) {
      throw new Error(`Release package is missing ${relative}.`);
    }
  }
  if (readLocalTag(skillRoot) !== expectedTag) {
    throw new Error("Release tag and packaged VERSION do not match.");
  }
  return skillRoot;
}

function findContainingGitCheckout(start) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function safeUpdateTarget(root) {
  const resolved = path.resolve(root);
  const parent = path.dirname(resolved);
  if (resolved === parent || resolved === path.parse(resolved).root) {
    throw new Error("Refusing to update a filesystem root.");
  }
  if (!fs.existsSync(resolved)) {
    throw new Error("Update target does not exist.");
  }
  const targetStat = fs.lstatSync(resolved);
  if (targetStat.isSymbolicLink()) {
    throw new Error("Refusing to replace a symbolic-link Skill root.");
  }
  if (!targetStat.isDirectory()) {
    throw new Error("Update target is not a directory.");
  }
  const skillFile = path.join(resolved, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    throw new Error("Update target is not a recognizable Skill directory.");
  }
  const skillSource = fs.readFileSync(skillFile, "utf8");
  if (!/^name:\s*build-boutique-store-plan\s*$/m.test(skillSource)) {
    throw new Error(`Update target is not the ${SKILL_NAME} Skill.`);
  }
  const containingCheckout = findContainingGitCheckout(resolved);
  if (containingCheckout) {
    throw new Error(
      `This Skill is inside a Git checkout (${containingCheckout}); use a clean fast-forward Git update instead of replacing it.`,
    );
  }
  fs.accessSync(parent, fs.constants.W_OK);
  return { resolved, parent };
}

async function applyReleaseUpdate(root, localTag, latestRelease, options) {
  const testMode = process.env.BOUTIQUE_SKILL_UPDATE_TEST_MODE === "1";
  const release = await hydrateRelease(latestRelease, options);
  const latestTag = release.tag_name;
  const asset = (release.assets || []).find(
    (candidate) => candidate.name === expectedAssetName(latestTag),
  );
  validateOfficialAsset(asset, latestTag, testMode);

  const target = safeUpdateTarget(root);
  const staging = fs.mkdtempSync(
    path.join(target.parent, `.${SKILL_NAME}-update-`),
  );
  const archive = path.join(staging, expectedAssetName(latestTag));
  const extractRoot = path.join(staging, "extracted");
  let backup = null;

  try {
    await downloadArchive(asset, archive, options);
    const actualDigest = sha256(archive);
    const expectedDigest = asset.digest.slice("sha256:".length).toLowerCase();
    if (actualDigest !== expectedDigest) {
      throw new Error("Release ZIP SHA-256 does not match GitHub metadata.");
    }
    const extractor = extractArchive(archive, extractRoot);
    const newSkillRoot = validateExtractedSkill(extractRoot, latestTag);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup = path.join(
      target.parent,
      `.${path.basename(target.resolved)}.backup-${localTag}-${stamp}`,
    );

    fs.renameSync(target.resolved, backup);
    try {
      fs.renameSync(newSkillRoot, target.resolved);
    } catch (error) {
      fs.renameSync(backup, target.resolved);
      backup = null;
      throw error;
    }

    return {
      status: "updated",
      local_version: localTag,
      latest_version: latestTag,
      installed_root: target.resolved,
      backup_path: backup,
      extractor,
      reload_required: true,
      checked_once_for_current_task: true,
      message: `已从 ${localTag} 更新到 ${latestTag}；重新读取新版 SKILL.md 后继续。`,
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function emit(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.message}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  let localTag;
  try {
    localTag = readLocalTag(options.root);
  } catch (error) {
    emit(
      {
        status: "update_failed",
        blocking: false,
        message: `无法读取本地 Skill 版本；继续使用当前文件。${error.message}`,
      },
      options.json,
    );
    return 0;
  }

  if (options.assertTag) {
    if (localTag !== options.assertTag) {
      process.stderr.write(
        `VERSION ${localTag} does not match release tag ${options.assertTag}.\n`,
      );
      return 1;
    }
    emit(
      {
        status: "up_to_date",
        local_version: localTag,
        latest_version: options.assertTag,
        message: `VERSION matches ${options.assertTag}.`,
      },
      options.json,
    );
    return 0;
  }

  let resolved;
  try {
    resolved = await resolveLatestRelease(options);
  } catch (error) {
    emit(
      {
        status: "check_unavailable",
        local_version: localTag,
        blocking: false,
        checked_url: LATEST_RELEASE_PAGE,
        message: `暂时无法检查 GitHub 更新，继续使用 ${localTag}。`,
        detail: error.message,
      },
      options.json,
    );
    return 0;
  }

  const latestTag = String(resolved.release.tag_name || "").trim();
  if (
    !parseStableTag(latestTag) ||
    resolved.release.draft === true ||
    resolved.release.prerelease === true
  ) {
    emit(
      {
        status: "update_failed",
        local_version: localTag,
        blocking: false,
        checked_url: resolved.checkedUrl,
        message: `GitHub 最新发布不是可接受的稳定版本；继续使用 ${localTag}。`,
      },
      options.json,
    );
    return 0;
  }

  const comparison = compareStableTags(latestTag, localTag);
  if (comparison <= 0) {
    const message =
      comparison === 0
        ? `当前 Skill 已是最新版 ${localTag}。`
        : `当前本地版本 ${localTag} 不低于已发布版本 ${latestTag}。`;
    emit(
      {
        status: "up_to_date",
        local_version: localTag,
        latest_version: latestTag,
        comparison: comparison === 0 ? "same" : "local_newer",
        checked_url: resolved.checkedUrl,
        resolution: resolved.resolution,
        message,
      },
      options.json,
    );
    return 0;
  }

  if (!options.apply) {
    emit(
      {
        status: "update_available",
        local_version: localTag,
        latest_version: latestTag,
        checked_url: resolved.checkedUrl,
        release_page: LATEST_RELEASE_PAGE,
        message: `发现新版 ${latestTag}。`,
      },
      options.json,
    );
    return 0;
  }

  try {
    const result = await applyReleaseUpdate(
      options.root,
      localTag,
      resolved.release,
      options,
    );
    emit(result, options.json);
  } catch (error) {
    emit(
      {
        status: "update_failed",
        local_version: localTag,
        latest_version: latestTag,
        blocking: false,
        release_page: LATEST_RELEASE_PAGE,
        message: `发现 ${latestTag}，但自动更新未完成；继续使用 ${localTag}。`,
        detail: error.message,
      },
      options.json,
    );
  }
  return 0;
}

const isEntryPoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  process.exitCode = await main();
}
