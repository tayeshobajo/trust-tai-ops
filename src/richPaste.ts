/**
 * Rich-text paste support for the chat composer.
 *
 * Google Docs, Notion, Slack and email clients all put a `text/html` flavour on
 * the clipboard alongside the plain text. The plain flavour throws away links
 * and emphasis, which is why a pasted doc used to lose its URLs. We convert the
 * HTML into Markdown instead — the composer already renders Markdown, so what
 * you paste is what you see.
 *
 * Everything here is pure text transformation. Nothing is executed: the HTML is
 * parsed with DOMParser into an inert document, and only text nodes plus a small
 * allow-list of tags are read.
 */

const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "BLOCKQUOTE",
  "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TR", "PRE", "TABLE",
]);

const escapeInline = (text: string): string =>
  text.replace(/([\\`*_[\]])/g, "\\$1");

const collapse = (text: string): string => text.replace(/[ \t\n\r]+/g, " ");

const isHttpish = (href: string): boolean => /^(https?:|mailto:|tel:)/i.test(href.trim());

type Ctx = { listStack: Array<{ ordered: boolean; index: number }>; inPre: boolean };

const renderChildren = (node: Node, ctx: Ctx): string => {
  let out = "";
  node.childNodes.forEach((child) => {
    out += renderNode(child, ctx);
  });
  return out;
};

const renderNode = (node: Node, ctx: Ctx): string => {
  if (node.nodeType === 3) {
    const raw = node.textContent ?? "";
    return ctx.inPre ? raw : escapeInline(collapse(raw));
  }
  if (node.nodeType !== 1) return "";

  const el = node as HTMLElement;
  const tag = el.tagName.toUpperCase();

  switch (tag) {
    case "SCRIPT":
    case "STYLE":
    case "NOSCRIPT":
    case "HEAD":
      return "";
    case "BR":
      return "\n";
    case "HR":
      return "\n\n---\n\n";
    case "A": {
      const href = el.getAttribute("href") ?? "";
      const label = renderChildren(el, ctx).trim();
      if (!href || !isHttpish(href)) return label;
      const clean = href.trim();
      if (!label) return clean;
      // A bare URL as its own label reads better unwrapped.
      if (label === clean || escapeInline(clean) === label) return clean;
      return `[${label}](${clean})`;
    }
    case "STRONG":
    case "B": {
      const inner = renderChildren(el, ctx);
      // Google Docs wraps whole selections in <b style="font-weight:normal">.
      if (/^(normal|400)$/i.test(el.style.fontWeight)) return inner;
      const trimmed = inner.trim();
      return trimmed ? `**${trimmed}**` : "";
    }
    case "EM":
    case "I": {
      const inner = renderChildren(el, ctx);
      if (/^normal$/i.test(el.style.fontStyle)) return inner;
      const trimmed = inner.trim();
      return trimmed ? `*${trimmed}*` : "";
    }
    case "CODE": {
      if (ctx.inPre) return renderChildren(el, ctx);
      const inner = (el.textContent ?? "").trim();
      return inner ? `\`${inner}\`` : "";
    }
    case "PRE": {
      const inner = (el.textContent ?? "").replace(/\n+$/, "");
      return inner ? `\n\n\`\`\`\n${inner}\n\`\`\`\n\n` : "";
    }
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const level = Number(tag.slice(1));
      const inner = renderChildren(el, ctx).trim();
      return inner ? `\n\n${"#".repeat(level)} ${inner}\n\n` : "";
    }
    case "BLOCKQUOTE": {
      const inner = renderChildren(el, ctx).trim();
      if (!inner) return "";
      return `\n\n${inner.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    }
    case "UL":
    case "OL": {
      ctx.listStack.push({ ordered: tag === "OL", index: 0 });
      const inner = renderChildren(el, ctx);
      ctx.listStack.pop();
      return `\n${inner.replace(/\n{3,}/g, "\n\n")}\n`;
    }
    case "LI": {
      const depth = Math.max(ctx.listStack.length - 1, 0);
      const frame = ctx.listStack[ctx.listStack.length - 1];
      const inner = renderChildren(el, ctx).trim();
      if (!inner) return "";
      const indent = "  ".repeat(depth);
      if (frame?.ordered) {
        frame.index += 1;
        return `${indent}${frame.index}. ${inner}\n`;
      }
      return `${indent}- ${inner}\n`;
    }
    case "IMG": {
      const alt = el.getAttribute("alt")?.trim();
      const src = el.getAttribute("src") ?? "";
      // Inline data-URI images arrive as real attachments; skip them here.
      if (!src || src.startsWith("data:")) return alt ? escapeInline(alt) : "";
      return `![${alt ?? ""}](${src})`;
    }
    case "TD":
    case "TH":
      return `${renderChildren(el, ctx).trim()}  `;
    default: {
      const inner = renderChildren(el, ctx);
      return BLOCK_TAGS.has(tag) ? `\n${inner}\n` : inner;
    }
  }
};

const tidy = (markdown: string): string =>
  markdown
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Converts clipboard HTML into Markdown. Returns "" when nothing useful is left. */
export const htmlToMarkdown = (html: string): string => {
  if (!html.trim()) return "";
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return "";
  }
  const body = doc.body;
  if (!body) return "";
  return tidy(renderChildren(body, { listStack: [], inPre: false }));
};

/**
 * The Markdown to insert for a paste, or null when the plain-text flavour is
 * already faithful (no links, no emphasis, no structure) and should win.
 */
export const markdownFromClipboard = (data: DataTransfer | null): string | null => {
  if (!data) return null;
  const html = data.getData("text/html");
  if (!html) return null;
  const plain = data.getData("text/plain") ?? "";
  const markdown = htmlToMarkdown(html);
  if (!markdown) return null;
  const addsMeaning = /\[[^\]]*\]\(|\*\*|^[-*] |^\d+\. |^> |^#{1,6} |```/m.test(markdown);
  if (!addsMeaning) return null;
  // Identical content means the plain flavour already carried everything.
  if (markdown === plain.trim()) return null;
  return markdown;
};
