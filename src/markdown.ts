import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

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

function normalizeCodeText(code: string): string {
  return code
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/^\n+|\n+$/g, "");
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

  return normalizeCodeText(
    sanitizedWrapper.find("pre").first().text() || pre.text() || "",
  );
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

export function loadFragment(html: string): cheerio.CheerioAPI {
  return cheerio.load(`<main data-contextmd-root>${html}</main>`);
}

export function removeDuplicateTitle($: cheerio.CheerioAPI, title: string) {
  const firstH1 = $("main[data-contextmd-root] h1").first();
  if (firstH1.text().trim() === title.trim()) {
    firstH1.remove();
  }
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
