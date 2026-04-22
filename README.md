# Contextmd

Clone documentation websites into local Markdown files.

`contextmd` crawls pages from a docs site, extracts the main content, converts it to Markdown, and saves the files into the folder where you run the command.

## Quick Start

Run it with Bun:

```bash
bunx @robrusi/contextmd https://example.com/docs
```

Or install it globally:

```bash
bun add -g @robrusi/contextmd
contextmd https://example.com/docs
```

## Where Files Go

Run the command from the folder where you want the docs saved:

```bash
cd ~/docs
contextmd https://bun.com/docs
```

This creates:

```text
~/docs/bun/
```

By default, routes are saved as Markdown files:

```text
https://bun.com/docs/pm/cli/install
```

becomes:

```text
bun/pm/cli/install.md
```

An index of copied pages is also written to:

```text
bun/_meta/index.md
```

## Options

```text
--out <dir>          Parent output directory. Default: current directory
--max-pages <n>      Stop after n pages. Default: 500
--prefix <path>      URL path prefix to crawl. Default: first path segment
--layout <mode>      title or route. Default: title
--keep-query         Treat query strings as separate pages
--no-clean           Keep existing output instead of deleting it first
-h, --help           Show help
```

## Layouts

Default title layout:

```bash
contextmd https://example.com/docs
```

```text
api-reference/agents/tools.md
```

Route layout:

```bash
contextmd https://example.com/docs --layout route
```

```text
api-reference/agents/tools/index.md
```

## Examples

Save into the current folder:

```bash
contextmd https://example.com/docs
```

Save into a specific parent folder:

```bash
contextmd https://example.com/docs --out ./local-docs
```

Limit the crawl:

```bash
contextmd https://example.com/docs --max-pages 50
```

Only crawl a specific docs path:

```bash
contextmd https://example.com/docs --prefix /docs
```

## Notes

- `contextmd` only crawls same-origin pages under the selected prefix.
- It saves each page as soon as it is scraped.
- It does not run JavaScript from the website.
- It does not download assets such as images.
- Existing output is deleted before each run unless you pass `--no-clean`.

## Development

```bash
bun install
bun run typecheck
bun run index.ts --help
```

Use it locally as a command:

```bash
bun link
contextmd https://example.com/docs
```
