//! Completion items from a server, and the fuzzy matching that narrows them as the person types.

use serde_json::Value;

use crate::protocol::{Range, TextEdit};

/// What kind of thing an item is, as far as its icon goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemKind {
    Text,
    Method,
    Function,
    Constructor,
    Field,
    Variable,
    Class,
    Interface,
    Module,
    Property,
    Unit,
    Value,
    Enum,
    Keyword,
    Snippet,
    Color,
    File,
    Reference,
    Folder,
    EnumMember,
    Constant,
    Struct,
    Event,
    Operator,
    TypeParameter,
}

impl ItemKind {
    /// The kind a number from the protocol stands for.
    pub fn from_number(number: Option<u64>) -> ItemKind {
        use ItemKind::*;
        const KINDS: [ItemKind; 25] = [
            Text,
            Method,
            Function,
            Constructor,
            Field,
            Variable,
            Class,
            Interface,
            Module,
            Property,
            Unit,
            Value,
            Enum,
            Keyword,
            Snippet,
            Color,
            File,
            Reference,
            Folder,
            EnumMember,
            Constant,
            Struct,
            Event,
            Operator,
            TypeParameter,
        ];
        match number {
            Some(number) if (1..=25).contains(&number) => KINDS[number as usize - 1],
            _ => Text,
        }
    }

    /// The one or two characters drawn in the kind's badge.
    pub fn glyph(self) -> &'static str {
        use ItemKind::*;
        match self {
            Text => "t",
            Method => "m",
            Function => "ƒ",
            Constructor => "c",
            Field => "f",
            Variable => "v",
            Class => "C",
            Interface => "I",
            Module => "M",
            Property => "p",
            Unit => "u",
            Value => "=",
            Enum => "E",
            Keyword => "k",
            Snippet => "s",
            Color => "#",
            File => "F",
            Reference => "r",
            Folder => "D",
            EnumMember => "e",
            Constant => "K",
            Struct => "S",
            Event => "!",
            Operator => "+",
            TypeParameter => "T",
        }
    }

    /// The family of colour the badge is drawn in.
    pub fn family(self) -> KindFamily {
        use ItemKind::*;
        match self {
            Method | Function | Constructor => KindFamily::Callable,
            Field | Variable | Property | Value | Constant | EnumMember | Reference => KindFamily::Value,
            Class | Interface | Struct | Enum | TypeParameter | Module | Unit => KindFamily::Type,
            Keyword | Operator | Snippet => KindFamily::Keyword,
            Text | Color | File | Folder | Event => KindFamily::Plain,
        }
    }
}

/// Groups of kinds that share a colour.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KindFamily {
    Callable,
    Value,
    Type,
    Keyword,
    Plain,
}

/// The text an item puts in the document, where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ItemEdit {
    /// The range the text replaces, in the server's positions at the time of the request.
    pub range: Range,
    pub new_text: String,
}

/// One suggestion.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub label: String,
    /// Shown after the label, such as a signature or the module an item comes from.
    pub detail: Option<String>,
    pub kind: ItemKind,
    /// Markdown, if the item has documentation yet.
    pub documentation: Option<String>,
    pub sort_text: String,
    pub filter_text: String,
    /// The text to insert when the item has no edit of its own.
    pub insert_text: String,
    pub is_snippet: bool,
    pub edit: Option<ItemEdit>,
    pub additional_edits: Vec<TextEdit>,
    pub deprecated: bool,
    pub preselect: bool,
    /// The item as the server sent it, which resolving it sends back.
    pub raw: Value,
}

impl Item {
    /// Takes in what resolving the item added: documentation, detail, and the edits it makes
    /// elsewhere, which a server often leaves out of the first answer because they are slow to work out.
    pub fn merge_resolved(&mut self, resolved: &Value) {
        let Some(fuller) = parse_item(resolved, &Value::Null) else {
            return;
        };
        if fuller.documentation.is_some() {
            self.documentation = fuller.documentation;
        }
        if fuller.detail.is_some() {
            self.detail = fuller.detail;
        }
        if !fuller.additional_edits.is_empty() {
            self.additional_edits = fuller.additional_edits;
        }
        if fuller.edit.is_some() {
            self.edit = fuller.edit;
        }
        // Servers such as `vtsls` add the parentheses of a function call, as a snippet, only when resolving.
        if resolved.get("insertTextFormat").is_some() {
            self.is_snippet = fuller.is_snippet;
        }
        if resolved["insertText"].is_string() {
            self.insert_text = fuller.insert_text;
        }
        self.raw = resolved.clone();
    }
}

/// The items of an answer, and whether the server wants asking again as the word grows.
#[derive(Clone, Debug, PartialEq)]
pub struct ItemList {
    pub items: Vec<Item>,
    pub is_incomplete: bool,
}

/// Reads the answer to a completion request: nothing, a list of items, or a list object.
pub fn parse_items(result: &Value) -> ItemList {
    let (entries, defaults, is_incomplete) = match result {
        Value::Array(entries) => (entries.as_slice(), &Value::Null, false),
        Value::Object(object) => {
            let entries = object.get("items").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
            let null = &Value::Null;
            (entries, object.get("itemDefaults").unwrap_or(null), result["isIncomplete"].as_bool().unwrap_or(false))
        }
        _ => (&[][..], &Value::Null, false),
    };
    let items = entries.iter().filter_map(|entry| parse_item(entry, defaults)).collect();
    ItemList { items, is_incomplete }
}

/// Reads one item, with the list's defaults filled in where the item says nothing.
pub fn parse_item(entry: &Value, defaults: &Value) -> Option<Item> {
    let label = entry["label"].as_str()?.to_string();
    let detail = detail_of(entry);
    let insert_format = entry.get("insertTextFormat").or_else(|| defaults.get("insertTextFormat"));
    let edit = edit_of(entry, defaults);
    let insert_text = match entry["insertText"].as_str() {
        Some(text) => text.to_string(),
        None => label.clone(),
    };
    let filter_text = match entry["filterText"].as_str() {
        Some(text) => text.to_string(),
        None => label.clone(),
    };
    let sort_text = match entry["sortText"].as_str() {
        Some(text) => text.to_string(),
        None => label.clone(),
    };
    let additional_edits = match entry.get("additionalTextEdits") {
        Some(edits) => serde_json::from_value(edits.clone()).unwrap_or_default(),
        None => Vec::new(),
    };
    let deprecated = entry["deprecated"].as_bool().unwrap_or(false)
        || entry["tags"].as_array().is_some_and(|tags| tags.iter().any(|tag| tag.as_u64() == Some(1)));
    Some(Item {
        label,
        detail,
        kind: ItemKind::from_number(entry["kind"].as_u64()),
        documentation: documentation_of(&entry["documentation"]),
        sort_text,
        filter_text,
        insert_text,
        is_snippet: insert_format.and_then(Value::as_u64) == Some(2),
        edit,
        additional_edits,
        deprecated,
        preselect: entry["preselect"].as_bool().unwrap_or(false),
        raw: entry.clone(),
    })
}

/// The text after an item's label: the label details when there are some, else the detail.
fn detail_of(entry: &Value) -> Option<String> {
    let details = &entry["labelDetails"];
    let mut combined = String::new();
    if let Some(detail) = details["detail"].as_str() {
        combined.push_str(detail);
    }
    if let Some(description) = details["description"].as_str() {
        if !combined.is_empty() {
            combined.push(' ');
        }
        combined.push_str(description);
    }
    if !combined.is_empty() {
        return Some(combined);
    }
    entry["detail"].as_str().filter(|detail| !detail.is_empty()).map(str::to_string)
}

/// The documentation of an item as markdown: a plain string, or a markup object.
pub fn documentation_of(documentation: &Value) -> Option<String> {
    let text = match documentation {
        Value::String(text) => text.clone(),
        Value::Object(_) => documentation["value"].as_str()?.to_string(),
        _ => return None,
    };
    if text.trim().is_empty() {
        return None;
    }
    Some(text)
}

/// The item's own edit, from `textEdit` (a plain edit, or an insert and a replace range, of which
/// the insert is taken) or the list's default range.
fn edit_of(entry: &Value, defaults: &Value) -> Option<ItemEdit> {
    let text_edit = &entry["textEdit"];
    if text_edit.is_object() {
        let range = text_edit.get("range").or_else(|| text_edit.get("insert"))?;
        return Some(ItemEdit {
            range: serde_json::from_value(range.clone()).ok()?,
            new_text: text_edit["newText"].as_str()?.to_string(),
        });
    }
    let default_range = defaults.get("editRange")?;
    let range = default_range.get("insert").unwrap_or(default_range);
    let new_text = match entry["textEditText"].as_str() {
        Some(text) => text,
        None => entry["insertText"].as_str().or_else(|| entry["label"].as_str())?,
    };
    Some(ItemEdit { range: serde_json::from_value(range.clone()).ok()?, new_text: new_text.to_string() })
}

/// An item that matched what was typed.
#[derive(Clone, Debug, PartialEq)]
pub struct Match {
    /// The index in the list that was filtered.
    pub index: usize,
    pub score: i64,
    /// The characters of the item's label that matched, for highlighting.
    pub label_positions: Vec<usize>,
}

/// How many matches are kept; more than a panel could ever show.
pub const MAX_MATCHES: usize = 200;

/// The items that match `query`, best first. Nothing typed matches everything, in the server's
/// order. A query matches an item whose filter text has its characters in order, ignoring case.
pub fn filter(items: &[Item], query: &str) -> Vec<Match> {
    let query_characters: Vec<char> = query.chars().collect();
    let mut matches: Vec<Match> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let Some(filter_match) = fuzzy_match(&query_characters, &item.filter_text) else {
            continue;
        };
        let label_positions = label_positions(&query_characters, item, &filter_match);
        let mut score = filter_match.score;
        if item.preselect {
            score += 50;
        }
        if item.deprecated {
            score -= 100;
        }
        matches.push(Match { index, score, label_positions });
    }
    matches.sort_by(|left, right| {
        right.score.cmp(&left.score).then_with(|| {
            let (left_item, right_item) = (&items[left.index], &items[right.index]);
            left_item.sort_text.cmp(&right_item.sort_text).then_with(|| left_item.label.cmp(&right_item.label))
        })
    });
    matches.truncate(MAX_MATCHES);
    matches
}

/// The positions to highlight in the label: those of the match when the filter text is the label,
/// else a match of the query on the label itself.
fn label_positions(query: &[char], item: &Item, filter_match: &FuzzyMatch) -> Vec<usize> {
    if item.filter_text == item.label {
        return filter_match.positions.clone();
    }
    match fuzzy_match(query, &item.label) {
        Some(label_match) => label_match.positions,
        None => Vec::new(),
    }
}

/// How well a query matched a text, and where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FuzzyMatch {
    pub score: i64,
    pub positions: Vec<usize>,
}

/// Matches a query against a text: every character of the query in order, case ignored. Scores
/// favour a match at the start, at word starts (after `_` or `-`, or a capital after a small
/// letter), runs of consecutive characters, and the same case; they count against gaps and a
/// late start. Finds the best match by dynamic programming, so `fb` prefers `FooBar` to `fabulous_b`.
pub fn fuzzy_match(query: &[char], text: &str) -> Option<FuzzyMatch> {
    if query.is_empty() {
        return Some(FuzzyMatch { score: 0, positions: Vec::new() });
    }
    let text_characters: Vec<char> = text.chars().collect();
    if query.len() > text_characters.len() {
        return None;
    }
    let lower_text: Vec<char> = text_characters.iter().map(|character| lowercase(*character)).collect();
    let lower_query: Vec<char> = query.iter().map(|character| lowercase(*character)).collect();
    if !is_subsequence(&lower_query, &lower_text) {
        return None;
    }
    best_alignment(query, &lower_query, &text_characters, &lower_text)
}

/// The first character of the lowercase form of a character.
fn lowercase(character: char) -> char {
    character.to_lowercase().next().unwrap_or(character)
}

/// Whether the query's characters appear in the text in order.
fn is_subsequence(query: &[char], text: &[char]) -> bool {
    let mut next = 0;
    for character in text {
        if next < query.len() && *character == query[next] {
            next += 1;
        }
    }
    next == query.len()
}

const MATCH_SCORE: i64 = 16;
const CONSECUTIVE_BONUS: i64 = 12;
const WORD_START_BONUS: i64 = 14;
const FIRST_CHARACTER_BONUS: i64 = 20;
const SAME_CASE_BONUS: i64 = 2;
const GAP_PENALTY: i64 = 2;
const LEADING_GAP_PENALTY: i64 = 1;
const PREFIX_BONUS: i64 = 40;

/// Finds the alignment of the query in the text with the best score, and its positions.
fn best_alignment(query: &[char], lower_query: &[char], text: &[char], lower_text: &[char]) -> Option<FuzzyMatch> {
    let (rows, columns) = (query.len(), text.len());
    const NONE: i64 = i64::MIN / 2;
    // best[i][j]: the best score with query[..=i] matched and query[i] at text[j].
    let mut best = vec![vec![NONE; columns]; rows];
    let mut came_from = vec![vec![usize::MAX; columns]; rows];
    for i in 0..rows {
        for j in i..columns {
            if lower_query[i] != lower_text[j] {
                continue;
            }
            let own = character_score(query[i], text, j);
            if i == 0 {
                best[i][j] = own - LEADING_GAP_PENALTY * j as i64;
                continue;
            }
            let mut chosen = NONE;
            for previous in (i - 1)..j {
                if best[i - 1][previous] == NONE {
                    continue;
                }
                let gap = (j - previous - 1) as i64;
                let joined = if gap == 0 { CONSECUTIVE_BONUS } else { -GAP_PENALTY * gap };
                let score = best[i - 1][previous] + joined;
                if score > chosen {
                    chosen = score;
                    came_from[i][j] = previous;
                }
            }
            if chosen != NONE {
                best[i][j] = chosen + own;
            }
        }
    }
    let (end, score) = (0..columns).map(|j| (j, best[rows - 1][j])).max_by_key(|(_, score)| *score)?;
    if score == NONE {
        return None;
    }
    let mut positions = vec![0; rows];
    let mut column = end;
    for i in (0..rows).rev() {
        positions[i] = column;
        column = came_from[i][column];
    }
    let prefix = if positions[0] == 0 && positions.iter().enumerate().all(|(i, p)| *p == i) { PREFIX_BONUS } else { 0 };
    Some(FuzzyMatch { score: score + prefix, positions })
}

/// What matching one query character at `text[index]` is worth by itself.
fn character_score(query_character: char, text: &[char], index: usize) -> i64 {
    let mut score = MATCH_SCORE;
    if query_character == text[index] {
        score += SAME_CASE_BONUS;
    }
    if index == 0 {
        score += FIRST_CHARACTER_BONUS;
    } else if starts_word(text, index) {
        score += WORD_START_BONUS;
    }
    score
}

/// Whether the character at `index` begins a word inside the text.
fn starts_word(text: &[char], index: usize) -> bool {
    let (before, here) = (text[index - 1], text[index]);
    if matches!(before, '_' | '-' | ' ' | '.' | ':' | '/') {
        return true;
    }
    before.is_lowercase() && here.is_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(label: &str) -> Item {
        parse_item(&json!({ "label": label }), &Value::Null).unwrap()
    }

    fn labels(items: &[Item], query: &str) -> Vec<String> {
        filter(items, query).iter().map(|found| items[found.index].label.clone()).collect()
    }

    #[test]
    fn a_query_needs_its_characters_in_order_and_ignores_case() {
        let items = [item("console"), item("constructor"), item("log")];
        assert_eq!(labels(&items, "cns"), vec!["console", "constructor"]);
        assert_eq!(labels(&items, "LOG"), vec!["log"]);
        assert!(labels(&items, "xyz").is_empty());
    }

    #[test]
    fn prefixes_beat_scattered_matches_and_word_starts_beat_the_middle() {
        let items = [item("a_long_name"), item("name"), item("rename"), item("nameless")];
        assert_eq!(labels(&items, "name"), vec!["name", "nameless", "a_long_name", "rename"]);
        let camel = [item("fooBarBaz"), item("fabulousbar"), item("foobar")];
        assert_eq!(labels(&camel, "fbb")[0], "fooBarBaz");
        assert_eq!(labels(&camel, "fb")[0], "fooBarBaz");
    }

    #[test]
    fn the_same_case_wins_a_tie() {
        let items = [item("Map"), item("map")];
        assert_eq!(labels(&items, "map"), vec!["map", "Map"]);
    }

    #[test]
    fn nothing_typed_keeps_the_servers_order() {
        let mut first = item("zeta");
        first.sort_text = "0001".into();
        let mut second = item("alpha");
        second.sort_text = "0002".into();
        assert_eq!(labels(&[second.clone(), first.clone()], ""), vec!["zeta", "alpha"]);
    }

    #[test]
    fn preselected_items_rise_and_deprecated_ones_sink() {
        let mut preferred = item("abcd");
        preferred.preselect = true;
        let mut old = item("abc");
        old.deprecated = true;
        let items = [old, item("abcde"), preferred];
        assert_eq!(labels(&items, "abc"), vec!["abcd", "abcde", "abc"]);
    }

    #[test]
    fn the_matched_characters_are_reported_for_highlighting() {
        let items = [item("fooBarBaz")];
        assert_eq!(filter(&items, "fbb")[0].label_positions, vec![0, 3, 6]);
        assert_eq!(filter(&items, "")[0].label_positions, Vec::<usize>::new());
    }

    #[test]
    fn filter_text_decides_what_matches_and_the_label_what_is_highlighted() {
        let found = parse_item(&json!({ "label": "console.log", "filterText": "log" }), &Value::Null).unwrap();
        assert_eq!(filter(&[found.clone()], "log").len(), 1);
        assert_eq!(filter(&[found], "log")[0].label_positions, vec![8, 9, 10]);
    }

    #[test]
    fn items_are_read_with_their_details_edits_and_snippet_format() {
        let list = parse_items(&json!({
            "isIncomplete": true,
            "items": [{
                "label": "println!", "kind": 15, "insertTextFormat": 2,
                "labelDetails": { "detail": "(…)", "description": "macro" },
                "insertText": "println!(\"$0\")",
                "documentation": { "kind": "markdown", "value": "Prints." },
                "additionalTextEdits": [{ "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 0 } }, "newText": "use x;\n" }],
                "textEdit": { "range": { "start": { "line": 3, "character": 4 }, "end": { "line": 3, "character": 6 } }, "newText": "println!(\"$0\")" },
            }],
        }));
        assert!(list.is_incomplete);
        let found = &list.items[0];
        assert_eq!(found.kind, ItemKind::Snippet);
        assert_eq!(found.detail.as_deref(), Some("(…) macro"));
        assert!(found.is_snippet);
        assert_eq!(found.documentation.as_deref(), Some("Prints."));
        assert_eq!(found.edit.as_ref().unwrap().range.start.character, 4);
        assert_eq!(found.additional_edits.len(), 1);
    }

    #[test]
    fn resolving_adds_documentation_and_edits_without_losing_the_rest() {
        let mut found = parse_item(&json!({ "label": "foo", "detail": "fn foo()" }), &Value::Null).unwrap();
        let resolved = json!({
            "label": "foo", "documentation": "Does foo.",
            "additionalTextEdits": [{ "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 0 } }, "newText": "use a;\n" }],
        });
        found.merge_resolved(&resolved);
        assert_eq!(found.documentation.as_deref(), Some("Does foo."));
        assert_eq!(found.detail.as_deref(), Some("fn foo()"));
        assert_eq!(found.additional_edits.len(), 1);
        assert_eq!(found.raw, resolved);
    }

    #[test]
    fn resolving_can_turn_a_function_into_a_snippet_with_its_parameters() {
        let mut found = parse_item(
            &json!({ "label": "greet", "kind": 3, "insertTextFormat": 1, "textEdit": { "newText": "greet", "range": { "start": { "line": 2, "character": 0 }, "end": { "line": 2, "character": 3 } } } }),
            &Value::Null,
        )
        .unwrap();
        assert!(!found.is_snippet);
        let resolved = json!({
            "label": "greet", "kind": 3, "insertTextFormat": 2, "insertText": "greet(${1:name})$0",
            "textEdit": { "newText": "greet(${1:name})$0", "range": { "start": { "line": 2, "character": 0 }, "end": { "line": 2, "character": 3 } } },
        });
        found.merge_resolved(&resolved);
        assert!(found.is_snippet);
        assert_eq!(found.insert_text, "greet(${1:name})$0");
        assert_eq!(found.edit.as_ref().unwrap().new_text, "greet(${1:name})$0");
    }

    #[test]
    fn a_resolved_item_that_says_nothing_of_its_text_keeps_it() {
        let mut found = parse_item(&json!({ "label": "x", "insertText": "x($0)", "insertTextFormat": 2 }), &Value::Null).unwrap();
        found.merge_resolved(&json!({ "label": "x", "documentation": "Docs." }));
        assert!(found.is_snippet);
        assert_eq!(found.insert_text, "x($0)");
    }

    #[test]
    fn a_plain_array_and_list_defaults_are_understood() {
        assert_eq!(parse_items(&json!([{ "label": "a" }, { "nolabel": 1 }])).items.len(), 1);
        assert!(parse_items(&Value::Null).items.is_empty());
        let list = parse_items(&json!({
            "items": [{ "label": "a", "textEditText": "a()" }],
            "itemDefaults": { "insertTextFormat": 2, "editRange": { "insert": { "start": { "line": 1, "character": 1 }, "end": { "line": 1, "character": 2 } }, "replace": { "start": { "line": 1, "character": 1 }, "end": { "line": 1, "character": 9 } } } },
        }));
        let found = &list.items[0];
        assert!(found.is_snippet);
        assert_eq!(found.edit.as_ref().unwrap().range.end.character, 2);
        assert_eq!(found.edit.as_ref().unwrap().new_text, "a()");
    }

    #[test]
    fn insert_replace_edits_use_the_insert_range() {
        let found = parse_item(
            &json!({ "label": "a", "textEdit": { "newText": "a", "insert": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } }, "replace": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 5 } } } } ),
            &Value::Null,
        )
        .unwrap();
        assert_eq!(found.edit.unwrap().range.end.character, 1);
    }

    #[test]
    fn kinds_have_glyphs_and_unknown_numbers_are_text() {
        assert_eq!(ItemKind::from_number(Some(3)), ItemKind::Function);
        assert_eq!(ItemKind::from_number(Some(99)), ItemKind::Text);
        assert_eq!(ItemKind::Function.family(), KindFamily::Callable);
        assert_eq!(ItemKind::Struct.glyph(), "S");
    }
}
