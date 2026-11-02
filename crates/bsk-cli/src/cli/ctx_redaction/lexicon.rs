/// ASCII terms matched at a word start, optionally followed by a plural `s`.
const SECRET_WORDS: &[&str] = &[
    "password",
    "passwd",
    "passcode",
    "passkey",
    "pass key",
    "passphrase",
    "pin",
    "code",
    "otp",
    "totp",
    "one-time",
    "one time",
    "2fa",
    "mfa",
    "two-factor",
    "verification",
    "security code",
    "recovery",
    "backup code",
    "secret",
    "token",
    "api key",
    "apikey",
    "private key",
    "credential",
    "cvv",
    "cvc",
    "card number",
    "ssn",
    "pwd",
    "seed",
    "security answer",
    "secret key",
    "recovery key",
    "license key",
    "access key",
];

/// Non-ASCII terms matched as substrings (these languages join words).
const SECRET_SUBSTRINGS: &[&str] = &[
    "비밀번호",
    "암호",
    "일회용",
    "인증",
    "복구",
    "보안",
    "코드",
    "시크릿",
    "토큰",
    "パスワード",
    "ワンタイム",
    "認証",
    "密码",
    "验证码",
    "口令",
    "恢复",
    "密钥",
    "패스워드",
    "비번",
    "주민등록번호",
    "계좌번호",
    "카드번호",
    "认证",
    "令牌",
    "安全码",
    "暗証番号",
    "api 키",
    "api키",
    "비밀 키",
    "비밀키",
    "액세스 키",
    "개인 키",
    "개인키",
];

/// `_` and `-` count as spaces on both sides, so `api_key`, `access-key` and
/// `one time` match the same terms as `api key` and `one-time`.
pub(super) fn names_secret(text: &str) -> bool {
    let lower = text.to_lowercase();
    let spaced = lower.replace(['_', '-'], " ");
    SECRET_SUBSTRINGS
        .iter()
        .any(|term| lower.contains(term) || spaced.contains(term))
        || SECRET_WORDS
            .iter()
            .any(|term| has_word(&spaced, &term.replace(['_', '-'], " ")))
}

fn has_word(text: &str, term: &str) -> bool {
    let bytes = text.as_bytes();
    text.match_indices(term).any(|(at, _)| {
        let before_ok = at == 0 || !bytes[at - 1].is_ascii_alphanumeric();
        let rest = &bytes[at + term.len()..];
        let after_ok = match rest {
            [] => true,
            [b's', tail @ ..] => tail.first().is_none_or(|b| !b.is_ascii_alphanumeric()),
            [b, ..] => !b.is_ascii_alphanumeric(),
        };
        before_ok && after_ok
    })
}
