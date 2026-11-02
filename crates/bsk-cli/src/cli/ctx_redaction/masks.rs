use std::borrow::Cow;

const MASK: &str = "<redacted>";

/// R3: mask value-shaped substrings inside a suffix.
pub(super) fn mask(suffix: &str) -> Cow<'_, str> {
    let chars: Vec<char> = suffix.chars().collect();
    let mut hidden = vec![false; chars.len()];
    mark_digit_groups(&chars, &mut hidden);
    mark_emails(&chars, &mut hidden);
    mark_long_tokens(&chars, &mut hidden);
    mark_grouped_codes(&chars, &mut hidden);
    if !hidden.iter().any(|h| *h) {
        return Cow::Borrowed(suffix);
    }
    let mut out = String::with_capacity(suffix.len());
    let mut index = 0;
    while index < chars.len() {
        if hidden[index] {
            out.push_str(MASK);
            while index < chars.len() && hidden[index] {
                index += 1;
            }
        } else {
            out.push(chars[index]);
            index += 1;
        }
    }
    Cow::Owned(out)
}

/// Separators seen between the digit groups of displayed codes: spaces of any
/// width, bullets and middle dots, dashes and minus signs, and invisible
/// joiners. Dots, commas, colons and slashes are left out so ordinary dates,
/// prices and versions stay readable.
fn is_digit_separator(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '•' | '·'
                | '∙'
                | '⋅'
                | '‧'
                | '・'
                | '●'
                | '◦'
                | '･'
                | '-'
                | '‐'
                | '‑'
                | '‒'
                | '–'
                | '—'
                | '−'
                | '－'
                | '_'
                | '\u{200B}'
                | '\u{200C}'
                | '\u{200D}'
                | '\u{2060}'
                | '\u{00AD}'
                | '\u{FEFF}'
        )
}

fn is_digit(ch: char) -> bool {
    ch.is_ascii_digit() || ('０'..='９').contains(&ch)
}

/// Six or more digits joined by any run of separators.
fn mark_digit_groups(chars: &[char], hidden: &mut [bool]) {
    let mut index = 0;
    while index < chars.len() {
        if !is_digit(chars[index]) {
            index += 1;
            continue;
        }
        let start = index;
        let mut last_digit = index;
        let mut digits = 0;
        let mut cursor = index;
        while cursor < chars.len() {
            let ch = chars[cursor];
            if is_digit(ch) {
                digits += 1;
                last_digit = cursor;
            } else if !is_digit_separator(ch) {
                break;
            }
            cursor += 1;
        }
        if digits >= 6 {
            hidden[start..=last_digit]
                .iter_mut()
                .for_each(|h| *h = true);
        }
        index = last_digit + 1;
    }
}

fn is_email_char(ch: char) -> bool {
    !ch.is_whitespace()
        && !matches!(
            ch,
            '@' | '<' | '>' | '(' | ')' | '[' | ']' | '"' | '\'' | ',' | ';'
        )
}

fn mark_emails(chars: &[char], hidden: &mut [bool]) {
    for (at, ch) in chars.iter().enumerate() {
        if *ch != '@' {
            continue;
        }
        let mut start = at;
        while start > 0 && is_email_char(chars[start - 1]) {
            start -= 1;
        }
        let mut end = at + 1;
        while end < chars.len() && is_email_char(chars[end]) {
            end += 1;
        }
        let domain: String = chars[at + 1..end].iter().collect();
        let domain = domain.trim_end_matches('.');
        let has_tld = domain.rsplit_once('.').is_some_and(|(name, tld)| {
            !name.is_empty() && tld.len() >= 2 && tld.chars().all(char::is_alphabetic)
        });
        if start < at && has_tld {
            hidden[start..end].iter_mut().for_each(|h| *h = true);
        }
    }
}

fn is_token_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=' | '_' | '-')
}

/// Twenty or more token characters that mix letters and digits.
fn mark_long_tokens(chars: &[char], hidden: &mut [bool]) {
    let mut index = 0;
    while index < chars.len() {
        if !is_token_char(chars[index]) {
            index += 1;
            continue;
        }
        let start = index;
        while index < chars.len() && is_token_char(chars[index]) {
            index += 1;
        }
        let run = &chars[start..index];
        if run.len() >= 20
            && run.iter().any(char::is_ascii_digit)
            && run.iter().any(char::is_ascii_alphabetic)
        {
            hidden[start..index].iter_mut().for_each(|h| *h = true);
        }
    }
}

fn group_kind(group: &[char]) -> Option<GroupKind> {
    if !(4..=8).contains(&group.len()) || !group.iter().all(char::is_ascii_alphanumeric) {
        return None;
    }
    let single_case = group.iter().all(|c| !c.is_ascii_lowercase())
        || group.iter().all(|c| !c.is_ascii_uppercase());
    let has_digit = group.iter().any(char::is_ascii_digit);
    let has_letter = group.iter().any(char::is_ascii_alphabetic);
    let base32 = group
        .iter()
        .all(|c| c.is_ascii_alphabetic() || ('2'..='7').contains(c));
    let hex = group.iter().all(char::is_ascii_hexdigit);
    if has_digit && has_letter {
        Some(GroupKind::Mixed)
    } else if single_case && (base32 || hex) {
        Some(GroupKind::Encoded)
    } else {
        None
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum GroupKind {
    Encoded,
    Mixed,
}

/// Grouped secrets separated by single spaces or dashes: four or more
/// base32/hex groups of which at least two hold a digit (`JBSW Y3DP EHPK 3PXP`,
/// either case), or two or more letter+digit groups (`q7k2-m9x4`).
fn mark_grouped_codes(chars: &[char], hidden: &mut [bool]) {
    let mut index = 0;
    while index < chars.len() {
        if !chars[index].is_ascii_alphanumeric()
            || (index > 0 && chars[index - 1].is_ascii_alphanumeric())
        {
            index += 1;
            continue;
        }
        let start = index;
        let mut groups: Vec<GroupKind> = Vec::new();
        let mut end = index;
        let mut cursor = index;
        loop {
            let group_start = cursor;
            while cursor < chars.len() && chars[cursor].is_ascii_alphanumeric() {
                cursor += 1;
            }
            let Some(kind) = group_kind(&chars[group_start..cursor]) else {
                break;
            };
            groups.push(kind);
            end = cursor;
            let separated = cursor + 1 < chars.len()
                && matches!(chars[cursor], ' ' | '-')
                && chars[cursor + 1].is_ascii_alphanumeric();
            if !separated {
                break;
            }
            cursor += 1;
        }
        let run = &chars[start..end];
        let mixed_groups = groups.iter().filter(|k| **k == GroupKind::Mixed).count();
        let digit_groups = run
            .split(|c| matches!(c, ' ' | '-'))
            .filter(|group| group.iter().any(char::is_ascii_digit))
            .count();
        let encoded = groups.len() >= 4 && digit_groups >= 2;
        let mixed = groups.len() >= 2 && mixed_groups == groups.len();
        if encoded || mixed {
            hidden[start..end].iter_mut().for_each(|h| *h = true);
            index = end;
        } else {
            index += 1;
        }
    }
}
