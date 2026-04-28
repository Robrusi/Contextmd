import {
  crawlDocs,
  DEFAULT_CONCURRENCY,
  getDocsPrefix,
  normalizePrefix,
  normalizeStartUrl,
  prepareDocsRoot,
  type Layout,
  type Options,
  writeIndex,
  writeManifest,
} from "./crawl.ts";
import { checkDocsFolder } from "./check.ts";
import { updateDocsFolder } from "./update.ts";

function usage() {
  console.log(`contextmd

Usage:
  contextmd <docs-url> [options]
  contextmd check <docs-folder>
  contextmd update <docs-folder>

Options:
  --out <dir>          Parent output directory. Default: current directory
  --name <folder>      Output folder name. Default: site hostname
  --max-pages <n>      Stop after n pages. Default: 500
  --concurrency <n>    Pages to fetch in parallel. Default: ${DEFAULT_CONCURRENCY}
  --prefix <path>      URL path prefix to keep. Default: first path segment
  --layout <mode>      title or route. Default: title
  --keep-query         Treat query strings as unique pages
  --no-clean           Do not delete the existing site output directory first
  -h, --help           Show this help

Examples:
  contextmd https://example.com/docs
  contextmd https://example.com/docs --max-pages 1000
  contextmd https://example.com/docs --layout route
  contextmd check ./example
  contextmd update ./example
`);
}

function parseLayout(value: string): Layout {
  if (value !== "title" && value !== "route") {
    throw new Error("--layout must be title or route");
  }

  return value;
}

function parseArgs(argv: string[]): { startUrl: string; options: Options } {
  const options: Options = {
    outDir: ".",
    maxPages: 500,
    concurrency: DEFAULT_CONCURRENCY,
    clean: true,
    keepQuery: false,
    layout: "title",
  };

  let startUrl = "";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }

    if (arg === "--keep-query") {
      options.keepQuery = true;
      continue;
    }

    if (arg === "--no-clean") {
      options.clean = false;
      continue;
    }

    if (
      arg === "--out" ||
      arg === "--name" ||
      arg === "--max-pages" ||
      arg === "--concurrency" ||
      arg === "--prefix" ||
      arg === "--layout"
    ) {
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      i += 1;

      if (arg === "--out") options.outDir = value;
      if (arg === "--name") options.name = value;

      if (arg === "--max-pages") {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new Error("--max-pages must be a positive number");
        }

        options.maxPages = parsed;
      }

      if (arg === "--concurrency") {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new Error("--concurrency must be a positive number");
        }

        options.concurrency = parsed;
      }

      if (arg === "--prefix") options.prefix = normalizePrefix(value);
      if (arg === "--layout") options.layout = parseLayout(value);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (startUrl) throw new Error("Only one docs URL can be provided");
    startUrl = arg;
  }

  if (!startUrl) {
    usage();
    process.exit(1);
  }

  return { startUrl: normalizeStartUrl(startUrl, options.keepQuery), options };
}

export async function main() {
  if (process.argv[2] === "update") {
    const docsFolder = process.argv[3];
    if (!docsFolder || process.argv.length > 4) {
      usage();
      process.exit(1);
    }

    const result = await updateDocsFolder(docsFolder);
    console.log(`Updated ${result.pages.length} pages.`);
    console.log(`Local docs updated at: ${result.docsRoot}`);
    return;
  }

  if (process.argv[2] === "check") {
    const docsFolder = process.argv[3];
    if (!docsFolder || process.argv.length > 4) {
      usage();
      process.exit(1);
    }

    const result = await checkDocsFolder(docsFolder);

    if (result.changed.length === 0 && result.failed.length === 0) {
      console.log(`Fresh. Checked ${result.checked} pages.`);
      return;
    }

    console.log(
      `Out of date. Checked ${result.checked} pages; ${result.changed.length} changed, ${result.failed.length} failed.`,
    );

    if (result.changed.length) {
      console.log("Changed:");
      for (const page of result.changed) {
        console.log(`  ${page.outputFile} - ${page.url}`);
      }
    }

    if (result.failed.length) {
      console.log("Failed:");
      for (const failure of result.failed) {
        console.log(`  ${failure.url} - ${failure.error}`);
      }
    }

    process.exit(1);
  }

  const { startUrl, options } = parseArgs(process.argv.slice(2));
  const docsRoot = await prepareDocsRoot(startUrl, options);
  const prefix = options.prefix ?? getDocsPrefix(startUrl);

  console.log(`Writing into ${docsRoot}`);
  console.log(
    `Keeping same-origin pages under ${new URL(startUrl).origin}${prefix}`,
  );

  const pages = await crawlDocs(startUrl, docsRoot, options);
  await writeIndex(docsRoot, pages);
  await writeManifest(docsRoot, startUrl, options, pages);

  console.log(`Done. Scraped ${pages.length} pages.`);
  console.log(`Local docs created at: ${docsRoot}`);
}
