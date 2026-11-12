//! The off-chain hand-off:
//! - Buy: the user gives the winning maker its unified address and salt. The maker accepts them only if they open the
//!   order's receiver commitment, which binds them, so no signature is needed: only the user knows both.
//! - Sell: the user asks the winning maker for its receiver and salt, signing with the order's address, and may tell
//!   the maker its payment's txid so the maker proves first. The user's own proof stays the fallback.
//!
//! Nothing a request carries is logged: not the address, the salt, the txid or the signature.

use std::{path::PathBuf, sync::Arc};

use alloy::{
    primitives::{Address, B256, Signature},
    providers::DynProvider,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderValue, Method, StatusCode},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;
use tracing::{info, warn};

use crate::{
    book::{Book, MakerStatus, private_dir, private_file},
    decide::{DeskStatus, Side},
    desk::Desk,
    seam::Seam,
};

pub struct ApiState {
    pub book: Arc<Mutex<Book>>,
    pub book_path: PathBuf,
    pub orders_dir: PathBuf,
    pub desk: Arc<Desk<DynProvider>>,
    pub seam: Arc<Seam>,
    pub privacy_delay_max_secs: u64,
}

type Api = Arc<ApiState>;
type ApiResult<T> = Result<Json<T>, (StatusCode, String)>;

pub fn router(state: Api, origins: &[String]) -> Router {
    let origins: Vec<HeaderValue> = origins.iter().filter_map(|o| o.parse().ok()).collect();
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([axum::http::header::CONTENT_TYPE]);
    Router::new()
        .route("/v1/maker", get(maker))
        .route("/v1/orders/{order_id}/handoff", post(handoff))
        .route("/v1/orders/{order_id}/receiver", post(receiver))
        .route("/v1/orders/{order_id}/paid", post(paid))
        .layer(DefaultBodyLimit::max(4096))
        .layer(cors)
        .with_state(state)
}

fn bad(code: StatusCode, why: &str) -> (StatusCode, String) {
    (code, why.to_owned())
}

/// The directory of an order's private files.
pub fn order_dir(orders_dir: &std::path::Path, order_id: &B256) -> PathBuf {
    orders_dir.join(hex::encode(order_id))
}

/// The message an order's user signs to ask for the maker's receiver, or to tell its txid.
pub fn signed_message(what: &str, chain_id: u64, desk: Address, order_id: B256) -> String {
    format!("ZEC Desk {what}\nchain: {chain_id}\ndesk: {desk}\norder: {order_id}")
}

#[derive(Serialize)]
struct MakerInfo {
    maker: Address,
    desk: Address,
}

async fn maker(State(s): State<Api>) -> Json<MakerInfo> {
    Json(MakerInfo {
        maker: s.desk.me,
        desk: s.desk.desk,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HandoffBody {
    address: String,
    salt: String,
}

#[derive(Serialize)]
struct Accepted {
    accepted: bool,
}

fn parse_salt(text: &str) -> Option<[u8; 32]> {
    let t = text.trim().trim_start_matches("0x");
    if t.len() != 64 {
        return None;
    }
    hex::decode(t).ok()?.try_into().ok()
}

fn parse_order(id: &str) -> Result<B256, (StatusCode, String)> {
    id.parse::<B256>().map_err(|_| bad(StatusCode::BAD_REQUEST, "order id: 32 bytes in hex"))
}

/// Buy: the user's receiver and salt, checked against the order's commitment.
async fn handoff(State(s): State<Api>, Path(id): Path<String>, Json(b): Json<HandoffBody>) -> ApiResult<Accepted> {
    let order_id = parse_order(&id)?;
    let salt = parse_salt(&b.salt).ok_or_else(|| bad(StatusCode::BAD_REQUEST, "salt: 64 hex digits"))?;
    let address = b.address.trim().to_owned();
    if !address.starts_with("utest1") || address.len() > 512 || !address.bytes().all(|c| c.is_ascii_alphanumeric()) {
        return Err(bad(StatusCode::BAD_REQUEST, "address: a Zcash Testnet unified address"));
    }
    {
        let book = s.book.lock().await;
        match book.orders.get(&order_id) {
            Some(r) if r.side == Side::Buy && r.status == MakerStatus::Quoted => {}
            Some(r) if r.side == Side::Buy && r.status == MakerStatus::Handoff => {
                return Ok(Json(Accepted { accepted: true }));
            }
            Some(_) => {
                return Err(bad(StatusCode::CONFLICT, "this maker takes no hand-off for the order now"));
            }
            None => return Err(bad(StatusCode::NOT_FOUND, "not an order of this maker")),
        }
    }
    let (o, _) = s.desk.order(order_id).await.map_err(|_| bad(StatusCode::BAD_GATEWAY, "cannot read the order"))?;
    if o.status != DeskStatus::Matched || o.winner != s.desk.me {
        return Err(bad(StatusCode::CONFLICT, "this maker did not win the order, or it is not matched yet"));
    }
    let dir = private_dir(&order_dir(&s.orders_dir, &order_id))
        .map_err(|_| bad(StatusCode::INTERNAL_SERVER_ERROR, "cannot store the hand-off"))?;
    let salt_file = dir.join("salt");
    write_secret(&salt_file, hex::encode(salt).as_bytes())
        .map_err(|_| bad(StatusCode::INTERNAL_SERVER_ERROR, "cannot store the hand-off"))?;
    let c = match s.seam.commitment(&address, &salt_file).await {
        Ok(c) => c,
        Err(_) => {
            let _ = std::fs::remove_file(&salt_file);
            return Err(bad(
                StatusCode::BAD_REQUEST,
                "the address is not a Testnet unified address with an Ironwood receiver",
            ));
        }
    };
    if c != o.receiver_commitment {
        let _ = std::fs::remove_file(&salt_file);
        warn!(order = %order_id, "hand-off refused: it does not open the order's commitment");
        return Err(bad(StatusCode::BAD_REQUEST, "the address and salt do not open the order's commitment"));
    }
    let (_, now) = s.desk.latest().await.map_err(|_| bad(StatusCode::BAD_GATEWAY, "cannot read the chain"))?;
    let delay = random_u64() % (s.privacy_delay_max_secs + 1);
    let mut book = s.book.lock().await;
    if let Some(r) = book.orders.get_mut(&order_id)
        && r.status == MakerStatus::Quoted
    {
        r.receiver = Some(address);
        r.salt = Some(hex::encode(salt));
        r.pay_after = Some(now + delay);
        r.status = MakerStatus::Handoff;
    }
    book.save(&s.book_path)
        .map_err(|_| bad(StatusCode::INTERNAL_SERVER_ERROR, "cannot store the hand-off"))?;
    info!(order = %order_id, "hand-off accepted");
    Ok(Json(Accepted { accepted: true }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedBody {
    signature: String,
}

#[derive(Serialize)]
struct ReceiverReply {
    address: String,
    salt: String,
}

async fn check_signer(s: &ApiState, what: &str, order_id: B256, signature: &str) -> Result<(), (StatusCode, String)> {
    let user = {
        let book = s.book.lock().await;
        book.orders
            .get(&order_id)
            .map(|r| r.user)
            .ok_or_else(|| bad(StatusCode::NOT_FOUND, "not an order of this maker"))?
    };
    let bytes = hex::decode(signature.trim().trim_start_matches("0x"))
        .map_err(|_| bad(StatusCode::BAD_REQUEST, "signature: hex"))?;
    let sig = Signature::try_from(bytes.as_slice()).map_err(|_| bad(StatusCode::BAD_REQUEST, "signature: 65 bytes"))?;
    let chain_id = s.desk.chain_id().await.map_err(|_| bad(StatusCode::BAD_GATEWAY, "cannot read the chain"))?;
    let msg = signed_message(what, chain_id, s.desk.desk, order_id);
    let signer = sig
        .recover_address_from_msg(msg.as_bytes())
        .map_err(|_| bad(StatusCode::BAD_REQUEST, "signature: unreadable"))?;
    if signer != user {
        return Err(bad(StatusCode::FORBIDDEN, "not signed by the order's address"));
    }
    Ok(())
}

/// Sell: the maker's receiver and salt for the order, for its user only, once the maker has funded.
async fn receiver(State(s): State<Api>, Path(id): Path<String>, Json(b): Json<SignedBody>) -> ApiResult<ReceiverReply> {
    let order_id = parse_order(&id)?;
    check_signer(&s, "receiver", order_id, &b.signature).await?;
    let salt = {
        let book = s.book.lock().await;
        let r = book.orders.get(&order_id).ok_or_else(|| bad(StatusCode::NOT_FOUND, "not an order of this maker"))?;
        if r.side != Side::Sell || r.commitment.is_none() {
            return Err(bad(StatusCode::CONFLICT, "the maker has not funded the order"));
        }
        r.salt.clone().ok_or_else(|| bad(StatusCode::CONFLICT, "the maker has not funded the order"))?
    };
    let address = std::fs::read_to_string(&s.seam.cfg.address_file)
        .map_err(|_| bad(StatusCode::INTERNAL_SERVER_ERROR, "cannot read the maker's address"))?;
    info!(order = %order_id, "receiver given to the order's user");
    Ok(Json(ReceiverReply {
        address: address.trim().to_owned(),
        salt: format!("0x{salt}"),
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PaidBody {
    txid: String,
    signature: String,
}

/// Sell: the user's payment txid, so the maker can prove the payment as soon as it is mined.
async fn paid(State(s): State<Api>, Path(id): Path<String>, Json(b): Json<PaidBody>) -> ApiResult<Accepted> {
    let order_id = parse_order(&id)?;
    check_signer(&s, "paid", order_id, &b.signature).await?;
    let txid = b.txid.trim().to_ascii_lowercase();
    if txid.len() != 64 || !txid.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(bad(StatusCode::BAD_REQUEST, "txid: 64 hex digits"));
    }
    let dir = private_dir(&order_dir(&s.orders_dir, &order_id))
        .map_err(|_| bad(StatusCode::INTERNAL_SERVER_ERROR, "cannot store the txid"))?;
    let mut book = s.book.lock().await;
    let r = book
        .orders
        .get_mut(&order_id)
        .ok_or_else(|| bad(StatusCode::NOT_FOUND, "not an order of this maker"))?;
    if r.side != Side::Sell || r.status != MakerStatus::Funding {
        return Err(bad(StatusCode::CONFLICT, "the maker is not waiting for this order's payment"));
    }
    if !r.user_paid {
        write_secret(&dir.join("txid"), txid.as_bytes())
            .map_err(|_| bad(StatusCode::INTERNAL_SERVER_ERROR, "cannot store the txid"))?;
        r.user_paid = true;
        book.save(&s.book_path)
            .map_err(|_| bad(StatusCode::INTERNAL_SERVER_ERROR, "cannot store the txid"))?;
        info!(order = %order_id, "the user told its payment");
    }
    Ok(Json(Accepted { accepted: true }))
}

pub fn write_secret(path: &std::path::Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let mut f = private_file(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}

pub fn random_u64() -> u64 {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).expect("the OS random source");
    u64::from_le_bytes(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::signers::{SignerSync, local::PrivateKeySigner};

    #[test]
    fn salts_parse_strictly() {
        assert_eq!(parse_salt(&"ab".repeat(32)), Some([0xab; 32]));
        assert_eq!(parse_salt(&format!("0x{}", "01".repeat(32))), Some([1; 32]));
        assert_eq!(parse_salt("abcd"), None);
        assert_eq!(parse_salt(&"zz".repeat(32)), None);
    }

    #[test]
    fn a_users_signature_recovers_its_address_for_this_order_only() {
        let k = PrivateKeySigner::random();
        let desk = Address::repeat_byte(7);
        let order = B256::repeat_byte(1);
        let msg = signed_message("receiver", 11_155_111, desk, order);
        let sig = k.sign_message_sync(msg.as_bytes()).unwrap();
        let bytes = sig.as_bytes();
        let back = Signature::try_from(bytes.as_slice()).unwrap();
        assert_eq!(back.recover_address_from_msg(msg.as_bytes()).unwrap(), k.address());
        let other = signed_message("receiver", 11_155_111, desk, B256::repeat_byte(2));
        assert_ne!(back.recover_address_from_msg(other.as_bytes()).unwrap(), k.address());
        let paid = signed_message("paid", 11_155_111, desk, order);
        assert_ne!(back.recover_address_from_msg(paid.as_bytes()).unwrap(), k.address());
    }
}
