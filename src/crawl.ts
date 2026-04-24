import * as cheerio from "cheerio";
import sanitize from "sanitize-filename";
import { createHash } from "node:crypto";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { mkdir, rm } from "node:fs/promises";

import {
  htmlToMarkdown,
  loadFragment,
  removeDuplicateTitle,
  renderMarkdown,
} from "./markdown.ts";

export type Layout = "title" | "route";

export type Options = {
  outDir: string;
  maxPages: number;
  prefix?: string;
  clean: boolean;
  keepQuery: boolean;
  layout: Layout;
};

export type Page = {
  url: string;
  title: string;
  mainHtml: string;
  outputFile: string;
};

type ManifestPage = {
  url: string;
  title: string;
  outputFile: string;
};

type CrawlContext = {
  docsRoot: string;
  prefix: string;
  startOrigin: string;
  startHost: string;
  options: Options;
  outputByUrl: Map<string, string>;
};

const HTML_EXTENSIONS = new Set(["", ".html", ".htm", ".php", ".aspx"]);

export function normalizeStartUrl(url: string, keepQuery: boolean): string {
  const normalized = normalizeUrl(url, url, keepQuery);
  if (!normalized) throw new Error(`Invalid docs URL: ${url}`);
  return normalized;
}

function normalizeUrl(
  href: string,
  base: string,
  keepQuery: boolean,
): string | null {
  try {
    const baseUrl = new URL(base);
    const url = new URL(href, base);
    if (!/^https?:$/.test(url.protocol)) return null;

    if (hostKey(url.hostname) === hostKey(baseUrl.hostname)) {
      url.hostname = baseUrl.hostname;
    }

    url.hash = "";
    if (!keepQuery) url.search = "";

    const path = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}${url.search}`;
  } catch {
    return null;
  }
}

export function normalizePrefix(prefix: string): string {
  if (!prefix || prefix === "/") return "/";
  return `/${prefix.replace(/^\/+|\/+$/g, "")}`;
}

export function getDocsPrefix(startUrl: string): string {
  const url = new URL(startUrl);
  const first = url.pathname.split("/").filter(Boolean)[0];
  return first ? `/${first}` : "/";
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") return true;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function hostKey(hostname: string): string {
  return hostname.replace(/^www\./, "");
}

function isLikelyHtmlUrl(url: string): boolean {
  const ext = extname(new URL(url).pathname).toLowerCase();
  return HTML_EXTENSIONS.has(ext);
}

export function siteSlugFromUrl(startUrl: string): string {
  const url = new URL(startUrl);
  const host = url.hostname.replace(/^www\./, "");
  return safeName(host.split(".")[0] ?? "site", "site").toLowerCase();
}

function safeName(value: string, fallback: string): string {
  const cleaned = sanitize(value)
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return (cleaned || fallback).slice(0, 120);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function humanizeSegment(segment: string): string {
  const withoutExt = segment.replace(/\.(html?|mdx?)$/i, "");
  const human = decodeSegment(withoutExt)
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bApi\b/g, "API")
    .replace(/\bSdk\b/g, "SDK");

  return human || "Page";
}

function routeSegments(url: string, prefix: string): string[] {
  const parsed = new URL(url);
  const path =
    parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/+$/g, "");
  const relativePath = prefix === "/" ? path : path.slice(prefix.length);

  return relativePath
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .filter((segment) => !/^index\.(html?|mdx?)$/i.test(segment));
}

function titleFromPage($: cheerio.CheerioAPI, url: string): string {
  const h1 = $("h1").first().text().trim();
  if (h1) return h1;

  const title = $("title").first().text().trim();
  if (title) return title.split("|")[0]?.trim() || title;

  const lastSegment = new URL(url).pathname.split("/").filter(Boolean).at(-1);
  return lastSegment ? humanizeSegment(lastSegment) : "Home";
}

function mainHtmlFromPage($: cheerio.CheerioAPI): string {
  $("script, style, noscript, template").remove();

  const selectors = [
    "#content",
    ".mdx-content",
    "[data-page-title]",
    "#content-area",
    "main article",
    "article",
    "main",
    "[data-pagefind-body]",
    "[role='main']",
    ".docs-content",
    ".markdown-body",
    "body",
  ];

  for (const selector of selectors) {
    const element = $(selector).first();
    if (element.length && element.text().trim().length > 100) {
      const content = element.clone();
      content
        .find(
          [
            "script",
            "style",
            "noscript",
            "template",
            "footer",
            "svg",
            "button",
            "[id='page-context-menu']",
            "[data-component-part='code-block-header']",
            "[data-testid='copy-code-button']",
            "[aria-label='Navigate to header']",
            "[aria-hidden='true']",
            "[tabindex='-1']",
          ].join(", "),
        )
        .remove();
      return content.html() || "";
    }
  }

  return $("body").html() || "";
}

function outputPathForPage(
  page: Pick<Page, "url">,
  prefix: string,
  layout: Layout,
): string {
  const segments = routeSegments(page.url, prefix);

  if (layout === "route") {
    if (segments.length === 0) return "index.md";
    const safeSegments = segments.map((segment) =>
      safeName(decodeSegment(segment), "page"),
    );
    return join(...safeSegments, "index.md");
  }

  if (segments.length === 0) return "index.md";

  const folders = segments
    .slice(0, -1)
    .map((segment) => safeName(decodeSegment(segment), "section"));
  const lastSegment = segments[segments.length - 1] ?? "index";
  const filename = `${safeName(
    decodeSegment(lastSegment).replace(/\.(html?|mdx?)$/i, ""),
    "index",
  )}.md`;

  return folders.length ? join(...folders, filename) : filename;
}

function dedupeOutputPath(
  candidate: string,
  url: string,
  used: Set<string>,
): string {
  if (!used.has(candidate)) return candidate;

  const ext = extname(candidate) || ".md";
  const base = candidate.slice(0, -ext.length);
  return `${base}-${createHash("sha1").update(url).digest("hex").slice(0, 8)}${ext}`;
}

function predictedOutputPath(
  url: string,
  prefix: string,
  layout: Layout,
): string {
  return outputPathForPage({ url }, prefix, layout);
}

function isInternalDocsUrl(
  url: string,
  context: Pick<CrawlContext, "startOrigin" | "startHost" | "prefix">,
): boolean {
  const parsed = new URL(url);
  if (
    parsed.origin !== context.startOrigin &&
    hostKey(parsed.hostname) !== context.startHost
  ) {
    return false;
  }

  if (!pathMatchesPrefix(parsed.pathname, context.prefix)) return false;
  return isLikelyHtmlUrl(url);
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "contextmd/1.0 (+https://github.com/local/contextmd)",
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) throw new Error(`Failed ${url}: HTTP ${response.status}`);

  const contentType = response.headers.get("content-type") || "";
  if (
    contentType &&
    !contentType.includes("text/html") &&
    !contentType.includes("application/xhtml+xml")
  ) {
    throw new Error(`Skipped ${url}: content-type ${contentType}`);
  }

  return response.text();
}

export async function crawlDocs(
  startUrl: string,
  docsRoot: string,
  options: Options,
): Promise<Page[]> {
  const start = new URL(startUrl);
  const context: CrawlContext = {
    docsRoot,
    prefix: options.prefix ?? getDocsPrefix(startUrl),
    startOrigin: start.origin,
    startHost: hostKey(start.hostname),
    options,
    outputByUrl: new Map(),
  };

  const metaDir = join(docsRoot, "_meta");
  await mkdir(metaDir, { recursive: true });

  const seen = new Set<string>();
  const queued = new Set<string>([startUrl]);
  const queue = [startUrl];
  const usedOutputPaths = new Set<string>();
  const pages: Page[] = [];

  while (queue.length && pages.length < options.maxPages) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;

    seen.add(current);
    console.log(`Loading ${current}`);

    let html = "";
    try {
      html = await fetchHtml(current);
    } catch (error) {
      console.warn(String(error));
      continue;
    }

    const $ = cheerio.load(html);
    const title = titleFromPage($, current);
    const mainHtml = mainHtmlFromPage($);
    const candidateOutputFile = outputPathForPage(
      { url: current },
      context.prefix,
      options.layout,
    );
    const outputFile = dedupeOutputPath(
      candidateOutputFile,
      current,
      usedOutputPaths,
    );
    usedOutputPaths.add(outputFile);

    const page: Page = { url: current, title, mainHtml, outputFile };
    pages.push(page);
    context.outputByUrl.set(current, outputFile);
    await writePage(context, page);
    await writeIndex(docsRoot, pages);
    console.log(`Saved ${outputFile}`);

    $("a[href]").each((_, element) => {
      const href = $(element).attr("href");
      if (!href) return;

      const next = normalizeUrl(href, current, options.keepQuery);
      if (!next || queued.has(next) || seen.has(next)) return;
      if (!isInternalDocsUrl(next, context)) return;

      queued.add(next);
      queue.push(next);
    });
  }

  if (queue.length) {
    console.warn(
      `Stopped at --max-pages ${options.maxPages}; ${queue.length} queued pages were not crawled.`,
    );
  }

  return pages;
}

function markdownRelative(fromFile: string, toFile: string): string {
  const fromDir = dirname(fromFile);
  const raw = relative(fromDir, toFile).split(sep).join("/");
  return raw.startsWith(".") ? raw : `./${raw}`;
}

function rewriteLinks(
  $: cheerio.CheerioAPI,
  currentPage: Page,
  context: CrawlContext,
) {
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href || href.startsWith("#")) return;

    let parsed: URL;
    try {
      parsed = new URL(href, currentPage.url);
    } catch {
      return;
    }

    const hash = parsed.hash;
    const normalized = normalizeUrl(
      href,
      currentPage.url,
      context.options.keepQuery,
    );
    if (!normalized) return;

    const target =
      context.outputByUrl.get(normalized) ??
      (isInternalDocsUrl(normalized, context)
        ? predictedOutputPath(
            normalized,
            context.prefix,
            context.options.layout,
          )
        : undefined);

    if (!target) {
      $(element).attr("href", normalized + hash);
      return;
    }

    if (target === currentPage.outputFile && hash) {
      $(element).attr("href", hash);
      return;
    }

    $(element).attr(
      "href",
      encodeURI(`${markdownRelative(currentPage.outputFile, target)}${hash}`),
    );
  });
}

async function writePage(context: CrawlContext, page: Page) {
  const finalFragment = loadFragment(page.mainHtml);
  removeDuplicateTitle(finalFragment, page.title);
  rewriteLinks(finalFragment, page, context);

  const finalBody = finalFragment("main[data-contextmd-root]").html() || "";
  const finalMarkdown = htmlToMarkdown(finalBody);
  const targetPath = join(context.docsRoot, page.outputFile);

  await mkdir(dirname(targetPath), { recursive: true });
  await Bun.write(targetPath, renderMarkdown(page.title, page.url, finalMarkdown));
}

export async function writeIndex(docsRoot: string, pages: Page[]) {
  const manifestPages: ManifestPage[] = pages.map(
    ({ url, title, outputFile }) => ({
      url,
      title,
      outputFile,
    }),
  );

  const index = [
    "# Local Docs Index",
    "",
    ...manifestPages.map(
      (page) =>
        `- [${page.outputFile}](../${encodeURI(page.outputFile)}) - ${page.url}`,
    ),
    "",
  ].join("\n");

  await Bun.write(join(docsRoot, "_meta", "index.md"), index);
}

export async function prepareDocsRoot(
  _startUrl: string,
  options: Pick<Options, "outDir" | "clean">,
): Promise<string> {
  const docsRoot = resolve(process.cwd(), options.outDir);

  if (options.clean) await rm(docsRoot, { recursive: true, force: true });
  await mkdir(docsRoot, { recursive: true });

  return docsRoot;
}
