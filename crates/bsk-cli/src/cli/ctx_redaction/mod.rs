//! Redaction of the `[ctx: ...]` suffix in rendered VOM text, applied to every
//! business-RPC reply before the CLI prints or decodes it.
//!
//! The renderer adds `[ctx: ...]` to refs whose names repeat on the page and
//! fills it with the name or displayed text of neighbouring nodes. On a password
//! manager item every field has its own "Copy" button, so each button's suffix
//! carried that field's displayed value (email, one-time code, recovery code).
//! Value redaction only covers the `="..."` marker, never this suffix.
//!
//! Rules, all fail-closed (see the fork's design notes):
//! - R1: on a 1Password origin, or when the tab's origin is unknown, every
//!   suffix becomes `[ctx: <redacted>]`.
//! - R2: on any origin, a line whose own text or suffix names a secret field
//!   (password, code, OTP, recovery, token, ...) or carries the masked value
//!   marker loses its suffix.
//! - R3: in every remaining suffix, digit groups split by any separators,
//!   emails, long opaque tokens and grouped codes become `<redacted>`.
//!
//! A suffix runs from its opening ` [ctx: ` to the end of the line: labels may
//! contain `]`, so no narrower end is safe.

use std::borrow::Cow;

use std::path::Path;

use serde_json::Value;

mod lexicon;
mod masks;
mod origin;
#[cfg(test)]
mod origin_tests;
mod page;
#[cfg(test)]
mod tests;

use lexicon::names_secret;
use masks::mask;
pub use origin::{Origin, classify_url};
pub use page::{fresh_render, page_origin};

/// Embedded so an installed binary can be identified without changing
/// `bsk --version` (version guards parse that line).
pub const REDACTION_MARKER: &str = "bsk-ctx-redaction-v1";

#[used]
static REDACTION_MARKER_BYTES: [u8; 20] = *b"bsk-ctx-redaction-v1";

const OPEN: &str = " [ctx";
const CTX_KEY: &str = "ctx";
const REDACTED_SUFFIX: &str = " [ctx: <redacted>]";
const REDACTED: &str = "<redacted>";
const SENSITIVE_VALUE: &str = " =\"•••\"";

/// Fixed-form markers the renderer may append after a suffix. They carry no
/// page text, so a redacted line keeps them.
const KEPT_MARKERS: &[&str] = &[
    " [disabled]",
    " [checked]",
    " [unchecked]",
    " [mixed]",
    " [empty]",
    " [filled]",
    " [default]",
    " [selected]",
    " [unselected]",
    " [selected:data]",
    " [unselected:data]",
    " [selected:class]",
    SENSITIVE_VALUE,
];

/// Redact a reply. Only a fresh render (snapshot, or observe without a
/// cursor) is judged by its tab's origin, looked up before and after the call;
/// a continuation page, a cooperate reply or any other result cannot be tied
/// to the page it was captured from, so its suffixes are all redacted.
pub async fn redact_reply(
    sock: &Path,
    fresh: bool,
    params: Option<&Value>,
    before: Option<Origin>,
    mut reply: Value,
) -> Value {
    if !contains_ctx(&reply) {
        return reply;
    }
    let origin = if fresh {
        let after = page_origin(sock, params, Some(&reply)).await;
        stricter(before.unwrap_or(Origin::Unknown), after)
    } else {
        Origin::Unknown
    };
    tracing::debug!(guard = REDACTION_MARKER, ?origin, "redacting ctx suffixes");
    redact_value(&mut reply, origin);
    reply
}

fn stricter(a: Origin, b: Origin) -> Origin {
    let rank = |origin: Origin| match origin {
        Origin::Other => 0,
        Origin::Unknown => 1,
        Origin::PasswordManager => 2,
    };
    if rank(a) >= rank(b) { a } else { b }
}

pub fn contains_ctx(value: &Value) -> bool {
    match value {
        Value::String(s) => s.contains(OPEN),
        Value::Array(items) => items.iter().any(contains_ctx),
        Value::Object(map) => map
            .iter()
            .any(|(key, v)| (key == CTX_KEY && v.is_string()) || contains_ctx(v)),
        _ => false,
    }
}

pub fn redact_value(value: &mut Value, origin: Origin) {
    match value {
        Value::String(s) => {
            if let Cow::Owned(redacted) = redact_text(s, origin) {
                *s = redacted;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| redact_value(v, origin)),
        Value::Object(map) => {
            for (key, v) in map.iter_mut() {
                match v {
                    Value::String(field) if key == CTX_KEY => *field = redact_field(field, origin),
                    _ => redact_value(v, origin),
                }
            }
        }
        _ => {}
    }
}

/// A structured `ctx` field (rendered refs) follows the same rules as a suffix.
fn redact_field(field: &str, origin: Origin) -> String {
    if origin.redacts_all() || names_secret(field) {
        REDACTED.to_owned()
    } else {
        mask(field).into_owned()
    }
}

pub fn redact_text(text: &str, origin: Origin) -> Cow<'_, str> {
    if !text.contains(OPEN) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }
        out.push_str(&redact_line(line, origin));
    }
    Cow::Owned(out)
}

/// The suffix starts at the first ` [ctx` anywhere on the line (a match inside
/// the quoted name only over-redacts) and runs to the end of the line, because
/// labels may contain `]`.
fn redact_line(line: &str, origin: Origin) -> Cow<'_, str> {
    let Some(start) = line.find(OPEN) else {
        return Cow::Borrowed(line);
    };
    let (head, rest) = line.split_at(start);
    let (suffix, kept) = peel_kept_markers(rest);
    if origin.redacts_all()
        || names_secret(head)
        || names_secret(suffix)
        || rest.contains(SENSITIVE_VALUE)
    {
        return Cow::Owned(format!("{head}{REDACTED_SUFFIX}{kept}"));
    }
    match mask(rest) {
        Cow::Borrowed(_) => Cow::Borrowed(line),
        Cow::Owned(masked) => Cow::Owned(format!("{head}{masked}")),
    }
}

fn peel_kept_markers(rest: &str) -> (&str, &str) {
    let mut end = rest.len();
    while let Some(marker) = KEPT_MARKERS.iter().find(|m| rest[..end].ends_with(**m)) {
        end -= marker.len();
    }
    rest.split_at(end)
}
