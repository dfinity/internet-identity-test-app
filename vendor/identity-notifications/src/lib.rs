//! Notify Internet Identity users from a Rust canister.
//!
//! One call to send; the library owns the ids, the batching, the retries, the
//! content Internet Identity pulls back, and the delivery metrics.
//!
//! ```ignore
//! use candid::Principal;
//! use ic_cdk::api::msg_caller;
//! use ic_cdk::update;
//! use identity_notifications as notifications;
//! use notifications::Notification;
//!
//! notifications::endpoints!();
//!
//! #[update]
//! fn send_message(to: Principal, text: String) {
//!     let from = msg_caller();
//!     // ... store the message ...
//!     notifications::send(
//!         to,
//!         Notification {
//!             title: "New message".into(),
//!             body: text,
//!             url: Some(format!("https://chat.example.com/chats/{from}")),
//!             key: Some(format!("chat-{from}")),
//!             ..Default::default()
//!         },
//!     );
//! }
//! ```
//!
//! Configured by environment variables: `notification_sender`,
//! `notification_origin`, and optionally `notification_capacity_mb`.

pub mod internal;
pub mod types;

use candid::Principal;
use ic_cdk::api::{msg_caller_info_data, msg_caller_info_signer, time};
use ic_cdk::call::Call;
use ic_cdk_timers::set_timer;
use ic_stable_structures::memory_manager::MemoryManager;
use ic_stable_structures::DefaultMemoryImpl;
use internal::config::{self, Config};
use internal::flush::{self, Outcome};
use internal::ii;
pub use internal::store::Memories;
use internal::store::{Entry, Event, Store};
use std::cell::RefCell;
use std::time::Duration;
pub use types::{
    Bucket, Content, Metrics, Misconfigured, MisconfiguredSince, Notification, NotificationId,
    SenderInfo, Urgency,
};

/// How long sends accumulate before one call carries them. Urgency decides
/// lane order, not call timing, so everything waits for it.
const COALESCE: Duration = Duration::from_secs(2);

/// What Internet Identity accepts in one call, until `TooManyNotifications`
/// says otherwise.
const BATCH_GUESS: usize = 1_000;

/// Internet Identity's own default, mirrored so the outbox orders and expires
/// notifications by the window they actually have.
const II_DEFAULT_RETENTION_NS: u64 = 5 * 60 * 1_000_000_000;

thread_local! {
    /// Everything durable is in stable memory; what is here is the handle to
    /// it, plus two flags that only matter within one execution round.
    static STORE: RefCell<Option<Store>> = const { RefCell::new(None) };
    static FLUSH_ARMED: RefCell<bool> = const { RefCell::new(false) };
    static FLUSHING: RefCell<bool> = const { RefCell::new(false) };
}

/// Hands the library the stable memories it keeps everything in.
///
/// Call it from `#[init]` **and** `#[post_upgrade]`. Nothing is serialised or
/// restored on upgrade: the maps are already where they were.
///
/// ```ignore
/// use ic_cdk::{init, post_upgrade};
/// use ic_stable_structures::memory_manager::MemoryManager;
///
/// thread_local! {
///     static MEMORIES: RefCell<MemoryManager<DefaultMemoryImpl>> =
///         RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
/// }
///
/// #[init]
/// #[post_upgrade]
/// fn init() {
///     MEMORIES.with_borrow(|manager| {
///         notifications::init(
///             manager,
///             Memories {
///                 entries: MemoryId::new(10),
///                 content: MemoryId::new(11),
///                 metrics: MemoryId::new(12),
///             },
///         )
///     });
/// }
/// ```
pub fn init(manager: &MemoryManager<DefaultMemoryImpl>, memories: Memories) {
    let mut store = Store::new(manager, memories);
    if store.batch_limit() <= 1 {
        store.set_batch_limit(BATCH_GUESS);
    }

    let waiting = store.backlog() > 0;
    STORE.set(Some(store));

    // A timer does not survive an upgrade, so an outbox that did needs one.
    // Nothing is waiting on a fresh install, and nothing is scheduled.
    if waiting {
        arm();
    }
}

fn with_store<T>(f: impl FnOnce(&mut Store) -> T) -> Option<T> {
    STORE.with_borrow_mut(|store| store.as_mut().map(f))
}

/// Sends a notification, or updates the one this recipient's `key` already
/// names.
///
/// Never traps and never awaits, so it cannot fail the call it is made from.
/// What goes wrong afterwards shows up in [`metrics`].
pub fn send(recipient: Principal, notification: Notification) {
    let now = time();

    let config = match configured() {
        Ok(config) => config,
        Err(why) => {
            note(why, now);
            with_store(|store| store.record(now, Event::Dropped, 1));
            return;
        }
    };

    let added = with_store(|store| {
        store.add(
            recipient,
            notification,
            now + II_DEFAULT_RETENTION_NS,
            config.capacity_bytes as u64,
            now,
        )
    });

    match added {
        Some(Some(_)) => arm(),
        // Refused by the ceiling, or `init` was never called.
        Some(None) | None => {
            with_store(|store| store.record(now, Event::Dropped, 1));
        }
    }
}

/// This notification no longer needs anyone's attention.
pub fn dismiss(recipient: Principal, key: &str) {
    with_store(|store| store.dismiss(recipient, key));
}

/// The delivery pipeline, hour by hour.
pub fn metrics() -> Metrics {
    with_store(|store| Metrics {
        hours: store.hours(),
        backlog: store.backlog(),
        misconfigured: store.misconfigured(),
    })
    .unwrap_or(Metrics {
        hours: Vec::new(),
        backlog: 0,
        misconfigured: None,
    })
}

/// Answers Internet Identity's content pull, for an app that would rather
/// declare the endpoint itself than use [`endpoints!`].
pub fn notification_content(id: NotificationId) -> Option<Content> {
    sender_info()?;
    with_store(|store| store.content_of(id)).flatten()
}

/// Records Internet Identity's receipt.
pub fn notification_received(id: NotificationId) {
    if sender_info().is_none() {
        return;
    }
    let now = time();
    with_store(|store| {
        if store.holds(id) {
            store.record(now, Event::Received, 1);
        }
    });
}

/// The two endpoints Internet Identity calls: a `query` for the content and an
/// `update` for the receipt.
#[macro_export]
macro_rules! endpoints {
    () => {
        // The type is imported rather than named in the signature, and
        // `ic_cdk` is left unqualified, because `ic_cdk::export_candid!`
        // re-parses these signatures and chokes on a leading `::` — which is
        // exactly what `$crate` expands to.
        use $crate::types::Content as IiNotificationContent;

        #[ic_cdk::query]
        fn _internet_identity_notification_content(id: u64) -> Option<IiNotificationContent> {
            $crate::notification_content(id)
        }

        #[ic_cdk::update]
        fn _internet_identity_notification_received(id: u64) {
            $crate::notification_received(id)
        }
    };
}

fn configured() -> Result<Config, Misconfigured> {
    config::read()
}

fn note(why: Misconfigured, now: u64) {
    with_store(|store| store.note(why, now));
}

/// Internet Identity signed this call's caller info, and it names our own
/// origin. Anything else is not ours to answer.
fn sender_info() -> Option<SenderInfo> {
    let config = configured().ok()?;
    if msg_caller_info_signer()? != config.sender {
        return None;
    }

    let info = internal::caller_info::decode(&msg_caller_info_data())?;
    (info.origin == config.origin).then_some(info)
}

fn arm() {
    let arm = FLUSH_ARMED.with_borrow_mut(|armed| {
        if *armed || FLUSHING.with_borrow(|flushing| *flushing) {
            return false;
        }
        *armed = true;
        true
    });

    if arm {
        set_timer(COALESCE, flush_once());
    }
}

async fn flush_once() {
    FLUSH_ARMED.set(false);

    let config = match configured() {
        Ok(config) => config,
        Err(why) => {
            note(why, time());
            return;
        }
    };

    if with_store(|store| store.is_seeded()) == Some(false) {
        seed_ids().await;
    }

    let now = time();
    let batch = with_store(|store| {
        store.sweep(now);
        store.promote(now);
        let batch = store.take(store.batch_limit());
        let (live, expired) = store.sendable(batch, now);
        if expired > 0 {
            store.record(now, Event::Dropped, expired as u64);
        }
        live
    })
    .unwrap_or_default();

    if batch.is_empty() {
        return;
    }

    FLUSHING.set(true);
    let outcome = send_batch(&config, &batch).await;
    FLUSHING.set(false);

    match &outcome {
        Outcome::TooMany(limit) => {
            with_store(|store| store.set_batch_limit((*limit).max(1)));
        }
        Outcome::NotAuthorized => note(Misconfigured::NotAuthorizedSender, now),
        _ => {}
    }

    with_store(|store| flush::apply(store, batch, outcome, now));

    if with_store(|store| store.backlog() > 0) == Some(true) {
        arm();
    }
}

async fn send_batch(config: &Config, batch: &[Entry]) -> Outcome {
    let arg = flush::arg(&config.origin, batch);

    let response = Call::unbounded_wait(config.sender, "app_send_notification")
        .with_arg(&arg)
        .await;

    match response.map(|reply| reply.candid::<ii::SendNotificationResult>()) {
        Ok(Ok(ii::SendNotificationResult::Ok(response))) => {
            Outcome::Answered(response.not_accepted)
        }
        Ok(Ok(ii::SendNotificationResult::Err(error))) => match error {
            ii::SendNotificationError::TooManyNotifications { limit } => {
                Outcome::TooMany(limit as usize)
            }
            ii::SendNotificationError::NoSuchSender => Outcome::NotAuthorized,
            ii::SendNotificationError::InternalCanisterError(_) => Outcome::Unreachable,
        },
        Ok(Err(_)) | Err(_) => Outcome::Unreachable,
    }
}

/// A random offset for counter ids, taken once.
async fn seed_ids() {
    let reply = Call::unbounded_wait(Principal::management_canister(), "raw_rand").await;

    if let Ok(Ok(bytes)) = reply.map(|reply| reply.candid::<Vec<u8>>()) {
        with_store(|store| store.seed(&bytes));
    }
}
