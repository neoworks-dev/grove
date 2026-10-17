//! Markdown reduced to what a popover draws: paragraphs, headings, list items, quotes, rules
//! and code blocks, with bold, italic, code and links inside text.

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde_json::Value;

/// How a stretch of text is drawn.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SpanStyle {
    pub bold: bool,
    pub italic: bool,
    pub code: bool,
    pub link: bool,
    pub strikethrough: bool,
}

/// A stretch of text in one style.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Span {
    pub text: String,
    pub style: SpanStyle,
}

/// One block of a document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Block {
    Paragraph(Vec<Span>),
    Heading {
        level: u8,
        spans: Vec<Span>,
    },
    /// An item of a list, with its marker (`•` or `1.`) and how deeply the list is nested.
    ListItem {
        depth: usize,
        marker: String,
        spans: Vec<Span>,
    },
    Quote(Vec<Span>),
    Code {
        language: Option<String>,
        text: String,
    },
    Rule,
}

/// Parses markdown into blocks.
pub fn parse(markdown: &str) -> Vec<Block> {
    let mut builder = Builder::default();
    let options = Options::ENABLE_STRIKETHROUGH;
    for event in Parser::new_ext(markdown, options) {
        builder.event(event);
    }
    builder.finish()
}

/// What the text being collected will become when it ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Collecting {
    Paragraph,
    Heading(u8),
    Item,
    Quote,
}

#[derive(Default)]
struct Builder {
    blocks: Vec<Block>,
    spans: Vec<Span>,
    collecting: Option<Collecting>,
    style: SpanStyle,
    /// One entry per open list: the number of the next item when it is ordered.
    lists: Vec<Option<u64>>,
    /// The marker of the item being collected.
    marker: String,
    quote_depth: usize,
    /// The code block being collected: its language and text so far.
    code: Option<(Option<String>, String)>,
}

impl Builder {
    /// Takes one event of the parse into the blocks.
    fn event(&mut self, event: Event) {
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(text) => self.text(&text),
            Event::Code(text) => self.push_span(&text, SpanStyle { code: true, ..self.style }),
            Event::SoftBreak => self.push_span(" ", self.style),
            Event::HardBreak => self.push_span("\n", self.style),
            Event::Rule => self.blocks.push(Block::Rule),
            Event::Html(html) | Event::InlineHtml(html) => self.push_span(&visible_text_of_html(&html), self.style),
            _ => {}
        }
    }

    /// Begins a block or a style.
    fn start(&mut self, tag: Tag) {
        match tag {
            Tag::Paragraph => self.begin(Collecting::Paragraph),
            Tag::Heading { level, .. } => self.begin(Collecting::Heading(heading_number(level))),
            Tag::BlockQuote(_) => self.quote_depth += 1,
            Tag::CodeBlock(kind) => self.start_code(kind),
            Tag::List(first) => {
                self.flush();
                self.lists.push(first);
            }
            Tag::Item => self.start_item(),
            Tag::Emphasis => self.style.italic = true,
            Tag::Strong => self.style.bold = true,
            Tag::Strikethrough => self.style.strikethrough = true,
            Tag::Link { .. } => self.style.link = true,
            _ => {}
        }
    }

    /// Ends a block or a style.
    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::Item => self.flush(),
            TagEnd::BlockQuote(_) => self.quote_depth = self.quote_depth.saturating_sub(1),
            TagEnd::CodeBlock => self.end_code(),
            TagEnd::List(_) => {
                self.lists.pop();
            }
            TagEnd::Emphasis => self.style.italic = false,
            TagEnd::Strong => self.style.bold = false,
            TagEnd::Strikethrough => self.style.strikethrough = false,
            TagEnd::Link => self.style.link = false,
            _ => {}
        }
    }

    /// Starts collecting text for a block, unless an item is already collecting its own.
    fn begin(&mut self, collecting: Collecting) {
        if self.collecting == Some(Collecting::Item) && collecting == Collecting::Paragraph {
            if !self.spans.is_empty() {
                self.push_span("\n", self.style);
            }
            return;
        }
        self.flush();
        self.collecting = Some(if self.quote_depth > 0 && collecting == Collecting::Paragraph {
            Collecting::Quote
        } else {
            collecting
        });
    }

    /// Starts a list item, with the next number when the list is ordered.
    fn start_item(&mut self) {
        self.flush();
        self.marker = match self.lists.last_mut() {
            Some(Some(number)) => {
                let marker = format!("{number}.");
                *number += 1;
                marker
            }
            _ => "•".to_string(),
        };
        self.collecting = Some(Collecting::Item);
    }

    /// Text inside a code block is kept as it is; elsewhere it joins the collected spans.
    fn text(&mut self, text: &str) {
        if let Some((_, code)) = &mut self.code {
            code.push_str(text);
            return;
        }
        if self.collecting.is_none() {
            self.collecting = Some(Collecting::Paragraph);
        }
        self.push_span(text, self.style);
    }

    /// Adds text, joining the span before it when the style is the same.
    fn push_span(&mut self, text: &str, style: SpanStyle) {
        if self.collecting.is_none() {
            self.collecting = Some(Collecting::Paragraph);
        }
        if let Some(last) = self.spans.last_mut() {
            if last.style == style {
                last.text.push_str(text);
                return;
            }
        }
        self.spans.push(Span { text: text.to_string(), style });
    }

    /// Starts a code block.
    fn start_code(&mut self, kind: CodeBlockKind) {
        self.flush();
        let language = match kind {
            CodeBlockKind::Fenced(language) if !language.is_empty() => {
                language.split([',', ' ']).next().map(str::to_string)
            }
            _ => None,
        };
        self.code = Some((language, String::new()));
    }

    /// Ends a code block, without the line break its last line ends with.
    fn end_code(&mut self) {
        let Some((language, mut text)) = self.code.take() else {
            return;
        };
        while text.ends_with('\n') {
            text.pop();
        }
        self.blocks.push(Block::Code { language, text });
    }

    /// Turns the collected spans into a block.
    fn flush(&mut self) {
        let Some(collecting) = self.collecting.take() else {
            return;
        };
        let mut spans = std::mem::take(&mut self.spans);
        if let Some(last) = spans.last_mut() {
            last.text = last.text.trim_end().to_string();
        }
        if spans.iter().all(|span| span.text.is_empty()) {
            return;
        }
        let block = match collecting {
            Collecting::Paragraph => Block::Paragraph(spans),
            Collecting::Heading(level) => Block::Heading { level, spans },
            Collecting::Quote => Block::Quote(spans),
            Collecting::Item => {
                let depth = self.lists.len().saturating_sub(1);
                Block::ListItem { depth, marker: std::mem::take(&mut self.marker), spans }
            }
        };
        self.blocks.push(block);
    }

    /// The blocks, once the parse is over.
    fn finish(mut self) -> Vec<Block> {
        self.flush();
        self.blocks
    }
}

/// What reading a piece of HTML in documentation leaves visible. Formatting tags such as `<p>` and
/// comments draw nothing and `<br>` is a line break, but anything else that looks like a tag is text
/// somebody wrote, such as the `<T>` of `Vec<T>` or `Promise<string>` outside of backticks, and stays.
fn visible_text_of_html(html: &str) -> String {
    const FORMATTING_TAGS: [&str; 30] = [
        "p", "b", "i", "u", "em", "strong", "code", "pre", "a", "span", "div", "details", "summary", "sup", "sub",
        "img", "ul", "ol", "li", "hr", "table", "tr", "td", "th", "thead", "tbody", "h1", "h2", "h3", "kbd",
    ];
    let mut visible = String::new();
    let mut rest = html;
    while let Some(open) = rest.find('<') {
        visible.push_str(&rest[..open]);
        rest = &rest[open..];
        if rest.starts_with("<!--") {
            rest = rest.find("-->").map(|end| &rest[end + 3..]).unwrap_or("");
            continue;
        }
        let Some(close) = rest.find('>') else {
            visible.push_str(rest);
            return visible;
        };
        let tag = &rest[1..close];
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(|character| character.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        if name == "br" {
            visible.push('\n');
        } else if !FORMATTING_TAGS.contains(&name.as_str()) {
            visible.push_str(&rest[..=close]);
        }
        rest = &rest[close + 1..];
    }
    visible.push_str(rest);
    visible
}

/// The number of a heading level.
fn heading_number(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// The markdown a hover's `contents` stand for: a string, a `{ language, value }` code snippet,
/// a markup object, or a list of those.
pub fn contents_to_markdown(contents: &Value) -> String {
    match contents {
        Value::String(text) => text.clone(),
        Value::Array(entries) => {
            let parts: Vec<String> = entries.iter().map(contents_to_markdown).filter(|part| !part.is_empty()).collect();
            parts.join("\n\n")
        }
        Value::Object(_) => {
            let value = contents["value"].as_str().unwrap_or_default();
            match contents["language"].as_str() {
                Some(language) => format!("```{language}\n{value}\n```"),
                None => value.to_string(),
            }
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plain(text: &str) -> Span {
        Span { text: text.into(), style: SpanStyle::default() }
    }

    #[test]
    fn a_hover_is_a_signature_then_prose() {
        let blocks = parse("```rust\nfn main()\n```\n\n---\n\nRuns *first* and **fast** with `code`.\n");
        assert_eq!(blocks[0], Block::Code { language: Some("rust".into()), text: "fn main()".into() });
        assert_eq!(blocks[1], Block::Rule);
        let Block::Paragraph(spans) = &blocks[2] else {
            panic!("a paragraph");
        };
        assert_eq!(spans[0], plain("Runs "));
        assert!(spans[1].style.italic && spans[1].text == "first");
        assert!(spans[3].style.bold);
        assert!(spans[5].style.code && spans[5].text == "code");
    }

    #[test]
    fn lists_keep_their_markers_and_depth() {
        let blocks = parse("- one\n- two\n  - nested\n\n1. a\n2. b\n");
        let markers: Vec<(usize, &str)> = blocks
            .iter()
            .filter_map(|block| match block {
                Block::ListItem { depth, marker, .. } => Some((*depth, marker.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(markers, vec![(0, "•"), (0, "•"), (1, "•"), (0, "1."), (0, "2.")]);
    }

    #[test]
    fn headings_quotes_and_links_are_blocks_and_styles() {
        let blocks = parse("# Title\n\n> quoted\n\nsee [docs](https://x.y)\n");
        assert!(matches!(&blocks[0], Block::Heading { level: 1, .. }));
        assert!(matches!(&blocks[1], Block::Quote(_)));
        let Block::Paragraph(spans) = &blocks[2] else {
            panic!("a paragraph");
        };
        assert!(spans[1].style.link && spans[1].text == "docs");
    }

    #[test]
    fn empty_text_and_formatting_tags_draw_nothing() {
        assert!(parse("").is_empty());
        assert!(parse("<br>").is_empty());
        assert!(parse("<!-- note -->").is_empty());
    }

    #[test]
    fn angle_brackets_that_are_not_formatting_stay_as_text() {
        let blocks = parse("Returns a Vec<T> of <name> values.\n");
        let Block::Paragraph(spans) = &blocks[0] else {
            panic!("a paragraph");
        };
        let text: String = spans.iter().map(|span| span.text.as_str()).collect();
        assert_eq!(text, "Returns a Vec<T> of <name> values.");
        assert_eq!(visible_text_of_html("<p>Does <b>it</b><br>twice</p>"), "Does it\ntwice");
        let blocks = parse("<T> is the element type.\n");
        assert!(matches!(&blocks[0], Block::Paragraph(spans) if spans[0].text.starts_with("<T> is")));
    }

    #[test]
    fn hover_contents_come_in_every_shape() {
        assert_eq!(contents_to_markdown(&json!("text")), "text");
        assert_eq!(contents_to_markdown(&json!({ "language": "ts", "value": "let a" })), "```ts\nlet a\n```");
        assert_eq!(contents_to_markdown(&json!({ "kind": "markdown", "value": "**b**" })), "**b**");
        assert_eq!(contents_to_markdown(&json!(["a", { "language": "ts", "value": "b" }])), "a\n\n```ts\nb\n```");
        assert_eq!(contents_to_markdown(&Value::Null), "");
    }
}
