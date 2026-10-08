// Watchlist price feeds — Binance and Coinbase (crypto, no key) and Finnhub
// (US stocks, free key) over WebSocket.
//
// One connection per provider that has something to watch, and only while the
// Watchlist pill is on and Coucou isn't paused; switching it off closes them.
// Ticks are folded into price / high / low per symbol and sent to the island
// (event "watchlist") at most every EMIT_EVERY. The island decides alerts
// (src/core/watchlist.ts) from high and low, so a spike between two sends is
// never missed. A new provider is one arm in each of feed_url, subscriptions
// and parse.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio_tungstenite::tungstenite::Message;

use crate::island::WINDOW_LABEL;
use crate::{log, secrets};

pub const PILL: &str = "integration_watchlist";
pub const FINNHUB_KEY: &str = "finnhub-api-key";

/// How often the island hears about prices, and how often the wanted feeds
/// are compared with the running ones. ponytail: a fixed 3 s even while the
/// island is hidden — one small event, no redraw; tie it to visibility if it
/// ever shows up in a profile.
const EMIT_EVERY: Duration = Duration::from_secs(3);
/// A feed silent this long is reconnected (Binance and Finnhub tick far more often).
const SILENCE: Duration = Duration::from_secs(90);
const BACKOFF_MIN: Duration = Duration::from_secs(5);
const BACKOFF_MAX: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Provider {
    Binance,
    Coinbase,
    Finnhub,
}

impl Provider {
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "binance" => Some(Self::Binance),
            "coinbase" => Some(Self::Coinbase),
            "finnhub" => Some(Self::Finnhub),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Binance => "binance",
            Self::Coinbase => "coinbase",
            Self::Finnhub => "finnhub",
        }
    }
}

/// Same rules as validSymbol() in src/core/watchlist.ts. The symbol ends up in
/// a URL (Binance) or a JSON message, so nothing else gets through.
pub fn valid_symbol(provider: Provider, s: &str) -> bool {
    let ok = |c: char| c.is_ascii_uppercase() || c.is_ascii_digit();
    match provider {
        Provider::Binance => (2..=20).contains(&s.len()) && s.chars().all(ok),
        Provider::Coinbase => {
            let mut parts = s.split('-');
            let (a, b) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            parts.next().is_none()
                && (1..=10).contains(&a.len())
                && (1..=10).contains(&b.len())
                && a.chars().chain(b.chars()).all(ok)
        }
        Provider::Finnhub => {
            (1..=20).contains(&s.len()) && s.chars().all(|c| ok(c) || matches!(c, '.' | ':' | '-' | '^'))
        }
    }
}

pub fn feed_url(provider: Provider, symbols: &[String], key: Option<&str>) -> Option<String> {
    match provider {
        Provider::Binance => {
            let streams: Vec<String> = symbols.iter().map(|s| format!("{}@miniTicker", s.to_ascii_lowercase())).collect();
            Some(format!("wss://stream.binance.com:9443/stream?streams={}", streams.join("/")))
        }
        Provider::Coinbase => Some("wss://ws-feed.exchange.coinbase.com".into()),
        Provider::Finnhub => {
            let key = key.filter(|k| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric()))?;
            Some(format!("wss://ws.finnhub.io?token={key}"))
        }
    }
}

/// What to send once connected (Binance subscribes through its URL).
pub fn subscriptions(provider: Provider, symbols: &[String]) -> Vec<String> {
    match provider {
        Provider::Binance => vec![],
        Provider::Coinbase => {
            vec![json!({ "type": "subscribe", "product_ids": symbols, "channels": ["ticker"] }).to_string()]
        }
        Provider::Finnhub => symbols.iter().map(|s| json!({ "type": "subscribe", "symbol": s }).to_string()).collect(),
    }
}

#[derive(Debug, PartialEq)]
pub struct Tick {
    pub symbol: String,
    pub price: f64,
}

fn number(v: &Value) -> Option<f64> {
    let n = match v {
        Value::String(s) => s.parse().ok()?,
        other => other.as_f64()?,
    };
    (n.is_finite() && n > 0.0).then_some(n)
}

/// Prices in one message from the feed; anything else (acks, pings, errors) is none.
pub fn parse(provider: Provider, text: &str) -> Vec<Tick> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return vec![] };
    let tick = |s: &Value, p: &Value| Some(Tick { symbol: s.as_str()?.to_string(), price: number(p)? });
    match provider {
        // {"stream":"btcusdt@miniTicker","data":{"s":"BTCUSDT","c":"62000.10",…}}
        Provider::Binance => tick(&v["data"]["s"], &v["data"]["c"]).into_iter().collect(),
        // {"type":"ticker","product_id":"BTC-USD","price":"62000.10",…}
        Provider::Coinbase if v["type"] == "ticker" => tick(&v["product_id"], &v["price"]).into_iter().collect(),
        // {"type":"trade","data":[{"s":"AAPL","p":191.2,"t":…,"v":…},…]}
        Provider::Finnhub if v["type"] == "trade" => v["data"]
            .as_array()
            .map(|trades| trades.iter().filter_map(|t| tick(&t["s"], &t["p"])).collect())
            .unwrap_or_default(),
        _ => vec![],
    }
}

// ── Folding ticks between two sends ──────────────────────────────────────────

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Quote {
    pub price: f64,
    pub high: f64,
    pub low: f64,
    /// Epoch ms of the last tick.
    pub at: u64,
}

#[derive(Default)]
struct Shared {
    /// "binance:BTCUSDT" → what happened since the last send.
    pending: HashMap<String, Quote>,
    /// Provider id → "live", "connecting", "retrying" or "noKey".
    status: BTreeMap<&'static str, &'static str>,
    status_changed: bool,
}

fn fold(pending: &mut HashMap<String, Quote>, key: String, price: f64, at: u64) {
    pending
        .entry(key)
        .and_modify(|q| {
            q.price = price;
            q.high = q.high.max(price);
            q.low = q.low.min(price);
            q.at = at;
        })
        .or_insert(Quote { price, high: price, low: price, at });
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn set_status(shared: &Mutex<Shared>, provider: Provider, status: &'static str) {
    let mut s = shared.lock().unwrap_or_else(|e| e.into_inner());
    if s.status.insert(provider.id(), status) != Some(status) {
        s.status_changed = true;
    }
}

// ── Connections ──────────────────────────────────────────────────────────────

/// What one provider should be running: its symbols, and Finnhub's key.
type Wanted = BTreeMap<Provider, (Vec<String>, Option<String>)>;

fn wanted(app: &AppHandle) -> Wanted {
    let mut out = Wanted::new();
    if crate::integrations::PAUSED.load(std::sync::atomic::Ordering::Relaxed) {
        return out;
    }
    let Some(shared) = app.try_state::<crate::Shared>() else { return out };
    let settings = shared.settings.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if !settings.active_integrations.iter().any(|x| x == PILL) {
        return out;
    }
    for item in &settings.watchlist {
        let Some(provider) = Provider::from_id(&item.provider) else { continue };
        if !valid_symbol(provider, &item.symbol) {
            continue;
        }
        let entry = out.entry(provider).or_insert_with(|| (vec![], None));
        if !entry.0.contains(&item.symbol) {
            entry.0.push(item.symbol.clone());
        }
    }
    if let Some(entry) = out.get_mut(&Provider::Finnhub) {
        entry.1 = secrets::get(FINNHUB_KEY);
    }
    out
}

async fn session(provider: Provider, url: &str, symbols: &[String], shared: &Mutex<Shared>) -> Result<(), String> {
    // Errors are reported by kind only: Finnhub's URL carries the key.
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.map_err(|_| "connect failed".to_string())?;
    for message in subscriptions(provider, symbols) {
        ws.send(Message::Text(message.into())).await.map_err(|_| "subscribe failed".to_string())?;
    }
    set_status(shared, provider, "live");
    loop {
        let next = tokio::time::timeout(SILENCE, ws.next()).await.map_err(|_| "silent".to_string())?;
        match next {
            None | Some(Ok(Message::Close(_))) => return Ok(()),
            Some(Err(_)) => return Err("read failed".into()),
            Some(Ok(Message::Text(text))) => {
                let ticks = parse(provider, text.as_str());
                if !ticks.is_empty() {
                    let at = now_ms();
                    let mut s = shared.lock().unwrap_or_else(|e| e.into_inner());
                    for t in ticks {
                        fold(&mut s.pending, format!("{}:{}", provider.id(), t.symbol), t.price, at);
                    }
                }
            }
            // Pings are answered by tungstenite itself.
            Some(Ok(_)) => {}
        }
    }
}

async fn run(provider: Provider, symbols: Vec<String>, key: Option<String>, shared: Arc<Mutex<Shared>>) {
    let Some(url) = feed_url(provider, &symbols, key.as_deref()) else {
        set_status(&shared, provider, "noKey");
        return;
    };
    let mut backoff = BACKOFF_MIN;
    loop {
        set_status(&shared, provider, "connecting");
        match session(provider, &url, &symbols, &shared).await {
            Ok(()) => backoff = BACKOFF_MIN,
            Err(why) => log::line(format!("watchlist {}: {why}", provider.id())),
        }
        set_status(&shared, provider, "retrying");
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// Keeps the running feeds in line with the settings and sends what they saw.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let mut running: BTreeMap<Provider, ((Vec<String>, Option<String>), tauri::async_runtime::JoinHandle<()>)> =
            BTreeMap::new();
        let mut ticker = tokio::time::interval(EMIT_EVERY);
        loop {
            ticker.tick().await;

            let want = wanted(&app);
            running.retain(|provider, (config, handle)| {
                let keep = want.get(provider) == Some(&*config);
                if !keep {
                    handle.abort();
                    let mut s = shared.lock().unwrap_or_else(|e| e.into_inner());
                    s.status.remove(provider.id());
                    s.status_changed = true;
                    s.pending.retain(|k, _| !k.starts_with(&format!("{}:", provider.id())));
                }
                keep
            });
            for (provider, config) in want {
                if running.contains_key(&provider) {
                    continue;
                }
                let (symbols, key) = config.clone();
                let handle = tauri::async_runtime::spawn(run(provider, symbols, key, shared.clone()));
                running.insert(provider, (config, handle));
            }

            let (quotes, status) = {
                let mut s = shared.lock().unwrap_or_else(|e| e.into_inner());
                if s.pending.is_empty() && !s.status_changed {
                    continue;
                }
                s.status_changed = false;
                (std::mem::take(&mut s.pending), s.status.clone())
            };
            let _ = app.emit_to(WINDOW_LABEL, "watchlist", json!({ "quotes": quotes, "status": status }));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbols_are_checked_before_they_reach_a_url_or_a_message() {
        assert!(valid_symbol(Provider::Binance, "BTCUSDT"));
        assert!(!valid_symbol(Provider::Binance, "btcusdt"));
        assert!(!valid_symbol(Provider::Binance, "BTC/USDT"));
        assert!(!valid_symbol(Provider::Binance, "BTC&streams=x"));
        assert!(valid_symbol(Provider::Coinbase, "BTC-USD"));
        assert!(!valid_symbol(Provider::Coinbase, "BTCUSD"));
        assert!(!valid_symbol(Provider::Coinbase, "BTC-USD-X"));
        assert!(valid_symbol(Provider::Finnhub, "AAPL"));
        assert!(valid_symbol(Provider::Finnhub, "BINANCE:BTCUSDT"));
        assert!(valid_symbol(Provider::Finnhub, "BRK.B"));
        assert!(!valid_symbol(Provider::Finnhub, "AAPL\"}"));
        assert!(!valid_symbol(Provider::Finnhub, ""));
    }

    #[test]
    fn each_provider_gets_its_own_url_and_subscriptions() {
        let s = vec!["BTCUSDT".to_string(), "ETHUSDT".to_string()];
        assert_eq!(
            feed_url(Provider::Binance, &s, None).unwrap(),
            "wss://stream.binance.com:9443/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker"
        );
        assert!(subscriptions(Provider::Binance, &s).is_empty());

        let c = vec!["BTC-USD".to_string()];
        let sub: Value = serde_json::from_str(&subscriptions(Provider::Coinbase, &c)[0]).unwrap();
        assert_eq!(sub["product_ids"][0], "BTC-USD");
        assert_eq!(sub["channels"][0], "ticker");

        assert_eq!(feed_url(Provider::Finnhub, &s, None), None);
        assert_eq!(feed_url(Provider::Finnhub, &s, Some("abc&x=1")), None);
        assert_eq!(feed_url(Provider::Finnhub, &s, Some("abc123")).unwrap(), "wss://ws.finnhub.io?token=abc123");
        assert_eq!(subscriptions(Provider::Finnhub, &s).len(), 2);
    }

    #[test]
    fn prices_are_read_from_each_feed_and_everything_else_is_ignored() {
        let b = r#"{"stream":"btcusdt@miniTicker","data":{"e":"24hrMiniTicker","s":"BTCUSDT","c":"62000.10","o":"61000"}}"#;
        assert_eq!(parse(Provider::Binance, b), vec![Tick { symbol: "BTCUSDT".into(), price: 62000.10 }]);

        let c = r#"{"type":"ticker","product_id":"ETH-USD","price":"2450.5","time":"2026-10-08T10:00:00Z"}"#;
        assert_eq!(parse(Provider::Coinbase, c), vec![Tick { symbol: "ETH-USD".into(), price: 2450.5 }]);
        assert!(parse(Provider::Coinbase, r#"{"type":"subscriptions","channels":[]}"#).is_empty());

        let f = r#"{"type":"trade","data":[{"s":"AAPL","p":191.2,"t":1,"v":10},{"s":"MSFT","p":420,"t":2,"v":5},{"s":"BAD","p":-1}]}"#;
        assert_eq!(parse(Provider::Finnhub, f).len(), 2);
        assert!(parse(Provider::Finnhub, r#"{"type":"ping"}"#).is_empty());
        assert!(parse(Provider::Binance, "not json").is_empty());
    }

    #[test]
    fn ticks_between_two_sends_keep_their_high_and_low() {
        let mut pending = HashMap::new();
        fold(&mut pending, "binance:BTCUSDT".into(), 100.0, 1);
        fold(&mut pending, "binance:BTCUSDT".into(), 120.0, 2);
        fold(&mut pending, "binance:BTCUSDT".into(), 90.0, 3);
        fold(&mut pending, "binance:BTCUSDT".into(), 95.0, 4);
        assert_eq!(pending["binance:BTCUSDT"], Quote { price: 95.0, high: 120.0, low: 90.0, at: 4 });
    }
}
