//! What an app passes in and reads back. Everything else is internal.

use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

/// How Internet Identity should schedule a notification against the origin's
/// other traffic. Not a rendering hint: channels without a tray honour it too.
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Urgency {
    VeryLow,
    Low,
    #[default]
    Normal,
    High,
}

/// What the app describes when it sends.
///
/// ```
/// use identity_notifications::{Notification, Urgency};
///
/// let notification = Notification {
///     title: "New message".into(),
///     body: "See you at six".into(),
///     url: Some("https://chat.example.com/chats/alice".into()),
///     key: Some("chat-alice".into()),
///     urgency: Some(Urgency::High),
///     ..Default::default()
/// };
/// ```
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Notification {
    pub title: String,
    pub body: String,
    /// Where acting on it takes them. Must be on the sending origin or one of
    /// its alternative origins; Internet Identity refuses anything else.
    pub url: Option<String>,
    /// What this notification is about. Sending again with the same key
    /// updates that notification rather than adding another, and it is what
    /// [`crate::dismiss`] names. Derive it from data the sender cannot choose.
    pub key: Option<String>,
    /// `None` is [`Urgency::Normal`].
    pub urgency: Option<Urgency>,
    /// `None` is Internet Identity's default retention, which is also its
    /// ceiling. Nanoseconds since the epoch.
    pub expires_at: Option<u64>,
}

/// What a channel pulls back. The rest of a [`Notification`] never leaves this
/// canister.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Content {
    pub title: String,
    pub body: String,
    pub url: Option<String>,
}

/// One hour of the delivery pipeline.
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Bucket {
    /// The instant the hour begins, nanoseconds since the epoch.
    pub start: u64,
    pub sent: u64,
    pub accepted: u64,
    pub deferred: u64,
    pub received: u64,
    pub dropped: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Misconfigured {
    /// `notification_origin` is unset or empty.
    Origin,
    /// `notification_sender` is unset or not a principal.
    Sender,
    /// The origin does not publish this canister as one of its senders.
    NotAuthorizedSender,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MisconfiguredSince {
    pub why: Misconfigured,
    pub since: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Metrics {
    /// Up to 720 buckets, oldest first. Hours with no traffic are absent.
    pub hours: Vec<Bucket>,
    /// Notifications waiting for Internet Identity to accept them.
    pub backlog: u64,
    pub misconfigured: Option<MisconfiguredSince>,
}

/// Internet Identity scopes notification ids to `(origin, recipient)`.
pub type NotificationId = u64;

/// Who a pull is for, as Internet Identity signed it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SenderInfo {
    pub origin: String,
    pub account: Principal,
}
