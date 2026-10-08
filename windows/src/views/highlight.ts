// Syntax colours for fenced code in chat answers (Prism). Prism only splits the
// code into tokens here; the spans are built with the DOM, never innerHTML, so
// whatever a model writes stays text.

import "./prism-manual";
// prism-core rather than the "prismjs" bundle, which also carries plugins
// (one fetches files). Languages build on each other, so the order matters.
import Prism from "prismjs/components/prism-core.js";
import "prismjs/components/prism-markup.js";
import "prismjs/components/prism-css.js";
import "prismjs/components/prism-clike.js";
import "prismjs/components/prism-javascript.js";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-python.js";
import "prismjs/components/prism-rust.js";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-powershell.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-yaml.js";
import "prismjs/components/prism-toml.js";
import "prismjs/components/prism-sql.js";
import "prismjs/components/prism-go.js";
import "prismjs/components/prism-java.js";
import "prismjs/components/prism-kotlin.js";
import "prismjs/components/prism-swift.js";
import "prismjs/components/prism-ruby.js";
import "prismjs/components/prism-c.js";
import "prismjs/components/prism-cpp.js";
import "prismjs/components/prism-csharp.js";
import "prismjs/components/prism-diff.js";

/** Fence names models use that Prism knows by another name. */
const ALIASES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", jsx: "javascript", mjs: "javascript",
  py: "python", rs: "rust", sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  ps1: "powershell", pwsh: "powershell", yml: "yaml", "c++": "cpp", cs: "csharp",
  kt: "kotlin", rb: "ruby", html: "markup", xml: "markup", svg: "markup", jsonc: "json",
};

/** Fills `pre` with `code`, coloured when `lang` is a language we know. */
export function highlightInto(pre: HTMLElement, code: string, lang: string): void {
  const id = lang.toLowerCase();
  const grammar = Prism.languages[ALIASES[id] ?? id];
  if (!grammar) {
    pre.textContent = code;
    return;
  }
  appendTokens(pre, Prism.tokenize(code, grammar));
}

function appendTokens(into: HTMLElement, stream: Prism.TokenStream): void {
  if (typeof stream === "string") {
    into.append(stream);
  } else if (Array.isArray(stream)) {
    for (const part of stream) appendTokens(into, part);
  } else {
    const span = document.createElement("span");
    span.className = `tok-${stream.type}`;
    appendTokens(span, stream.content);
    into.append(span);
  }
}
