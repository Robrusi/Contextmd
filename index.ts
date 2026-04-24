#!/usr/bin/env bun
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import sanitize from "sanitize-filename";
import { createHash } from "node:crypto";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { mkdir, rm } from "node:fs/promises";

type Layout = "title" | "route";

type Options = {
  outDir: string;
  maxPages: number;
  prefix?: string;
  clean: boolean;
  keepQuery: boolean;
  layout: Layout;
};

type Page = {
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
const GENERIC_CODE_BLOCK_LABELS = new Set([
  "bash",
  "code",
  "console",
  "plaintext",
  "shell",
  "shellscript",
  "terminal",
  "text",
  "zsh",
]);
const CODE_BLOCK_WRAPPER_SELECTORS = [
  ".code-block",
  "figure",
  "[data-rehype-pretty-code-figure]",
  "[data-language]",
  "[language]",
].join(", ");
const CODE_BLOCK_CHROME_SELECTORS = [
  "[data-component-part='code-block-header']",
  "[data-component-part='code-block-header-filename']",
  "[data-rehype-pretty-code-title]",
  "[data-rehype-pretty-code-caption]",
  "figcaption",
  "[data-line-number]",
  ".line-number",
  ".line-numbers",
  "[class*='line-number']",
  "[class*='line-numbers']",
  "[data-testid='copy-code-button']",
  "[data-copy-code]",
  ".copy-button",
  ".copy-code-button",
  "button[aria-label*='copy' i]",
].join(", ");
function normalizeCodeLanguage(language?: string | null): string | undefined {
  const normalized = language
    ?.trim()
    .toLowerCase()
    .replace(/^language-/, "");

  if (!normalized) return undefined;
  if (
    normalized === "console" ||
    normalized === "shell" ||
    normalized === "shellscript" ||
    normalized === "shell-session" ||
    normalized === "sh" ||
    normalized === "terminal" ||
    normalized === "zsh"
  ) {
    return "bash";
  }

  if (
    normalized === "plain" ||
    normalized === "plaintext" ||
    normalized === "txt"
  ) {
    return "text";
  }

  return normalized;
}

function codeLanguageFromClassName(className?: string | null): string | undefined {
  if (!className) return undefined;

  for (const token of className.split(/\s+/)) {
    const match = token.match(/(?:lang|language)-([a-z0-9#+-]+)/i);
    if (match?.[1]) return match[1];
  }

  return undefined;
}

function normalizeCodeBlockLabel(
  label?: string | null,
  language?: string,
): string | undefined {
  const cleaned = label?.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;

  const lower = cleaned.toLowerCase();
  if (GENERIC_CODE_BLOCK_LABELS.has(lower)) return undefined;
  if (language && lower === language.toLowerCase()) return undefined;

  return cleaned;
}

function firstNonEmptyValue(
  ...values: Array<string | null | undefined>
): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (value.trim()) return value;
  }

  return undefined;
}

function extractCodeBlockText(
  $: cheerio.CheerioAPI,
  pre: cheerio.Cheerio<any>,
  wrapper: cheerio.Cheerio<any>,
): string {
  const code = pre.find("code").first();
  const lineElements = code.children(".line");
  if (!lineElements.length) {
    return normalizeCodeText(code.text() || pre.text() || "");
  }

  const hasDiffLines = lineElements
    .toArray()
    .some((line) => $(line).hasClass("line-add") || $(line).hasClass("line-remove"));

  const lines = lineElements
    .toArray()
    .filter((line) => !(hasDiffLines && $(line).hasClass("line-remove")))
    .map((line) => $(line).text());

  const normalized = normalizeCodeText(lines.join("\n"));
  if (normalized) return normalized;

  const sanitizedWrapper = wrapper.clone();
  sanitizedWrapper.find(CODE_BLOCK_CHROME_SELECTORS).remove();
  return normalizeCodeText(sanitizedWrapper.find("pre").first().text() || pre.text() || "");
}

function structuralizeCodeBlocks($: cheerio.CheerioAPI): Map<string, string> {
  const targets: Array<{
    pre: any;
    container: any;
  }> = [];
  const seenContainers = new Set<any>();
  const placeholders = new Map<string, string>();

  $("main[data-contextmd-root] pre").each((_, element) => {
    const pre = $(element);
    const ancestorWrapper = pre.parents(CODE_BLOCK_WRAPPER_SELECTORS).first();
    const wrapper = ancestorWrapper.length ? ancestorWrapper : pre;
    const container =
      wrapper.length && wrapper.find("pre").length === 1 ? wrapper : pre;
    const node = container.get(0);
    if (!node || seenContainers.has(node)) return;

    seenContainers.add(node);
    targets.push({
      pre: element,
      container: node,
    });
  });

  for (const [index, { pre: preElement, container: containerElement }] of targets.entries()) {
    const pre = $(preElement);
    const container = $(containerElement);
    const code = pre.find("code").first();
    const language = normalizeCodeLanguage(
      pre.attr("data-language") ??
        pre.attr("language") ??
        code.attr("data-language") ??
        code.attr("language") ??
        codeLanguageFromClassName(pre.attr("class")) ??
        codeLanguageFromClassName(code.attr("class")) ??
        container.attr("data-language") ??
        container.attr("language") ??
        codeLanguageFromClassName(container.attr("class")),
    );

    const label = normalizeCodeBlockLabel(
      firstNonEmptyValue(
        container
          .find("[data-component-part='code-block-header-filename'] [title]")
          .first()
          .attr("title"),
        container
          .find("[data-component-part='code-block-header-filename'] span")
          .first()
          .text(),
        container.find("[data-rehype-pretty-code-title]").first().text(),
        container.find("figcaption").first().text(),
        container.attr("data-filename"),
        container.attr("data-title"),
      ),
      language,
    );

    const text = extractCodeBlockText($, pre, container);
    const placeholder = `CTXMDBLOCK${index}TOKEN`;
    placeholders.set(
      placeholder,
      renderCodeBlockMarkdown(text, language, label),
    );

    container.replaceWith(`<p>${placeholder}</p>`);
  }

  return placeholders;
}

function normalizeCodeText(code: string): string {
  return code
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/^\n+|\n+$/g, "");
}

function codeFenceFor(code: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(code.matchAll(/`+/g), (match) => match[0].length),
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

function renderCodeBlockMarkdown(
  code: string,
  language?: string,
  label?: string,
): string {
  const normalizedCode = normalizeCodeText(code);
  if (!normalizedCode) return "";

  const normalizedLanguage = normalizeCodeLanguage(language);
  const normalizedLabel = normalizeCodeBlockLabel(label, normalizedLanguage);
  const fence = codeFenceFor(normalizedCode);
  const header = normalizedLabel ? `File: ${normalizedLabel}\n` : "";

  return `${header}${fence}${normalizedLanguage ?? ""}\n${normalizedCode}\n${fence}`;
}

function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  service.use(gfm);
  service.addRule("contextmdCodeBlocks", {
    filter: "pre",
    replacement: (_content, node) => {
      const markdown = renderCodeBlockMarkdown(
        node.textContent || "",
        node.getAttribute("data-contextmd-language") ??
          node.getAttribute("language") ??
          undefined,
        node.getAttribute("data-contextmd-label") ?? undefined,
      );
      if (!markdown) return "\n\n";

      return `\n\n${markdown}\n\n`;
    },
  });

  return service;
}

const turndown = createTurndownService();

function usage() {
  console.log(`contextmd

Usage:
  contextmd <docs-url> [options]

Options:
  --out <dir>          Parent output directory. Default: current directory
  --max-pages <n>      Stop after n pages. Default: 500
  --prefix <path>      URL path prefix to keep. Default: first path segment
  --layout <mode>      title or route. Default: title
  --keep-query         Treat query strings as unique pages
  --no-clean           Do not delete the existing site output directory first
  -h, --help           Show this help

Examples:
  contextmd https://example.com/docs
  contextmd https://example.com/docs --max-pages 1000
  contextmd https://example.com/docs --layout route
`);
}

function parseArgs(argv: string[]): { startUrl: string; options: Options } {
  const options: Options = {
    outDir: ".",
    maxPages: 500,
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
      arg === "--max-pages" ||
      arg === "--prefix" ||
      arg === "--layout"
    ) {
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      i += 1;

      if (arg === "--out") options.outDir = value;
      if (arg === "--max-pages") {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new Error("--max-pages must be a positive number");
        }
        options.maxPages = parsed;
      }
      if (arg === "--prefix") options.prefix = normalizePrefix(value);
      if (arg === "--layout") {
        if (value !== "title" && value !== "route") {
          throw new Error("--layout must be title or route");
        }
        options.layout = value;
      }
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

function normalizeStartUrl(url: string, keepQuery: boolean): string {
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

function normalizePrefix(prefix: string): string {
  if (!prefix || prefix === "/") return "/";
  return `/${prefix.replace(/^\/+|\/+$/g, "")}`;
}

function getDocsPrefix(startUrl: string): string {
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

function siteSlugFromUrl(startUrl: string): string {
  const url = new URL(startUrl);
  const host = url.hostname.replace(/^www\./, "");
  return safeName(host.split(".")[0] ?? "site", "site").toLowerCase();
}

function pageSlug(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname.split("/").filter(Boolean).join("-");
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);
  return `${safeName(path || "index", "index")}-${hash}`;
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
  page: Pick<Page, "url" | "title">,
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
  const filename = `${safeName(decodeSegment(lastSegment).replace(/\.(html?|mdx?)$/i, ""), "index")}.md`;

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
  return outputPathForPage({ url, title: "" }, prefix, layout);
}

function isInternalDocsUrl(
  url: string,
  context: Pick<CrawlContext, "startOrigin" | "startHost" | "prefix">,
): boolean {
  const parsed = new URL(url);
  if (
    parsed.origin !== context.startOrigin &&
    hostKey(parsed.hostname) !== context.startHost
  )
    return false;
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

async function crawlDocs(
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
      { url: current, title },
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

function loadFragment(html: string): cheerio.CheerioAPI {
  return cheerio.load(`<main data-contextmd-root>${html}</main>`);
}

function removeDuplicateTitle($: cheerio.CheerioAPI, title: string) {
  const firstH1 = $("main[data-contextmd-root] h1").first();
  if (firstH1.text().trim() === title.trim()) {
    firstH1.remove();
  }
}

function markdownRelative(fromFile: string, toFile: string): string {
  const fromDir = dirname(fromFile);
  const raw = relative(fromDir, toFile).split(sep).join("/");
  return raw.startsWith(".") ? raw : `./${raw}`;
}

function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function htmlToMarkdown(html: string): string {
  const fragment = loadFragment(html);
  const placeholders = structuralizeCodeBlocks(fragment);
  const finalBody = fragment("main[data-contextmd-root]").html() || "";
  let markdown = turndown.turndown(finalBody);

  for (const [placeholder, codeBlockMarkdown] of placeholders) {
    markdown = markdown.replace(placeholder, codeBlockMarkdown);
  }

  return markdown;
}

function frontmatter(title: string, sourceUrl: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\nsource_url: ${JSON.stringify(sourceUrl)}\n---`;
}

export function renderMarkdown(
  title: string,
  sourceUrl: string,
  bodyMarkdown: string,
): string {
  const cleaned = normalizeMarkdown(bodyMarkdown);
  return `${frontmatter(title, sourceUrl)}\n\n# ${title}\n\n${cleaned}\n`;
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

async function writeIndex(docsRoot: string, pages: Page[]) {
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

async function main() {
  const { startUrl, options } = parseArgs(process.argv.slice(2));
  const siteSlug = siteSlugFromUrl(startUrl);
  const docsRoot = resolve(process.cwd(), options.outDir, siteSlug);
  const prefix = options.prefix ?? getDocsPrefix(startUrl);

  if (options.clean) await rm(docsRoot, { recursive: true, force: true });
  await mkdir(docsRoot, { recursive: true });

  console.log(`Writing into ${docsRoot}`);
  console.log(
    `Keeping same-origin pages under ${new URL(startUrl).origin}${prefix}`,
  );

  const pages = await crawlDocs(startUrl, docsRoot, options);
  await writeIndex(docsRoot, pages);

  console.log(`Done. Scraped ${pages.length} pages.`);
  console.log(`Local docs created at: ${docsRoot}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
