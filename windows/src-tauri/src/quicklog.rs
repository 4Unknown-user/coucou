// TradeVault quick-log: the island's "Log trade" goes to the user's own
// TradeVault (POST /api/coucou/trades) with the token already stored for the
// pill — never to Supabase directly, and never with a database key.
//
// The page sends the trade and a submission id (a UUID it keeps until
// the trade is logged). TradeVault inserts once per ref, so the island may
// retry a timeout safely. This side never retries a write on its own: every
// failure goes back to the page as a kind it can explain (src/core/quicklog.ts).

use serde::Serialize;
use serde_json::{json, Value};

use crate::integrations::{client, tradevault_target};

#[derive(Serialize, Debug, PartialEq)]
pub struct QuickLogError {
    /// "setup", "timeout", "offline", "auth", "readonly", "forbidden",
    /// "rejected", "conflict" or "server".
    pub kind: &'static str,
    /// TradeVault's own words, when it gave any (always for "rejected").
    pub message: Option<String>,
}

fn err(kind: &'static str, message: Option<String>) -> QuickLogError {
    QuickLogError { kind, message }
}

/// An HTTP failure, as a kind the island can explain and knows whether to retry.
pub fn classify(status: u16, server_message: Option<String>) -> QuickLogError {
    match status {
        400 | 422 => err("rejected", server_message),
        401 => err("auth", server_message),
        403 if server_message.as_deref().is_some_and(|m| m.contains("read-only")) => err("readonly", server_message),
        403 => err("forbidden", server_message),
        409 => err("conflict", server_message),
        _ => err("server", server_message),
    }
}

/// A transport failure: the request may or may not have reached TradeVault.
fn transport(e: &reqwest::Error) -> QuickLogError {
    // Never the error text itself: it can carry the address.
    if e.is_timeout() { err("timeout", None) } else { err("offline", None) }
}

async fn call(method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, QuickLogError> {
    let (base, token) = match tradevault_target() {
        None => return Err(err("setup", None)),
        Some(Err(why)) => return Err(err("setup", Some(why))),
        Some(Ok(target)) => target,
    };
    let mut request = client()
        .request(method, crate::net::join(&base, path))
        .bearer_auth(token)
        .header("Accept", "application/json");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|e| transport(&e))?;
    let status = response.status().as_u16();
    // A cut-off answer to a successful write still means it was written; the
    // island retries with the same ref and gets the trade back as a duplicate.
    let json: Value = response.json().await.map_err(|e| transport(&e))?;
    if (200..300).contains(&status) {
        Ok(json)
    } else {
        let message = json.get("error").and_then(Value::as_str).map(|s| s.chars().take(300).collect());
        crate::log::line(format!("quicklog HTTP {status}"));
        Err(classify(status, message))
    }
}

/// The accounts a trade can go to, and whether the token may log trades.
#[tauri::command]
pub async fn tradevault_accounts() -> Result<Value, QuickLogError> {
    call(reqwest::Method::GET, "api/coucou/accounts", None).await
}

/// One trade, once: `submission` is the island's id for it (TradeVault's `ref`).
#[tauri::command]
pub async fn tradevault_log_trade(submission: String, trade: Value) -> Result<Value, QuickLogError> {
    // TradeVault checks the same; this keeps junk off the network.
    if !uuid_shaped(&submission) || !trade.is_object() {
        return Err(err("rejected", Some("Invalid request".into())));
    }
    call(reqwest::Method::POST, "api/coucou/trades", Some(json!({ "ref": submission, "trade": trade }))).await
}

fn uuid_shaped(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_status_becomes_a_kind_the_island_can_explain() {
        assert_eq!(classify(400, Some("Symbol is required".into())), err("rejected", Some("Symbol is required".into())));
        assert_eq!(classify(401, None).kind, "auth");
        assert_eq!(classify(403, Some("This token is read-only — create one".into())).kind, "readonly");
        assert_eq!(classify(403, Some("Invalid account or permission denied".into())).kind, "forbidden");
        assert_eq!(classify(409, None).kind, "conflict");
        assert_eq!(classify(500, None).kind, "server");
        assert_eq!(classify(503, None).kind, "server");
        assert_eq!(classify(404, None).kind, "server", "an old TradeVault without the route");
    }

    #[test]
    fn only_a_uuid_is_a_submission_id() {
        assert!(uuid_shaped("3f2504e0-4f89-41d3-9a0c-0305e82c3301"));
        assert!(!uuid_shaped("3f2504e0-4f89-41d3-9a0c-0305e82c330"));
        assert!(!uuid_shaped("3f2504e0x4f89-41d3-9a0c-0305e82c3301"));
        assert!(!uuid_shaped("zf2504e0-4f89-41d3-9a0c-0305e82c3301"));
    }
}
