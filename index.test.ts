import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { htmlToMarkdown, renderMarkdown } from "./src/index.ts";
import { checkDocsFolder } from "./src/check.ts";
import { updateDocsFolder } from "./src/update.ts";
import {
  crawlDocs,
  hashContent,
  prepareDocsRoot,
  renderPageMarkdown,
  siteSlugFromUrl,
  writeManifest,
  type CrawlContext,
  type Options,
  type Page,
} from "./src/crawl.ts";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("preserves code block filenames and languages from docs widgets", () => {
  const markdown = htmlToMarkdown(`
    <div class="code-block" language="json">
      <div data-component-part="code-block-header">
        <div data-component-part="code-block-header-filename">
          <span title="package.json">package.json</span>
        </div>
      </div>
      <div data-component-part="code-block-root">
        <pre language="json"><code language="json"><span class="line">{</span>
<span class="line">  "name": "demo"</span>
<span class="line">}</span></code></pre>
      </div>
    </div>
  `);

  expect(markdown).toContain("File: package.json");
  expect(markdown).toContain("```json");
  expect(markdown).toContain('"name": "demo"');
  expect(markdown).not.toContain("\npackage.json\n\n```json");
});

test("maps terminal examples to bash fences without noisy labels", () => {
  const markdown = htmlToMarkdown(`
    <div class="code-block" language="shellscript">
      <div data-component-part="code-block-header">
        <div data-component-part="code-block-header-filename">
          <span title="terminal">terminal</span>
        </div>
      </div>
      <pre><code class="language-shellscript">bun install --global cowsay</code></pre>
    </div>
  `);

  expect(markdown).toContain("```bash");
  expect(markdown).not.toContain("File: terminal");
  expect(markdown).toContain("bun install --global cowsay");
});

test("uses a longer fence when the snippet already contains triple backticks", () => {
  const markdown = htmlToMarkdown(`
    <pre><code class="language-ts">const example = \`\`\`ts\`;</code></pre>
  `);

  expect(markdown).toContain("````ts");
});

test("strips pretty-code captions after preserving them as file labels", () => {
  const markdown = htmlToMarkdown(`
    <figure data-rehype-pretty-code-figure>
      <figcaption>src/index.ts</figcaption>
      <pre><code class="language-ts">console.log("hello");</code></pre>
    </figure>
  `);

  expect(markdown).toContain("File: src/index.ts");
  expect(markdown).toContain('console.log("hello");');
  expect(markdown).not.toContain("\nsrc/index.ts\n\n```ts");
});

test("resolves diff-style code blocks to their final state", () => {
  const markdown = htmlToMarkdown(`
    <div class="code-block" language="json" data-title="package.json">
      <pre><code language="json">
        <span class="line">{</span>
        <span class="line line-diff line-remove">  "dev": "vite",</span>
        <span class="line line-diff line-add">  "dev": "bunx --bun vite",</span>
        <span class="line">  "build": "vite build"</span>
        <span class="line">}</span>
      </code></pre>
    </div>
  `);

  expect(markdown).toContain("File: package.json");
  expect(markdown).toContain('"dev": "bunx --bun vite"');
  expect(markdown).not.toContain('"dev": "vite"');
});

test("renders cleaned markdown with frontmatter and heading", () => {
  const output = renderMarkdown(
    "Example",
    "https://example.com/docs/example",
    "\n\nParagraph\n\n",
  );

  expect(output).toContain('title: "Example"');
  expect(output).toContain("# Example");
  expect(output).toContain("Paragraph");
});

test("prepareDocsRoot nests output under the site slug", async () => {
  const originalCwd = process.cwd();
  const sandbox = await mkdtemp(join(tmpdir(), "contextmd-"));
  tempDirs.push(sandbox);

  process.chdir(sandbox);

  try {
    const docsRoot = await prepareDocsRoot("https://bun.com/docs", {
      outDir: ".",
      clean: true,
    });

    expect(await realpath(docsRoot)).toBe(await realpath(join(sandbox, "bun")));
  } finally {
    process.chdir(originalCwd);
  }
});

test("prepareDocsRoot can use a custom folder name", async () => {
  const originalCwd = process.cwd();
  const sandbox = await mkdtemp(join(tmpdir(), "contextmd-"));
  tempDirs.push(sandbox);

  process.chdir(sandbox);

  try {
    const docsRoot = await prepareDocsRoot("https://bun.com/docs", {
      outDir: ".",
      name: "runtime docs",
      clean: true,
    });

    expect(await realpath(docsRoot)).toBe(
      await realpath(join(sandbox, "runtime docs")),
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test("site slug skips subdomains", () => {
  expect(siteSlugFromUrl("https://docs.composio.dev")).toBe("composio");
  expect(siteSlugFromUrl("https://api.composio.dev")).toBe("composio");
});

test("site slug uses bare domain name", () => {
  expect(siteSlugFromUrl("https://composio.dev")).toBe("composio");
});

test("writes a crawl manifest with content hashes", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "contextmd-"));
  tempDirs.push(sandbox);

  const docsRoot = join(sandbox, "docs");
  await mkdir(docsRoot, { recursive: true });
  await Bun.write(join(docsRoot, "index.md"), "# Home\n");

  const options: Options = {
    outDir: ".",
    maxPages: 10,
    clean: true,
    keepQuery: false,
    layout: "title",
  };
  const pages: Page[] = [
    {
      url: "https://example.com/docs",
      title: "Home",
      mainHtml: "<p>Hello</p>",
      outputFile: "index.md",
    },
  ];

  await writeManifest(docsRoot, "https://example.com/docs", options, pages);

  const manifest = JSON.parse(
    await Bun.file(join(docsRoot, "_meta", "manifest.json")).text(),
  );

  expect(manifest.version).toBe(1);
  expect(manifest.startUrl).toBe("https://example.com/docs");
  expect(manifest.prefix).toBe("/docs");
  expect(manifest.pages[0].contentHash).toBe(hashContent("# Home\n"));
});

test("checks a docs folder against the saved manifest", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "contextmd-"));
  tempDirs.push(sandbox);

  const docsRoot = join(sandbox, "docs");
  await mkdir(join(docsRoot, "_meta"), { recursive: true });

  const html = "<main><h1>Home</h1><p>Hello</p></main>";
  const page: Page = {
    url: "https://example.com/docs",
    title: "Home",
    mainHtml: "<h1>Home</h1><p>Hello</p>",
    outputFile: "index.md",
  };
  const context: CrawlContext = {
    docsRoot,
    prefix: "/docs",
    startOrigin: "https://example.com",
    startHost: "example.com",
    options: {
      outDir: ".",
      maxPages: 10,
      prefix: "/docs",
      clean: false,
      keepQuery: false,
      layout: "title",
    },
    outputByUrl: new Map([[page.url, page.outputFile]]),
  };
  const contentHash = hashContent(renderPageMarkdown(context, page));

  await Bun.write(
    join(docsRoot, "_meta", "manifest.json"),
    `${JSON.stringify(
      {
        version: 1,
        startUrl: page.url,
        origin: "https://example.com",
        prefix: "/docs",
        layout: "title",
        keepQuery: false,
        maxPages: 10,
        crawledAt: new Date().toISOString(),
        pages: [
          {
            url: page.url,
            title: page.title,
            outputFile: page.outputFile,
            contentHash,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  globalThis.fetch = (async () =>
    new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as unknown as typeof fetch;

  const result = await checkDocsFolder(docsRoot);

  expect(result.checked).toBe(1);
  expect(result.changed).toEqual([]);
  expect(result.failed).toEqual([]);
});

test("reports check progress", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "contextmd-"));
  tempDirs.push(sandbox);

  const docsRoot = join(sandbox, "docs");
  await mkdir(join(docsRoot, "_meta"), { recursive: true });

  const html = "<main><h1>Home</h1><p>Hello</p></main>";
  const page: Page = {
    url: "https://example.com/docs",
    title: "Home",
    mainHtml: "<h1>Home</h1><p>Hello</p>",
    outputFile: "index.md",
  };
  const context: CrawlContext = {
    docsRoot,
    prefix: "/docs",
    startOrigin: "https://example.com",
    startHost: "example.com",
    options: {
      outDir: ".",
      maxPages: 10,
      prefix: "/docs",
      clean: false,
      keepQuery: false,
      layout: "title",
    },
    outputByUrl: new Map([[page.url, page.outputFile]]),
  };
  const contentHash = hashContent(renderPageMarkdown(context, page));

  await Bun.write(
    join(docsRoot, "_meta", "manifest.json"),
    `${JSON.stringify(
      {
        version: 1,
        startUrl: page.url,
        origin: "https://example.com",
        prefix: "/docs",
        layout: "title",
        keepQuery: false,
        maxPages: 10,
        crawledAt: new Date().toISOString(),
        pages: [
          {
            url: page.url,
            title: page.title,
            outputFile: page.outputFile,
            contentHash,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  globalThis.fetch = (async () =>
    new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as unknown as typeof fetch;

  const progress: Array<{ checked: number; total: number }> = [];
  await checkDocsFolder(docsRoot, {
    onProgress: ({ checked, total }) => {
      progress.push({ checked, total });
    },
  });

  expect(progress[0]).toEqual({ checked: 0, total: 1 });
  expect(progress.at(-1)).toEqual({ checked: 1, total: 1 });
});

test("reports changed pages when remote content no longer matches", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "contextmd-"));
  tempDirs.push(sandbox);

  const docsRoot = join(sandbox, "docs");
  await mkdir(join(docsRoot, "_meta"), { recursive: true });

  await Bun.write(
    join(docsRoot, "_meta", "manifest.json"),
    `${JSON.stringify(
      {
        version: 1,
        startUrl: "https://example.com/docs",
        origin: "https://example.com",
        prefix: "/docs",
        layout: "title",
        keepQuery: false,
        maxPages: 10,
        crawledAt: new Date().toISOString(),
        pages: [
          {
            url: "https://example.com/docs",
            title: "Home",
            outputFile: "index.md",
            contentHash: hashContent("old content"),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  globalThis.fetch = (async () =>
    new Response("<main><h1>Home</h1><p>New content</p></main>", {
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;

  const result = await checkDocsFolder(docsRoot);

  expect(result.checked).toBe(1);
  expect(result.changed).toHaveLength(1);
  expect(result.changed[0]?.outputFile).toBe("index.md");
});

test("updates a docs folder from its manifest", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "contextmd-"));
  tempDirs.push(sandbox);

  const docsRoot = join(sandbox, "docs");
  await mkdir(join(docsRoot, "_meta"), { recursive: true });
  await Bun.write(join(docsRoot, "stale.md"), "stale");
  await Bun.write(
    join(docsRoot, "_meta", "manifest.json"),
    `${JSON.stringify(
      {
        version: 1,
        startUrl: "https://example.com/docs",
        origin: "https://example.com",
        prefix: "/docs",
        layout: "title",
        keepQuery: false,
        maxPages: 10,
        crawledAt: new Date().toISOString(),
        pages: [
          {
            url: "https://example.com/docs",
            title: "Old",
            outputFile: "index.md",
            contentHash: hashContent("old content"),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  globalThis.fetch = (async () =>
    new Response("<main><h1>Home</h1><p>Updated docs</p></main>", {
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;

  const progress: Array<{ fetched: number; total: number }> = [];
  const result = await updateDocsFolder(docsRoot, {
    onProgress: ({ fetched, total }) => {
      progress.push({ fetched, total });
    },
  });
  const updatedFile = await Bun.file(join(docsRoot, "index.md")).text();
  const updatedManifest = JSON.parse(
    await Bun.file(join(docsRoot, "_meta", "manifest.json")).text(),
  );

  expect(result.pages).toHaveLength(1);
  expect(progress[0]).toEqual({ fetched: 0, total: 1 });
  expect(progress.some((item) => item.fetched === 1)).toBe(true);
  expect(updatedFile).toContain("Updated docs");
  expect(await Bun.file(join(docsRoot, "stale.md")).exists()).toBe(false);
  expect(updatedManifest.pages[0].contentHash).toBe(hashContent(updatedFile));
});

test("crawls discovered pages in parallel", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "contextmd-"));
  tempDirs.push(sandbox);

  const docsRoot = join(sandbox, "docs");
  await mkdir(docsRoot, { recursive: true });

  let active = 0;
  let maxActive = 0;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    active += 1;
    maxActive = Math.max(maxActive, active);

    await Bun.sleep(20);

    const url = String(input);
    active -= 1;

    const body =
      url === "https://example.com/docs"
        ? `<main><h1>Home</h1><p>${"Home ".repeat(30)}</p><a href="/docs/a">A</a><a href="/docs/b">B</a><a href="/docs/c">C</a></main>`
        : `<main><h1>${url}</h1><p>${"Leaf ".repeat(30)}</p></main>`;

    return new Response(body, {
      headers: { "content-type": "text/html" },
    });
  }) as unknown as typeof fetch;

  const progress: Array<{ fetched: number; total: number }> = [];
  const pages = await crawlDocs("https://example.com/docs", docsRoot, {
    outDir: ".",
    maxPages: 4,
    concurrency: 3,
    prefix: "/docs",
    clean: false,
    keepQuery: false,
    layout: "title",
    onProgress: ({ fetched, total }) => {
      progress.push({ fetched, total });
    },
  });

  expect(pages).toHaveLength(4);
  expect(maxActive).toBeGreaterThan(1);
  expect(progress[0]).toEqual({ fetched: 0, total: 1 });
  expect(progress.some((item) => item.fetched === 4)).toBe(true);
  expect(await Bun.file(join(docsRoot, "a.md")).exists()).toBe(true);
  expect(await Bun.file(join(docsRoot, "b.md")).exists()).toBe(true);
  expect(await Bun.file(join(docsRoot, "c.md")).exists()).toBe(true);
});

test("reports crawl failures without stopping the crawl", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "contextmd-"));
  tempDirs.push(sandbox);

  const docsRoot = join(sandbox, "docs");
  await mkdir(docsRoot, { recursive: true });

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/missing")) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(
      `<main><h1>Home</h1><p>${"Home ".repeat(30)}</p><a href="/docs/missing">Missing</a></main>`,
      {
        headers: { "content-type": "text/html" },
      },
    );
  }) as unknown as typeof fetch;

  const failures: Array<{ url: string; error: string }> = [];
  const pages = await crawlDocs("https://example.com/docs", docsRoot, {
    outDir: ".",
    maxPages: 2,
    concurrency: 2,
    prefix: "/docs",
    clean: false,
    keepQuery: false,
    layout: "title",
    onFailure: (failure) => {
      failures.push(failure);
    },
  });

  expect(pages).toHaveLength(1);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.url).toBe("https://example.com/docs/missing");
  expect(failures[0]?.error).toContain("HTTP 404");
});
