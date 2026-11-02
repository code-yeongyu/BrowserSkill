use super::*;

const VAULT: &str = include_str!("../../../tests/fixtures/ctx/vault.txt");
const NORMAL: &str = include_str!("../../../tests/fixtures/ctx/normal.txt");
const SITE: &str = include_str!("../../../tests/fixtures/ctx/site.txt");
const TRICKY: &str = include_str!("../../../tests/fixtures/ctx/tricky.txt");

fn suffixes(text: &str) -> Vec<&str> {
    text.lines()
        .filter_map(|l| l.find(OPEN).map(|at| &l[at..]))
        .collect()
}

#[test]
fn password_manager_origin_redacts_every_suffix() {
    assert!(suffixes(VAULT).len() >= 10, "fixture lost its ctx lines");
    let out = redact_text(VAULT, Origin::PasswordManager);
    for suffix in suffixes(&out) {
        assert_eq!(suffix, REDACTED_SUFFIX);
    }
    assert_eq!(out.lines().count(), VAULT.lines().count());
}

#[test]
fn unknown_origin_redacts_every_suffix() {
    let out = redact_text(NORMAL, Origin::Unknown);
    assert!(!suffixes(&out).is_empty());
    assert!(suffixes(&out).iter().all(|s| *s == REDACTED_SUFFIX));
}

#[test]
fn ordinary_suffixes_stay_byte_identical() {
    assert!(NORMAL.contains("@e1 button \"View\" [ctx: Project Alpha]"));
    assert_eq!(redact_text(NORMAL, Origin::Other), NORMAL);
}

#[test]
fn secret_shapes_on_ordinary_sites_never_survive_in_a_suffix() {
    let out = redact_text(SITE, Origin::Other);
    let joined = suffixes(&out).join("\n");
    for secret in [
        "271 828",
        "q7k2",
        "p3v8",
        "314",
        "159",
        "synthetic.user@example.test",
        "example.test",
        "a1b2c3d4e5f6",
        "JBSW",
        "3PXP",
    ] {
        assert!(!joined.contains(secret), "{secret} leaked in:\n{joined}");
    }
    assert!(
        joined.contains("[ctx: Project Alpha Q3 roadmap]"),
        "{joined}"
    );
    assert!(
        joined.contains("[ctx: Project Beta launch 2026]"),
        "{joined}"
    );
}

#[test]
fn incident_otp_shape_is_masked_without_a_label() {
    for shape in [
        "314 • 159 26",
        "314•159",
        "314\u{00a0}159",
        "314\u{2009}159\u{202f}26",
        "31-41-59",
        "3 1 4 1 5 9",
        "314 · 159",
        "314 – 159",
        "314 ● 159",
        "314\u{200b}159",
        "３１４ １５９",
    ] {
        let line = format!("@e1 button \"Use\" [ctx: Account {shape}]");
        let out = redact_line(&line, Origin::Other);
        assert!(
            !out.contains("314") && !out.contains("31-41") && !out.contains("３１４"),
            "{shape:?} -> {out}"
        );
        assert!(out.contains(REDACTED), "{shape:?} -> {out}");
    }
}

#[test]
fn ordinary_numbers_and_prose_stay_readable() {
    for line in [
        "@e1 button \"View\" [ctx: Sprint 2026.11.02 at 12:30]",
        "@e1 button \"View\" [ctx: plan 2026 team sync]",
        "@e1 button \"View\" [ctx: Price 1,299,000 won]",
        "@e1 button \"Pinned\" [ctx: Coder notes]",
        "@e1 button \"View\" [ctx: Tokenomics overview]",
    ] {
        assert_eq!(redact_line(line, Origin::Other), line);
    }
}

#[test]
fn grouped_codes_are_masked_in_either_case() {
    for code in [
        "JBSW Y3DP EHPK 3PXP",
        "jbsw y3dp ehpk 3pxp",
        "q7k2-m9x4 p3v8-w6z1",
        "a1b2c-3d4e5",
    ] {
        let line = format!("@e1 button \"Copy\" [ctx: Value {code}]");
        let out = redact_line(&line, Origin::Other);
        assert_eq!(
            out,
            format!("@e1 button \"Copy\" [ctx: Value {REDACTED}]"),
            "{code}"
        );
    }
}

#[test]
fn secret_labels_redact_the_suffix_on_any_origin() {
    for label in [
        "One-time password",
        "Verification code",
        "Recovery codes",
        "Backup code",
        "API key",
        "Seed",
        "일회용 비밀번호",
        "복구 코드",
        "패스워드",
        "验证码",
    ] {
        let line = format!("@e1 button \"Copy\" [ctx: {label} xyz]");
        assert_eq!(
            redact_line(&line, Origin::Other),
            format!("@e1 button \"Copy\"{REDACTED_SUFFIX}")
        );
    }
}

#[test]
fn redaction_keeps_the_fixed_markers_after_the_suffix() {
    let own = "@e1 textbox \"Password\" [ctx: Sign in] [disabled] [filled]";
    assert_eq!(
        redact_line(own, Origin::Other),
        format!("@e1 textbox \"Password\"{REDACTED_SUFFIX} [disabled] [filled]")
    );
    let masked = "@e2 textbox \"Field\" [ctx: Area] [filled] =\"•••\"";
    assert_eq!(
        redact_line(masked, Origin::Other),
        format!("@e2 textbox \"Field\"{REDACTED_SUFFIX} [filled] =\"•••\"")
    );
    let free_text = "@e3 link \"Docs\" [ctx: Area] [→ https://example.test/a] [checked]";
    assert_eq!(
        redact_line(free_text, Origin::Unknown),
        format!("@e3 link \"Docs\"{REDACTED_SUFFIX} [checked]")
    );
}

#[test]
fn suffix_runs_to_end_of_line_and_a_match_in_the_name_over_redacts() {
    let out = redact_text(TRICKY, Origin::Other);
    assert!(
        out.lines()
            .filter(|l| l.contains("@e"))
            .all(|l| !l.contains("271828")),
        "{out}"
    );
    assert!(
        out.contains("[ctx: Board ] [disabled] <redacted>]"),
        "{out}"
    );
    let all = redact_text(TRICKY, Origin::PasswordManager);
    assert!(
        all.lines()
            .filter(|l| l.contains("@e"))
            .all(|l| !l.contains("Board")),
        "{all}"
    );
    assert!(
        all.contains(&format!("@e1 button \"Open{REDACTED_SUFFIX}\n")),
        "{all}"
    );
}

#[test]
fn values_are_rewritten_everywhere_in_a_reply() {
    let mut reply = serde_json::json!({
        "text": "@e1 button \"Copy\" [ctx: Account 314 • 159 26]",
        "observation": {"text": "@e2 button \"Copy\" [ctx: Owner a@b.test]"},
        "refs": [{"ref": "e1", "ctx": "Owner c@d.test"}, {"ref": "e2", "ctx": "Project Alpha"}],
        "tab_id": 7,
    });
    assert!(contains_ctx(&reply));
    redact_value(&mut reply, Origin::Other);
    let printed = reply.to_string();
    for secret in ["314", "a@b.test", "c@d.test"] {
        assert!(!printed.contains(secret), "{printed}");
    }
    assert_eq!(reply["refs"][1]["ctx"], "Project Alpha");
    redact_value(&mut reply, Origin::Unknown);
    assert_eq!(reply["refs"][1]["ctx"], REDACTED);
    let mut clean = serde_json::json!({"text": "@e1 button \"Go\""});
    assert!(!contains_ctx(&clean));
    redact_value(&mut clean, Origin::Unknown);
    assert_eq!(clean, serde_json::json!({"text": "@e1 button \"Go\""}));
}
