// Markdown as the blocks and spans the chat draws (`agents/chat/Blocks.svelte`), for the bodies and
// comments of issues and pull requests. Ported from the suite daemon's `view/markdown.ts`, which
// parses what agents write the same way, so a body reads in this pane as it would in the chat.
// What GitHub allows and the chat does not need is dealt with here: HTML comments, which
// issue templates are full of, are dropped, and an image becomes its description in brackets.

import { Lexer, type Token, type Tokens } from "marked";
import type { Block, ColumnAlign, ListItem, Span, TableBlock, TableCell } from "@suite/protocol/types";

/** What a span has besides its text. */
type Style = Omit<Span, "text">;

/** Whether two spans look the same, so their text can be one run. */
function sameStyle(first: Span, second: Span): boolean {
  return (
    first.bold === second.bold &&
    first.italic === second.italic &&
    first.code === second.code &&
    first.strike === second.strike &&
    first.href === second.href
  );
}

/** Text with the HTML entities `marked` leaves in it turned back into characters. */
function decode(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/** Adds text to the spans, joining it to the last span when they look the same. */
function push(spans: Span[], text: string, style: Style): void {
  if (text === "") {
    return;
  }
  const span: Span = { text, ...style };
  const last = spans[spans.length - 1];
  if (last !== undefined && sameStyle(last, span)) {
    last.text += text;
    return;
  }
  spans.push(span);
}

/** The spans of inline tokens, in the style they inherit. */
function inline(tokens: Token[] | undefined, style: Style, spans: Span[]): Span[] {
  if (tokens === undefined) {
    return spans;
  }
  for (const token of tokens) {
    inlineToken(token, style, spans);
  }
  return spans;
}

/** Adds one inline token to the spans. */
function inlineToken(token: Token, style: Style, spans: Span[]): void {
  switch (token.type) {
    case "strong":
      inline(token.tokens, { ...style, bold: true }, spans);
      return;
    case "em":
      inline(token.tokens, { ...style, italic: true }, spans);
      return;
    case "del":
      inline(token.tokens, { ...style, strike: true }, spans);
      return;
    case "codespan":
      push(spans, decode(token.text), { ...style, code: true });
      return;
    case "link":
      inline(token.tokens, { ...style, href: token.href }, spans);
      return;
    case "image":
      push(spans, `[image: ${imageName(token)}]`, style);
      return;
    case "br":
      push(spans, "\n", style);
      return;
    case "html":
      return;
    case "text":
      if (token.tokens !== undefined) {
        inline(token.tokens, style, spans);
        return;
      }
      push(spans, decode(token.text), style);
      return;
    default:
      push(spans, decode(plainText(token)), style);
  }
}

/** What an image is called: its description, else where it is from. */
function imageName(token: Token): string {
  const image = token as Tokens.Image;
  if (image.text !== "") {
    return image.text;
  }
  return image.href;
}

/** The text of a token `marked` has no special case for here, or its source. */
function plainText(token: Token): string {
  if ("text" in token) {
    return String(token.text);
  }
  return token.raw;
}

/** A table block from a table token. */
function tableBlock(token: Tokens.Table): TableBlock {
  const cell = (entry: Tokens.TableCell): TableCell => ({ spans: inline(entry.tokens, {}, []) });
  const block: TableBlock = {
    type: "table_block",
    header: token.header.map(cell),
    rows: token.rows.map((row) => row.map(cell)),
  };
  // marked says null for a column the separator row does not align.
  if (token.align.some((alignment) => alignment !== null)) {
    block.align = token.align.map((alignment): ColumnAlign => {
      if (alignment === null) {
        return "left";
      }
      return alignment;
    });
  }
  return block;
}

/** A list block from a list token. */
function listBlock(token: Tokens.List): Block {
  const items: ListItem[] = token.items.map((item) => {
    const listItem: ListItem = { blocks: blocks(item.tokens.filter((child) => child.type !== "checkbox")) };
    if (item.task) {
      listItem.checked = item.checked === true;
    }
    return listItem;
  });
  const list: Block = { type: "list", ordered: token.ordered, items };
  if (token.ordered && typeof token.start === "number") {
    list.start = token.start;
  }
  return list;
}

/** A code block from a code token. */
function codeBlock(token: Tokens.Code): Block {
  const code: Block = { type: "code_block", code: token.text };
  if (token.lang) {
    code.language = token.lang;
  }
  return code;
}

/** Whether a block-level HTML token is only a comment, which draws nothing. */
function isHtmlComment(token: Token): boolean {
  return token.type === "html" && token.raw.trim().startsWith("<!--") && token.raw.trim().endsWith("-->");
}

/** The blocks of block-level tokens. */
function blocks(tokens: Token[]): Block[] {
  const found: Block[] = [];
  for (const token of tokens) {
    const block = blockOf(token);
    if (block !== null) {
      found.push(block);
    }
  }
  return found;
}

/** The block a token makes, or null when it makes none. */
function blockOf(token: Token): Block | null {
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "heading":
      return { type: "heading", level: token.depth, spans: inline(token.tokens, {}, []) };
    case "paragraph":
    case "text":
      return paragraphBlock(token);
    case "list":
      return listBlock(token as Tokens.List);
    case "code":
      return codeBlock(token as Tokens.Code);
    case "blockquote":
      return { type: "quote", blocks: blocks(token.tokens === undefined ? [] : token.tokens) };
    case "hr":
      return { type: "rule" };
    case "table":
      return tableBlock(token as Tokens.Table);
    default:
      return rawBlock(token);
  }
}

/** A paragraph from a paragraph or a loose text token. */
function paragraphBlock(token: Token): Block {
  const tokens = (token as Tokens.Paragraph).tokens;
  if (tokens !== undefined) {
    return { type: "paragraph", spans: inline(tokens, {}, []) };
  }
  return { type: "paragraph", spans: [{ text: decode(plainText(token)) }] };
}

/** HTML and anything else: kept as monospace source rather than dropped, except comments. */
function rawBlock(token: Token): Block | null {
  if (isHtmlComment(token)) {
    return null;
  }
  return { type: "code_block", code: token.raw.replace(/\n+$/, "") };
}

/** Parses markdown, as GitHub writes it, into blocks. */
export function parseMarkdown(source: string): Block[] {
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, "");
  return blocks(Lexer.lex(withoutComments.replace(/\r\n/g, "\n"), { gfm: true }));
}
