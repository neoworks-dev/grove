//! JSON-RPC messages as language servers frame them: a `Content-Length` header, a blank line,
//! and that many bytes of JSON.

use std::io::{self, BufRead, Write};

use serde_json::Value;

/// Writes one message with its header.
pub fn write_message(writer: &mut impl Write, message: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(message).map_err(io::Error::other)?;
    write_frame(writer, &body)
}

/// Writes a body that is already JSON, with its header.
pub fn write_frame(writer: &mut impl Write, body: &[u8]) -> io::Result<()> {
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(body)?;
    writer.flush()
}

/// Reads the next message, or none when the stream ended between messages. Headers other than
/// `Content-Length` are ignored. A stream that ends inside a message is an error.
pub fn read_message(reader: &mut impl BufRead) -> io::Result<Option<Value>> {
    let Some(length) = read_content_length(reader)? else {
        return Ok(None);
    };
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let message = serde_json::from_slice(&body).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(Some(message))
}

/// Reads the header lines up to the blank one and returns the body length they announce.
fn read_content_length(reader: &mut impl BufRead) -> io::Result<Option<usize>> {
    let mut length: Option<usize> = None;
    let mut read_any = false;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            if read_any {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the stream ended inside a header"));
            }
            return Ok(None);
        }
        read_any = true;
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            length = value.trim().parse().ok();
        }
    }
    match length {
        Some(length) => Ok(Some(length)),
        None => Err(io::Error::new(io::ErrorKind::InvalidData, "a message without a Content-Length")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    #[test]
    fn a_written_message_reads_back() {
        let mut bytes = Vec::new();
        write_message(&mut bytes, &json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(text.starts_with("Content-Length: "));
        let message = read_message(&mut Cursor::new(bytes)).unwrap().unwrap();
        assert_eq!(message["method"], "ping");
    }

    #[test]
    fn the_length_counts_bytes_not_characters() {
        let mut bytes = Vec::new();
        write_message(&mut bytes, &json!({ "text": "größe 😀" })).unwrap();
        let mut reader = Cursor::new(bytes);
        assert_eq!(read_message(&mut reader).unwrap().unwrap()["text"], "größe 😀");
        assert!(read_message(&mut reader).unwrap().is_none());
    }

    #[test]
    fn messages_follow_each_other_and_other_headers_are_ignored() {
        let mut bytes =
            b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: 2\r\n\r\n{}".to_vec();
        write_message(&mut bytes, &json!([1])).unwrap();
        let mut reader = Cursor::new(bytes);
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), json!({}));
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), json!([1]));
        assert!(read_message(&mut reader).unwrap().is_none());
    }

    #[test]
    fn broken_streams_are_errors() {
        assert!(read_message(&mut Cursor::new(b"Content-Length: 10\r\n\r\n{}".to_vec())).is_err());
        assert!(read_message(&mut Cursor::new(b"Content-Length: 10\r\n".to_vec())).is_err());
        assert!(read_message(&mut Cursor::new(b"X: 1\r\n\r\n".to_vec())).is_err());
        assert!(read_message(&mut Cursor::new(b"Content-Length: 3\r\n\r\nabc".to_vec())).is_err());
    }
}
