import { basename, dirname, resolve } from "node:path";

import { readManifest } from "./check.ts";
import {
  crawlDocs,
  prepareDocsRoot,
  writeIndex,
  writeManifest,
  type CrawlProgress,
  type Options,
  type Page,
} from "./crawl.ts";

export type UpdateResult = {
  docsRoot: string;
  pages: Page[];
};

export type UpdateOptions = {
  onProgress?: (progress: CrawlProgress) => void;
};

export async function updateDocsFolder(
  docsFolder: string,
  updateOptions: UpdateOptions = {},
): Promise<UpdateResult> {
  const requestedDocsRoot = resolve(process.cwd(), docsFolder);
  const manifest = await readManifest(requestedDocsRoot);
  const options: Options = {
    outDir: dirname(requestedDocsRoot),
    name: basename(requestedDocsRoot),
    maxPages: manifest.maxPages,
    concurrency: manifest.concurrency,
    prefix: manifest.prefix,
    clean: true,
    keepQuery: manifest.keepQuery,
    layout: manifest.layout,
  };

  const docsRoot = await prepareDocsRoot(manifest.startUrl, options);
  const pages = await crawlDocs(manifest.startUrl, docsRoot, {
    ...options,
    onProgress: updateOptions.onProgress,
  });
  await writeIndex(docsRoot, pages);
  await writeManifest(docsRoot, manifest.startUrl, options, pages);

  return { docsRoot, pages };
}
