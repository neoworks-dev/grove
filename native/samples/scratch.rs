// A scratch file to try the editor on. It is copied to the temp directory, so saving
// here never touches Grove's own source.

use std::collections::HashMap;

fn greet(name: &str) {
    println!("hello {}", name);
}

fn count_words(text: &str) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for word in text.split_whitespace() {
        *counts.entry(word.to_string()).or_insert(0) += 1;
    }
    counts
}

fn main() {
    let total = 3;
    let count = 4;
    greet("world");
    let counts = count_words("the quick brown fox jumps over the lazy dog");
    println!("{} {} {}", total, count, counts.len());
}
