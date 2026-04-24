import { expect, test } from "bun:test";

import { htmlToMarkdown, renderMarkdown } from "./src/index.ts";

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
