import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
const ASSET_PATTERN = /^build-boutique-store-plan-v\d+\.\d+\.\d+\.zip$/;
const PAGE_SIZE = 100;

function requestReleasePage(repository, page) {
  const endpoint = `repos/${repository}/releases?per_page=${PAGE_SIZE}&page=${page}`;
  const raw = execFileSync("gh", ["api", endpoint], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const releases = JSON.parse(raw);
  if (!Array.isArray(releases)) {
    throw new Error(`GitHub returned a non-array response for page ${page}`);
  }
  return releases;
}

export function fetchAllReleases(repository, requestPage = requestReleasePage) {
  const releases = [];

  for (let page = 1; ; page += 1) {
    const currentPage = requestPage(repository, page);
    if (!Array.isArray(currentPage)) {
      throw new Error(`Release page ${page} is not an array`);
    }
    releases.push(...currentPage);
    if (currentPage.length < PAGE_SIZE) {
      return releases;
    }
  }
}

export function summarizeReleaseDownloads(
  repository,
  releases,
  asOf = new Date().toISOString(),
) {
  const versions = releases
    .filter(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        RELEASE_TAG_PATTERN.test(String(release.tag_name)),
    )
    .flatMap((release) =>
      (release.assets || [])
        .filter(
          (asset) =>
            ASSET_PATTERN.test(asset.name) &&
            asset.name === `build-boutique-store-plan-${release.tag_name}.zip`,
        )
        .map((asset) => ({
          version: release.tag_name,
          asset: asset.name,
          downloads: Number(asset.download_count) || 0,
          published_at: release.published_at,
          url: asset.browser_download_url,
        })),
    )
    .sort((left, right) => {
      const byDate = String(right.published_at).localeCompare(
        String(left.published_at),
      );
      return byDate || String(right.version).localeCompare(String(left.version));
    });

  return {
    as_of: asOf,
    repository,
    asset_pattern: "build-boutique-store-plan-v*.zip",
    versions,
    cumulative_downloads: versions.reduce(
      (total, version) => total + version.downloads,
      0,
    ),
    note:
      "This snapshot counts only existing matching assets on stable GitHub Releases. Source archives, clones, repository views, and deleted or replaced assets are excluded; it is not unique users or installs.",
  };
}

function validateRepository(value) {
  if (
    !value ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
  ) {
    throw new Error(
      "Usage: node .github/scripts/release_asset_downloads.mjs <owner/repo>",
    );
  }
  return value;
}

function main() {
  const repository = validateRepository(
    process.argv[2] || process.env.GITHUB_REPOSITORY,
  );
  const releases = fetchAllReleases(repository);
  const report = summarizeReleaseDownloads(repository, releases);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
