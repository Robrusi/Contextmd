# Contextmd

Clone documentation websites into local Markdown files.

`contextmd` crawls pages from a docs site, extracts the main content, converts it to Markdown, and saves the files into a site-named folder inside the folder where you run the command.

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

A freshness manifest is written to:

```text
bun/_meta/manifest.json
```

## Options

```text
Commands:
  contextmd <docs-url> [options]
  contextmd check <docs-folder>
  contextmd update <docs-folder>

--out <dir>          Parent output directory. Default: current directory
--name <folder>      Output folder name. Default: site hostname
--max-pages <n>      Stop after n pages. Default: 500
--concurrency <n>    Pages to fetch in parallel. Default: 12
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

Choose the generated folder name:

```bash
contextmd https://example.com/docs --name example-docs
```

Limit the crawl:

```bash
contextmd https://example.com/docs --max-pages 50
```

Fetch more pages in parallel:

```bash
contextmd https://example.com/docs --concurrency 24
```

Only crawl a specific docs path:

```bash
contextmd https://example.com/docs --prefix /docs
```

Check whether a generated docs folder is up to date:

```bash
contextmd check ./example
```

The check command reads `_meta/manifest.json`, refetches each recorded source
URL, regenerates Markdown in memory, and compares it with the saved content
hash. It prints `Fresh` when all known pages still match, or `Out of date` with
the changed or failed pages listed.

The command exits with status `0` when the folder is fresh and status `1` when
any known page changed or failed to load, so it can be used in scripts or CI.

Update a generated docs folder:

```bash
contextmd update ./example
```

The update command reads `_meta/manifest.json` to reuse the original start URL,
prefix, layout, query handling, and page limit. It then replaces the generated
folder with a fresh crawl and writes a new manifest.

## Using With Agents

`contextmd` is useful when you want an AI coding agent to answer from local docs instead of searching the web.

First, clone the docs into a folder:

```bash
mkdir -p ~/agent-docs
cd ~/agent-docs
contextmd https://example.com/docs
```

Then point your agent at the generated folder:

```text
Use the local docs in ~/agent-docs/example/ for this task. Search _meta/index.md and the generated Markdown files before using web search.
```

For repeated use, add an instruction to your project's `AGENTS.md` so coding agents search the generated local docs before using web search.

### Project-local docs

You can keep generated docs inside a project in a hidden folder:

```bash
cd my-app
mkdir -p .contextmd
contextmd https://example.com/docs --out .contextmd
```

That creates:

```text
my-app/
  .contextmd/
    example/
      index.md
      api-reference/
        agents/
          tools.md
      _meta/
        index.md
```

Then tell the agent:

```text
Use .contextmd/example/ as the documentation source for this project.
```

Usually you should add the folder to `.gitignore`:

```gitignore
.contextmd/
```

Real example:

```bash
cd ~/projects/my-app
contextmd https://docs.agentmail.to --out .contextmd
```

Then tell the agent:

```text
Use .contextmd/agentmail/ as the docs source for AgentMail.
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
bun run src/index.ts --help
```

Use it locally as a command:

```bash
bun link
contextmd https://example.com/docs
```
