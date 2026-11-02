use super::*;

const NORMAL: &str = include_str!("../../../tests/fixtures/ctx/normal.txt");

fn suffixes(text: &str) -> Vec<&str> {
    text.lines()
        .filter_map(|l| l.find(OPEN).map(|at| &l[at..]))
        .collect()
}

#[test]
fn origins_are_classified_fail_closed() {
    for url in [
        "https://my.1password.com/app#/everything",
        "https://start.1password.com/signin",
        "https://example.1password.eu/vaults",
        "https://1password.ca/",
        "https://c.1passwordusercontent.com/x",
        "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/popup.html",
        "HTTPS://MY.1PASSWORD.COM./",
        "blob:https://my.1password.com/0b1c",
        "https://vault.bitwarden.com/#/vault",
        "https://passwords.google.com/",
        "https://pass.proton.me/u/0",
    ] {
        assert_eq!(classify_url(Some(url)), Origin::PasswordManager, "{url}");
    }
    for url in [
        "https://github.com/login",
        "https://1password.com.evil.test/",
        "https://not1password.com/",
        "https://mail.proton.me/",
    ] {
        assert_eq!(classify_url(Some(url)), Origin::Other, "{url}");
    }
    for url in [
        None,
        Some(""),
        Some("about:blank"),
        Some("about:srcdoc"),
        Some("data:text/html,x"),
        Some("data:text/html,<a href=https://github.com>"),
        Some("about:blank#https://x.test"),
        Some("javascript:location='https://x'"),
        Some("about://blank"),
        Some("data://text/html,<p>x"),
        Some("javascript://x.test/%0aalert(1)"),
        Some("blob:data://x/"),
        Some("chrome://settings"),
        Some("garbage"),
    ] {
        assert_eq!(classify_url(url), Origin::Unknown, "{url:?}");
    }
}

#[test]
fn only_a_new_render_is_judged_by_its_origin() {
    use bsk_protocol::Method;
    let fresh = serde_json::json!({"session_id": "s"});
    let page_two = serde_json::json!({"session_id": "s", "cursor": "c2"});
    assert!(fresh_render(&Method::ToolSnapshot, Some(&fresh)));
    assert!(fresh_render(&Method::ToolObserve, Some(&fresh)));
    assert!(!fresh_render(&Method::ToolObserve, Some(&page_two)));
    assert!(!fresh_render(&Method::ToolCooperate, Some(&fresh)));
}

#[test]
fn saved_observation_files_are_scrubbed_on_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("saved.json");
    let saved = serde_json::json!({"context_id": "c1", "observation": {"text": NORMAL}});
    std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
    let read = crate::cli::observation_view::read(&path).unwrap();
    let text = read["observation"]["text"].as_str().unwrap();
    assert!(!suffixes(text).is_empty());
    assert!(
        suffixes(text).iter().all(|s| *s == REDACTED_SUFFIX),
        "{text}"
    );
}
