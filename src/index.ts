#!/usr/bin/env bun

import { main } from "./cli.ts";

export { htmlToMarkdown, renderMarkdown } from "./markdown.ts";

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
