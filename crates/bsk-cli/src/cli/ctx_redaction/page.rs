use std::path::Path;
use std::time::Duration;

use bsk_protocol::Method;
use bsk_protocol::tools::{TabListParams, TabListResult, TabScope};
use serde_json::Value;

use super::Origin;
use crate::ipc_client::IpcClient;

const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);

/// A call whose reply is a new render of the tab as it is now: a snapshot, or
/// an observe that does not continue an earlier capture through a cursor.
pub fn fresh_render(method: &Method, params: Option<&Value>) -> bool {
    let continues = params
        .and_then(|p| p.get("cursor"))
        .is_some_and(|cursor| !cursor.is_null());
    matches!(*method, Method::ToolSnapshot | Method::ToolObserve) && !continues
}

/// Origin of the tab a call targets: the explicit `tab_id` (reply first, then
/// params), else the session's single active agent tab. Every failure is
/// `Unknown`.
pub async fn page_origin(sock: &Path, params: Option<&Value>, reply: Option<&Value>) -> Origin {
    let tab_id = reply
        .and_then(|r| r.get("tab_id"))
        .or_else(|| params.and_then(|p| p.get("tab_id")))
        .and_then(Value::as_i64);
    let Some(session_id) = params
        .and_then(|p| p.get("session_id"))
        .and_then(Value::as_str)
    else {
        return Origin::Unknown;
    };
    let Ok(Ok(Ok(list))) = tokio::time::timeout(LOOKUP_TIMEOUT, list_tabs(sock, session_id)).await
    else {
        return Origin::Unknown;
    };
    let mut candidates = list.tabs.iter().filter(|tab| match tab_id {
        Some(id) => tab.tab_id == id,
        None => tab.scope == Some(TabScope::Agent) && tab.active == Some(true),
    });
    match (candidates.next(), candidates.next()) {
        (Some(tab), None) => super::classify_url(tab.url.as_deref()),
        _ => Origin::Unknown,
    }
}

async fn list_tabs(
    sock: &Path,
    session_id: &str,
) -> anyhow::Result<Result<TabListResult, bsk_protocol::RpcError>> {
    let mut client = IpcClient::connect(sock).await?;
    let params = TabListParams {
        scope: TabScope::All,
        session_id: session_id.to_owned(),
    };
    client
        .call(
            "ctx-origin",
            Method::ToolTabList,
            Some(params),
            LOOKUP_TIMEOUT,
        )
        .await
}
