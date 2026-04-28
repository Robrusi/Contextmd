import { resolve } from "node:path";

import {
  fetchHtml,
  hashContent,
  normalizeConcurrency,
  pageFromHtml,
  renderPageMarkdown,
  type CrawlContext,
  type Manifest,
} from "./crawl.ts";

export type ChangedPage = {
  url: string;
  outputFile: string;
  previousHash: string;
  currentHash: string;
};

export type FailedPage = {
  url: string;
  outputFile: string;
  error: string;
};

export type CheckResult = {
  checked: number;
  changed: ChangedPage[];
  failed: FailedPage[];
};

export type CheckProgress = {
  checked: number;
  total: number;
  changed: number;
  failed: number;
};

export type CheckOptions = {
  onProgress?: (progress: CheckProgress) => void;
};

function isManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<Manifest>;
  return (
    candidate.version === 1 &&
    typeof candidate.startUrl === "string" &&
    typeof candidate.origin === "string" &&
    typeof candidate.prefix === "string" &&
    (candidate.layout === "title" || candidate.layout === "route") &&
    typeof candidate.keepQuery === "boolean" &&
    typeof candidate.maxPages === "number" &&
    Array.isArray(candidate.pages)
  );
}

async function forEachConcurrent<T>(
  items: T[],
  concurrency: number | undefined,
  callback: (item: T) => Promise<void>,
) {
  let index = 0;

  const worker = async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item) await callback(item);
    }
  };

  await Promise.all(
    Array.from({ length: normalizeConcurrency(concurrency) }, () => worker()),
  );
}

export async function readManifest(docsRoot: string): Promise<Manifest> {
  const manifestPath = resolve(docsRoot, "_meta", "manifest.json");
  const raw = await Bun.file(manifestPath).text();
  const parsed = JSON.parse(raw);

  if (!isManifest(parsed)) {
    throw new Error(`Invalid manifest: ${manifestPath}`);
  }

  return parsed;
}

export async function checkDocsFolder(
  docsFolder: string,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const docsRoot = resolve(process.cwd(), docsFolder);
  const manifest = await readManifest(docsRoot);
  const outputByUrl = new Map(
    manifest.pages.map((page) => [page.url, page.outputFile]),
  );
  const context: CrawlContext = {
    docsRoot,
    prefix: manifest.prefix,
    startOrigin: manifest.origin,
    startHost: new URL(manifest.startUrl).hostname.replace(/^www\./, ""),
    options: {
      outDir: ".",
      maxPages: manifest.maxPages,
      concurrency: manifest.concurrency,
      prefix: manifest.prefix,
      clean: false,
      keepQuery: manifest.keepQuery,
      layout: manifest.layout,
    },
    outputByUrl,
  };
  const result: CheckResult = { checked: 0, changed: [], failed: [] };
  const reportProgress = () => {
    options.onProgress?.({
      checked: result.checked + result.failed.length,
      total: manifest.pages.length,
      changed: result.changed.length,
      failed: result.failed.length,
    });
  };

  reportProgress();

  await forEachConcurrent(
    manifest.pages,
    manifest.concurrency,
    async (manifestPage) => {
      try {
        const html = await fetchHtml(manifestPage.url);
        const fetchedPage = pageFromHtml(
          manifestPage.url,
          html,
          manifest.prefix,
          manifest.layout,
        );
        const currentPage = {
          ...fetchedPage,
          outputFile: manifestPage.outputFile,
        };

        outputByUrl.set(currentPage.url, currentPage.outputFile);
        const currentHash = hashContent(
          renderPageMarkdown(context, currentPage),
        );
        result.checked += 1;

        if (currentHash !== manifestPage.contentHash) {
          result.changed.push({
            url: manifestPage.url,
            outputFile: manifestPage.outputFile,
            previousHash: manifestPage.contentHash,
            currentHash,
          });
        }
      } catch (error) {
        result.failed.push({
          url: manifestPage.url,
          outputFile: manifestPage.outputFile,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        reportProgress();
      }
    },
  );

  return result;
}
