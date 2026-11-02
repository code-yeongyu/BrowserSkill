//! The `[ctx: ...]` suffix is redacted on the real CLI path: a fake daemon
//! answers with renderer-generated fixtures and the tab list a browser would give.
#![cfg(unix)]

use bsk::daemon::info::DaemonInfo;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    process::Command,
};

const VAULT: &str = include_str!("fixtures/ctx/vault.txt");
const NORMAL: &str = include_str!("fixtures/ctx/normal.txt");
const SITE: &str = include_str!("fixtures/ctx/site.txt");

const VAULT_URL: &str = "https://my.1password.com/app#/everything/item";
const SITE_URL: &str = "https://example.test/settings";

#[derive(Clone, Copy)]
enum Tabs {
    Urls(&'static str, &'static str),
    Fails,
    FailsAfter(&'static str),
}

struct Run {
    stdout: String,
    stderr: String,
    success: bool,
    methods: Vec<String>,
}

async fn run(command: &[&str], page: &'static str, tabs: Tabs) -> Run {
    let out = run_with(command, page, tabs, false, 42).await;
    assert!(out.success, "{}", out.stderr);
    out
}

async fn run_with(
    command: &[&str],
    page: &'static str,
    tabs: Tabs,
    page_fails: bool,
    reply_tab: i64,
) -> Run {
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let sock = home.path().join("ipc.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let info = DaemonInfo::now(std::process::id(), sock.clone(), 0, "0.4.0");
    std::fs::write(
        home.path().join("daemon.json"),
        serde_json::to_vec(&info).unwrap(),
    )
    .unwrap();
    let methods = Arc::new(Mutex::new(Vec::new()));
    let seen = methods.clone();
    let server = tokio::spawn(async move {
        let mut lists = 0;
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut reader = BufReader::new(read);
            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap() > 0 {
                let request: Value = serde_json::from_str(&line).unwrap();
                line.clear();
                let method = request["method"].as_str().unwrap().to_owned();
                seen.lock().unwrap().push(method.clone());
                let reply = match (method.as_str(), tabs) {
                    ("system.status", _) => {
                        json!({"result": {"daemon_version":"0.4.0","protocol_version":"1.7",
                        "pid":std::process::id(),"uptime_secs":0,"ws_port":0,"sock_path":sock,
                        "browsers":[],"sessions":[]}})
                    }
                    ("tool.tab_list", Tabs::Fails) => {
                        json!({"error": {"code":"not_found","message":"no such session"}})
                    }
                    ("tool.tab_list", Tabs::FailsAfter(first)) => {
                        lists += 1;
                        if lists == 1 {
                            json!({"result": {"tabs": [{"tab_id": 42, "url": first, "active": true, "scope": "agent"}]}})
                        } else {
                            json!({"error": {"code":"not_found","message":"no such session"}})
                        }
                    }
                    ("tool.snapshot", _) if page_fails => {
                        let line = page.lines().nth(6).unwrap_or_default();
                        json!({"error": {"code":"cdp_failed",
                            "message": format!("render failed near {line}"),
                            "data": {"partial": line}}})
                    }
                    ("tool.tab_list", Tabs::Urls(first, later)) => {
                        lists += 1;
                        let url = if lists == 1 { first } else { later };
                        json!({"result": {"tabs": [
                            {"tab_id": 42, "url": url, "active": true, "scope": "agent"},
                            {"tab_id": 7, "url": VAULT_URL, "active": true, "scope": "user"}
                        ]}})
                    }
                    ("tool.snapshot", _) => {
                        json!({"result": {"text": page, "ref_count": 9, "tab_id": reply_tab, "truncated": false}})
                    }
                    ("tool.observe", _) => {
                        json!({"result": {"text": page, "ref_count": 9, "tab_id": reply_tab, "truncated": false}})
                    }
                    _ => panic!("unexpected method: {method}"),
                };
                let mut frame = reply;
                frame["id"] = request["id"].clone();
                let mut bytes = serde_json::to_vec(&frame).unwrap();
                bytes.push(b'\n');
                write.write_all(&bytes).await.unwrap();
            }
        }
    });
    let out = tokio::time::timeout(
        Duration::from_secs(60),
        Command::new(env!("CARGO_BIN_EXE_bsk"))
            .env("BSK_HOME", home.path())
            .env("BSK_AUTO_START", "0")
            .env("BSK_AUTO_UPDATE", "off")
            .env_remove("BSK_CANCEL_ON_STDIN_CLOSE")
            .kill_on_drop(true)
            .args(command)
            .args(["--session", "fixture"])
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    server.abort();
    let _ = server.await;
    let methods = methods.lock().unwrap().clone();
    Run {
        stdout: String::from_utf8(out.stdout).unwrap(),
        stderr: String::from_utf8(out.stderr).unwrap(),
        success: out.status.success(),
        methods,
    }
}

fn suffixes(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| line.find(" [ctx: ").map(|at| line[at..].to_owned()))
        .filter(|suffix| !suffix.starts_with(" [ctx: decoy]"))
        .collect()
}

fn assert_all_redacted(stdout: &str) {
    let found = suffixes(stdout);
    assert!(found.len() >= 2, "no ctx lines left to check:\n{stdout}");
    assert!(found.iter().all(|s| s == " [ctx: <redacted>]"), "{stdout}");
}

#[tokio::test]
async fn vault_page_suffixes_are_redacted_in_human_and_json_output() {
    for format in [&["snapshot"][..], &["snapshot", "--json"], &["observe"]] {
        let out = run(format, VAULT, Tabs::Urls(VAULT_URL, VAULT_URL)).await;
        let text = if format.contains(&"--json") {
            serde_json::from_str::<Value>(&out.stdout).unwrap()["text"]
                .as_str()
                .unwrap()
                .to_owned()
        } else {
            out.stdout
        };
        assert_all_redacted(&text);
    }
}

#[tokio::test]
async fn a_tab_that_leaves_the_vault_during_the_call_still_redacts() {
    let out = run(&["snapshot"], VAULT, Tabs::Urls(VAULT_URL, SITE_URL)).await;
    assert_all_redacted(&out.stdout);
}

#[tokio::test]
async fn an_unknown_origin_redacts_every_suffix() {
    let out = run(&["snapshot"], NORMAL, Tabs::Fails).await;
    assert_all_redacted(&out.stdout);
}

#[tokio::test]
async fn ordinary_pages_keep_their_suffixes_and_lose_only_secret_shapes() {
    let normal = run(&["snapshot"], NORMAL, Tabs::Urls(SITE_URL, SITE_URL)).await;
    assert_eq!(normal.stdout.trim_end(), NORMAL.trim_end());
    assert_eq!(
        normal
            .methods
            .iter()
            .filter(|m| *m == "tool.tab_list")
            .count(),
        2,
        "{:?}",
        normal.methods
    );
    let site = run(&["snapshot"], SITE, Tabs::Urls(SITE_URL, SITE_URL)).await;
    let joined = suffixes(&site.stdout).join("\n");
    for secret in [
        "271 828",
        "q7k2",
        "314",
        "synthetic.user@example.test",
        "a1b2c3d4e5f6",
        "JBSW",
    ] {
        assert!(!joined.contains(secret), "{secret} leaked:\n{joined}");
    }
    assert!(
        joined.contains("[ctx: Project Alpha Q3 roadmap]"),
        "{joined}"
    );
}

#[tokio::test]
async fn a_continuation_page_cannot_be_tied_to_its_capture_and_is_redacted() {
    let out = run(
        &["observe", "--cursor", "page-two"],
        NORMAL,
        Tabs::Urls(SITE_URL, SITE_URL),
    )
    .await;
    assert_all_redacted(&out.stdout);
    assert!(
        !out.methods.iter().any(|m| m == "tool.tab_list"),
        "{:?}",
        out.methods
    );
}

#[tokio::test]
async fn a_tab_that_enters_the_vault_during_the_call_is_redacted() {
    let out = run(&["snapshot"], VAULT, Tabs::Urls(SITE_URL, VAULT_URL)).await;
    assert_all_redacted(&out.stdout);
}

#[tokio::test]
async fn a_failing_lookup_after_the_call_is_unknown() {
    let out = run(&["snapshot"], NORMAL, Tabs::FailsAfter(SITE_URL)).await;
    assert_all_redacted(&out.stdout);
}

#[tokio::test]
async fn error_messages_and_data_are_scrubbed() {
    for format in [&["snapshot"][..], &["snapshot", "--json"]] {
        let out = run_with(format, VAULT, Tabs::Urls(SITE_URL, SITE_URL), true, 42).await;
        assert!(!out.success);
        let printed = format!("{}{}", out.stdout, out.stderr);
        assert!(printed.contains("<redacted>"), "{printed}");
        for secret in [
            "synthetic.user@example.test",
            "Zq7-synthetic-Pw-41x",
            "314 • 159",
        ] {
            assert!(
                !suffixes(&printed).join("\n").contains(secret),
                "{secret} leaked:\n{printed}"
            );
        }
    }
}

#[tokio::test]
async fn the_tab_that_was_rendered_wins_over_the_tab_that_was_asked_for() {
    let out = run_with(
        &["snapshot", "--tab-id", "42"],
        VAULT,
        Tabs::Urls(SITE_URL, SITE_URL),
        false,
        7,
    )
    .await;
    assert!(out.success, "{}", out.stderr);
    assert_all_redacted(&out.stdout);
}
