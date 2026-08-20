import type { ReactNode } from "react";

/**
 * A deliberately small Markdown renderer.
 *
 * It builds React elements directly — no HTML string is ever produced and
 * `dangerouslySetInnerHTML` is never used — so anything the model or a person
 * writes is inert by construction. Raw HTML in the source is shown as text.
 *
 * Supported: fenced code blocks, inline code, bold, italic, links (http(s) and
 * mailto only), bullet and numbered lists, blockquotes, headings, paragraphs.
 */

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

const linkSafe = (href: string): boolean => SAFE_LINK.test(href.trim());

/** Inline spans: `code`, **bold**, *italic*, [text](url), bare URLs. */
const renderInline = (text: string, keyBase: string): ReactNode[] => {
  const nodes: ReactNode[] = [];
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyBase}-i${index++}`;

    if (token.startsWith("`")) {
      nodes.push(<code key={key} className="md-code">{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      nodes.push(
        linkSafe(href) ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {label}
          </a>
        ) : (
          <span key={key}>{label}</span>
        ),
      );
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      nodes.push(
        <a key={key} href={token} target="_blank" rel="noopener noreferrer nofollow">
          {token}
        </a>,
      );
    }
    last = match.index + token.length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length > 0 ? nodes : [text];
};

export const renderMarkdown = (source: string, keyBase = "md"): ReactNode[] => {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let block = 0;
  const nextKey = () => `${keyBase}-b${block++}`;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    // Fenced code block.
    const fence = line.match(/^\s*```(\w+)?\s*$/);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence
      blocks.push(
        <pre key={nextKey()} className="md-pre">
          <code data-lang={fence[1] ?? undefined}>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Heading.
    const heading = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (heading) {
      const key = nextKey();
      const content = renderInline(heading[2], key);
      blocks.push(
        heading[1].length <= 2 ? (
          <h4 key={key} className="md-heading">{content}</h4>
        ) : (
          <h5 key={key} className="md-heading">{content}</h5>
        ),
      );
      index += 1;
      continue;
    }

    // Blockquote — also how a quoted reply appears in the thread.
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      const key = nextKey();
      blocks.push(
        <blockquote key={key} className="md-quote">
          {body.map((quoted, position) => (
            <p key={position}>{renderInline(quoted, `${key}-${position}`)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    // Bullet list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ""));
        index += 1;
      }
      const key = nextKey();
      blocks.push(
        <ul key={key} className="md-list">
          {items.map((item, position) => (
            <li key={position}>{renderInline(item, `${key}-${position}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Numbered list.
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ""));
        index += 1;
      }
      const key = nextKey();
      blocks.push(
        <ol key={key} className="md-list">
          {items.map((item, position) => (
            <li key={position}>{renderInline(item, `${key}-${position}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph: consecutive plain lines.
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim().length > 0 &&
      !/^\s*(```|#{1,4}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    const key = nextKey();
    blocks.push(<p key={key}>{renderInline(paragraph.join(" "), key)}</p>);
  }

  return blocks;
};

/** Message body (one string per paragraph) rendered as safe Markdown. */
export const MarkdownBody = ({ body }: { body: string[] }) => (
  <>{renderMarkdown(body.join("\n\n"))}</>
);