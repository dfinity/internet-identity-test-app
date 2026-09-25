//! Everything the library holds, in stable memory.

use super::ids;
use super::keys::{self, EntryKey};
use crate::types::{
    Bucket, Content, Misconfigured, MisconfiguredSince, Notification, NotificationId,
};
use candid::{CandidType, Decode, Encode, Principal};
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
use ic_stable_structures::storable::{Bound, Storable};
use ic_stable_structures::{BTreeMap, DefaultMemoryImpl};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

pub type Memory = VirtualMemory<DefaultMemoryImpl>;

/// The stable memories the library keeps its state in. Content has its own
/// because it runs to 8KB where a row is 66 bytes, and a `StableBTreeMap`
/// sizes its nodes from the value bound.
#[derive(Clone, Copy, Debug)]
pub struct Memories {
    /// Notifications waiting to be sent, and where each one stands.
    pub entries: MemoryId,
    /// What a channel may still pull.
    pub content: MemoryId,
    /// An hour of the delivery pipeline per row, thirty days deep.
    pub metrics: MemoryId,
}

pub const WEIGHTS: [usize; 4] = [8, 4, 2, 1];
const LANES: u8 = 4;

const HOUR: u64 = 3_600_000_000_000;
const KEEP_HOURS: usize = 720;

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: NotificationId,
    pub recipient: Principal,
    pub lane: u8,
    pub expires_at: u64,
    pub due_at: u64,
    /// Its one second attempt has been spent.
    pub retried: bool,
}

/// When the second attempt a refusal earns is made: late enough to leave the
/// user most of the window to sign in or turn notifications on, early enough
/// that a five-minute notification still gets the attempt.
fn retry_at(now: u64, expires_at: u64) -> u64 {
    now + expires_at.saturating_sub(now) * 2 / 3
}

/// Where a notification stands, as one small row per notification, so a repeat
/// of a key finds it without walking the map.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Slot {
    kind: u8,
    lane: u8,
    expires_at: u64,
    due_at: u64,
}

impl Slot {
    fn key(&self, id: NotificationId) -> EntryKey {
        match self.kind {
            keys::WAITING => EntryKey::waiting(self.lane, self.expires_at, id),
            keys::PARKED => EntryKey::parked(self.due_at, id),
            _ => EntryKey::accepted(self.expires_at, id),
        }
    }

    fn queued(&self) -> bool {
        self.kind == keys::WAITING || self.kind == keys::PARKED
    }
}

/// A row of the entry map: a notification, or where one stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Row {
    Entry(Entry),
    Slot(Slot),
}

impl Storable for Row {
    const BOUND: Bound = Bound::Bounded {
        max_size: 66,
        is_fixed_size: false,
    };

    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut bytes = Vec::with_capacity(66);
        match self {
            Row::Entry(entry) => {
                let who = entry.recipient.as_slice();
                bytes.push(0);
                bytes.extend_from_slice(&entry.id.to_be_bytes());
                bytes.extend_from_slice(&entry.expires_at.to_be_bytes());
                bytes.extend_from_slice(&entry.due_at.to_be_bytes());
                bytes.push(entry.lane);
                bytes.push(u8::from(entry.retried));
                bytes.push(who.len() as u8);
                bytes.extend_from_slice(who);
            }
            Row::Slot(slot) => {
                bytes.push(1);
                bytes.push(slot.kind);
                bytes.push(slot.lane);
                bytes.extend_from_slice(&slot.expires_at.to_be_bytes());
                bytes.extend_from_slice(&slot.due_at.to_be_bytes());
            }
        }
        Cow::Owned(bytes)
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let word =
            |from: usize| u64::from_be_bytes(bytes[from..from + 8].try_into().expect("bounded"));
        match bytes[0] {
            0 => {
                let length = usize::from(bytes[27]);
                Row::Entry(Entry {
                    id: word(1),
                    expires_at: word(9),
                    due_at: word(17),
                    lane: bytes[25],
                    retried: bytes[26] == 1,
                    recipient: Principal::from_slice(&bytes[28..28 + length]),
                })
            }
            _ => Row::Slot(Slot {
                kind: bytes[1],
                lane: bytes[2],
                expires_at: word(3),
                due_at: word(11),
            }),
        }
    }
}

/// Candid for the values whose shape may grow.
macro_rules! candid_storable {
    ($type:ty, $max:expr) => {
        impl Storable for $type {
            const BOUND: Bound = Bound::Bounded {
                max_size: $max,
                is_fixed_size: false,
            };

            fn to_bytes(&self) -> Cow<'_, [u8]> {
                Cow::Owned(Encode!(self).expect("candid encoding"))
            }

            fn into_bytes(self) -> Vec<u8> {
                Encode!(&self).expect("candid encoding")
            }

            fn from_bytes(bytes: Cow<[u8]>) -> Self {
                Decode!(bytes.as_ref(), Self).expect("candid decoding")
            }
        }
    };
}

/// Bounded so the map can index it, and past any realistic notification.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct StoredContent(pub Content);
candid_storable!(StoredContent, 8_192);

/// A row of the metrics map: an hour of the pipeline, or the library's
/// counters under `COUNTERS_ROW`. Hour zero is the epoch, so never a bucket.
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum MetricsRow {
    Hour(Bucket),
    Counters(Meta),
}
candid_storable!(MetricsRow, 256);

const COUNTERS_ROW: u64 = 0;

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Meta {
    pub counter: u64,
    pub id_seed: u64,
    pub bytes: u64,
    pub batch_limit: u64,
    pub queued: u64,
    pub misconfigured: Option<MisconfiguredSince>,
}
candid_storable!(Meta, 256);

pub struct Store {
    entries: BTreeMap<EntryKey, Row, Memory>,
    content: BTreeMap<NotificationId, StoredContent, Memory>,
    rows: BTreeMap<u64, MetricsRow, Memory>,
}

#[derive(Clone, Copy, Debug)]
pub enum Event {
    Sent,
    Accepted,
    Deferred,
    Received,
    Dropped,
}

impl Store {
    pub fn new(manager: &MemoryManager<DefaultMemoryImpl>, memories: Memories) -> Self {
        Self {
            entries: BTreeMap::init(manager.get(memories.entries)),
            content: BTreeMap::init(manager.get(memories.content)),
            rows: BTreeMap::init(manager.get(memories.metrics)),
        }
    }

    fn meta(&self) -> Meta {
        match self.rows.get(&COUNTERS_ROW) {
            Some(MetricsRow::Counters(meta)) => meta,
            _ => Meta::default(),
        }
    }

    fn set_meta(&mut self, meta: Meta) {
        self.rows.insert(COUNTERS_ROW, MetricsRow::Counters(meta));
    }

    /// Adds a notification, or replaces the one its key already names.
    /// `None` when the capacity ceiling refused it.
    pub fn add(
        &mut self,
        recipient: Principal,
        notification: Notification,
        default_expiry: u64,
        capacity_bytes: u64,
        now: u64,
    ) -> Option<NotificationId> {
        self.sweep(now);

        let mut meta = self.meta();

        let id = match notification.key.as_deref() {
            Some(key) => ids::keyed(recipient, key),
            None => {
                meta.counter += 1;
                ids::keyless(meta.id_seed, meta.counter)
            }
        };

        let content = Content {
            title: notification.title,
            body: notification.body,
            url: notification.url,
        };
        let size = size_of_content(&content);

        // Replacing a notification frees what the old one held, so an app that
        // updates one key forever occupies one notification's worth of room.
        if let Some(StoredContent(old)) = self.content.get(&id) {
            meta.bytes = meta.bytes.saturating_sub(size_of_content(&old));
        }
        self.set_meta(meta);

        if self.meta().bytes + size > capacity_bytes {
            self.shed(capacity_bytes, size);
            if self.meta().bytes + size > capacity_bytes {
                return None;
            }
        }

        self.content.insert(id, StoredContent(content));
        let mut meta = self.meta();
        meta.bytes += size;
        self.set_meta(meta);

        match self.slot_of(id) {
            // Still on its way out: its content is replaced, the entry stands.
            Some(slot) if slot.queued() => return Some(id),
            // Accepted, so Internet Identity holds a notification whose content
            // has just changed. Sending it again replaces that one.
            Some(_) => {
                self.unplace(id);
            }
            None => {}
        }

        let entry = Entry {
            id,
            recipient,
            lane: lane_of(notification.urgency) as u8,
            expires_at: notification.expires_at.unwrap_or(default_expiry),
            due_at: now,
            retried: false,
        };
        self.place(entry, keys::WAITING, entry.expires_at);

        Some(id)
    }

    /// Returns parked entries to their lanes once they are due.
    pub fn promote(&mut self, now: u64) {
        let due: Vec<Entry> = self
            .entries
            .range(EntryKey::parked_start()..=EntryKey::parked_due_by(now))
            .filter_map(|row| match row.value() {
                Row::Entry(entry) => Some(entry),
                Row::Slot(_) => None,
            })
            .collect();

        for entry in due {
            self.place(entry, keys::WAITING, entry.expires_at);
        }
    }

    /// A batch, in weighted cycles: `WEIGHTS[lane]` per lane per cycle, an
    /// empty lane donating its turns, soonest expiry leading its lane.
    pub fn take(&mut self, count: usize) -> Vec<Entry> {
        let mut taken = Vec::new();
        let mut cursors: Vec<Option<EntryKey>> = (0..LANES)
            .map(|lane| Some(EntryKey::lane_start(lane)))
            .collect();

        while taken.len() < count {
            let mut progressed = false;

            for (lane, &weight) in WEIGHTS.iter().enumerate() {
                for _ in 0..weight {
                    if taken.len() >= count {
                        break;
                    }
                    let Some(from) = cursors[lane] else { break };

                    match self
                        .entries
                        .range(from..=EntryKey::lane_end(lane as u8))
                        .next()
                        .map(|row| row.into_pair())
                    {
                        Some((key, Row::Entry(entry))) => {
                            self.entries.remove(&key);
                            taken.push(entry);
                            progressed = true;
                        }
                        Some(_) | None => {
                            cursors[lane] = None;
                            break;
                        }
                    }
                }
            }

            if !progressed {
                break;
            }
        }

        taken
    }

    /// Internet Identity took it: nothing more to send, and its content waits
    /// there for a pull until it expires.
    pub fn settle(&mut self, entry: &Entry) {
        self.place(*entry, keys::ACCEPTED, entry.expires_at);
    }

    /// One more attempt, later in the notification's window. `false` when this
    /// was that attempt and the notification is now dropped.
    pub fn park(&mut self, mut entry: Entry, now: u64) -> bool {
        if entry.retried {
            self.unplace(entry.id);
            self.release(entry.id);
            return false;
        }

        entry.retried = true;
        entry.due_at = retry_at(now, entry.expires_at);
        self.place(entry, keys::PARKED, entry.due_at);
        true
    }

    /// Internet Identity asked for this one later. Not a refusal, so it does
    /// not spend the second attempt.
    pub fn defer(&mut self, mut entry: Entry, retry_after: u64) {
        entry.due_at = retry_after;
        self.place(entry, keys::PARKED, entry.due_at);
    }

    /// Nothing was enqueued; the entry goes back unchanged.
    pub fn requeue(&mut self, mut entry: Entry, now: u64) {
        entry.due_at = now;
        self.place(entry, keys::WAITING, entry.expires_at);
    }

    /// What a batch may no longer be sent: anything past its expiry, which
    /// Internet Identity would refuse, and anything the app has since
    /// dismissed. Only an expiry counts as a drop; a dismissal is the app
    /// getting what it asked for.
    pub fn sendable(&mut self, batch: Vec<Entry>, now: u64) -> (Vec<Entry>, usize) {
        let mut live = Vec::with_capacity(batch.len());
        let mut expired = 0;

        for entry in batch {
            if entry.expires_at <= now {
                self.unplace(entry.id);
                self.release(entry.id);
                expired += 1;
            } else if self.content.contains_key(&entry.id) {
                live.push(entry);
            } else {
                self.unplace(entry.id);
            }
        }

        (live, expired)
    }

    /// Drops what an expired notification was still holding. Internet Identity
    /// will not pull content it can no longer deliver.
    pub fn sweep(&mut self, now: u64) {
        let expired: Vec<NotificationId> = self
            .entries
            .range(EntryKey::accepted_start()..=EntryKey::accepted_expired_by(now))
            .map(|row| row.key().id())
            .collect();

        for id in expired {
            self.unplace(id);
            self.release(id);
        }
    }

    /// The app says this no longer needs anyone's attention: it leaves the
    /// outbox, and its content goes so a pull finds nothing.
    pub fn dismiss(&mut self, recipient: Principal, key: &str) {
        let id = ids::keyed(recipient, key);
        self.unplace(id);
        self.release(id);
    }

    pub fn content_of(&self, id: NotificationId) -> Option<Content> {
        self.content.get(&id).map(|StoredContent(content)| content)
    }

    /// `false` when there is no such notification to have received.
    pub fn holds(&self, id: NotificationId) -> bool {
        self.content.contains_key(&id)
    }

    /// Notifications waiting for Internet Identity to accept them.
    pub fn backlog(&self) -> u64 {
        self.meta().queued
    }

    pub fn batch_limit(&self) -> usize {
        self.meta().batch_limit.max(1) as usize
    }

    pub fn set_batch_limit(&mut self, limit: usize) {
        let mut meta = self.meta();
        meta.batch_limit = limit as u64;
        self.set_meta(meta);
    }

    pub fn misconfigured(&self) -> Option<MisconfiguredSince> {
        self.meta().misconfigured
    }

    pub fn note(&mut self, why: Misconfigured, now: u64) {
        let mut meta = self.meta();
        if meta.misconfigured.map(|since| since.why) == Some(why) {
            return;
        }
        meta.misconfigured = Some(MisconfiguredSince { why, since: now });
        self.set_meta(meta);
    }

    pub fn is_seeded(&self) -> bool {
        self.meta().id_seed != 0
    }

    pub fn seed(&mut self, randomness: &[u8]) {
        let mut meta = self.meta();
        if meta.id_seed == 0 {
            meta.id_seed = ids::seed_from(randomness);
            self.set_meta(meta);
        }
    }

    pub fn record(&mut self, now: u64, event: Event, count: u64) {
        let start = now - (now % HOUR);
        let mut bucket = match self.rows.get(&start) {
            Some(MetricsRow::Hour(bucket)) => bucket,
            _ => Bucket {
                start,
                ..Bucket::default()
            },
        };

        match event {
            Event::Sent => bucket.sent += count,
            Event::Accepted => bucket.accepted += count,
            Event::Deferred => bucket.deferred += count,
            Event::Received => bucket.received += count,
            Event::Dropped => bucket.dropped += count,
        }

        self.rows.insert(start, MetricsRow::Hour(bucket));

        // One row is the counters rather than an hour.
        while self.rows.len() as usize > KEEP_HOURS + 1 {
            let oldest = self
                .rows
                .range(COUNTERS_ROW + 1..)
                .next()
                .map(|row| *row.key());
            match oldest {
                Some(hour) => {
                    self.rows.remove(&hour);
                }
                None => break,
            }
        }
    }

    pub fn hours(&self) -> Vec<Bucket> {
        self.rows
            .range(COUNTERS_ROW + 1..)
            .filter_map(|row| match row.value() {
                MetricsRow::Hour(bucket) => Some(bucket),
                MetricsRow::Counters(_) => None,
            })
            .collect()
    }

    fn slot_of(&self, id: NotificationId) -> Option<Slot> {
        match self.entries.get(&EntryKey::slot(id)) {
            Some(Row::Slot(slot)) => Some(slot),
            _ => None,
        }
    }

    /// Puts an entry in one of the three orders and records where it went.
    fn place(&mut self, entry: Entry, kind: u8, at: u64) {
        let slot = Slot {
            kind,
            lane: entry.lane,
            expires_at: entry.expires_at,
            due_at: at,
        };

        let was = self.slot_of(entry.id);
        if let Some(old) = was {
            self.entries.remove(&old.key(entry.id));
        }

        self.entries.insert(slot.key(entry.id), Row::Entry(entry));
        self.entries
            .insert(EntryKey::slot(entry.id), Row::Slot(slot));
        self.count(was.is_some_and(|old| old.queued()), slot.queued());
    }

    /// Takes an entry out of every order it is in.
    fn unplace(&mut self, id: NotificationId) {
        let Some(slot) = self.slot_of(id) else { return };
        self.entries.remove(&slot.key(id));
        self.entries.remove(&EntryKey::slot(id));
        self.count(slot.queued(), false);
    }

    fn count(&mut self, was_queued: bool, is_queued: bool) {
        if was_queued == is_queued {
            return;
        }
        let mut meta = self.meta();
        meta.queued = if is_queued {
            meta.queued + 1
        } else {
            meta.queued.saturating_sub(1)
        };
        self.set_meta(meta);
    }

    fn release(&mut self, id: NotificationId) {
        if let Some(StoredContent(content)) = self.content.remove(&id) {
            let mut meta = self.meta();
            meta.bytes = meta.bytes.saturating_sub(size_of_content(&content));
            self.set_meta(meta);
        }
    }

    /// Sheds the outbox, lowest lane first. Never accepted content: a pull
    /// has to find it.
    fn shed(&mut self, capacity_bytes: u64, needed: u64) {
        for lane in (0..LANES).rev() {
            while self.meta().bytes + needed > capacity_bytes {
                let Some(entry) = self
                    .entries
                    .range(EntryKey::lane_start(lane)..=EntryKey::lane_end(lane))
                    .next()
                    .and_then(|row| match row.value() {
                        Row::Entry(entry) => Some(entry),
                        Row::Slot(_) => None,
                    })
                else {
                    break;
                };

                self.unplace(entry.id);
                self.release(entry.id);
            }
        }
    }
}

pub fn lane_of(urgency: Option<crate::types::Urgency>) -> usize {
    use crate::types::Urgency;
    match urgency.unwrap_or_default() {
        Urgency::High => 0,
        Urgency::Normal => 1,
        Urgency::Low => 2,
        Urgency::VeryLow => 3,
    }
}

fn size_of_content(content: &Content) -> u64 {
    (content.title.len() + content.body.len() + content.url.as_ref().map_or(0, String::len) + 64)
        as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Urgency;

    const HOUR: u64 = 3_600_000_000_000;
    const ROOMY: u64 = 1_000_000;
    const MEMORY_IDS: Memories = Memories {
        entries: MemoryId::new(0),
        content: MemoryId::new(1),
        metrics: MemoryId::new(2),
    };

    /// Off-canister, `DefaultMemoryImpl` is a plain vector, so the whole store
    /// runs in a test without a replica.
    fn store() -> Store {
        let manager = Box::leak(Box::new(MemoryManager::init(DefaultMemoryImpl::default())));
        Store::new(manager, MEMORY_IDS)
    }

    fn alice() -> Principal {
        Principal::from_text("un4fu-tqaaa-aaaab-qadjq-cai").unwrap()
    }

    fn note(title: &str, key: Option<&str>, urgency: Option<Urgency>) -> Notification {
        Notification {
            title: title.into(),
            body: "body".into(),
            key: key.map(str::to_string),
            urgency,
            ..Default::default()
        }
    }

    #[test]
    fn the_same_key_replaces_rather_than_adds() {
        let mut store = store();
        let first = store.add(alice(), note("one", Some("k"), None), HOUR, ROOMY, 0);
        let second = store.add(alice(), note("two", Some("k"), None), HOUR, ROOMY, 0);

        assert_eq!(first, second);
        assert_eq!(store.content_of(first.unwrap()).unwrap().title, "two");
        assert_eq!(store.take(10).len(), 1, "one entry, not two");
    }

    #[test]
    fn a_batch_comes_out_by_lane_weight_and_then_by_expiry() {
        let mut store = store();
        for i in 0..20 {
            store.add(
                alice(),
                note("campaign", Some(&format!("c{i}")), Some(Urgency::VeryLow)),
                HOUR + i,
                ROOMY,
                0,
            );
            store.add(
                alice(),
                note("urgent", Some(&format!("u{i}")), Some(Urgency::High)),
                HOUR + i,
                ROOMY,
                0,
            );
        }

        let batch = store.take(9);
        let urgent = batch.iter().filter(|entry| entry.lane == 0).count();
        assert_eq!((urgent, batch.len() - urgent), (8, 1), "weights are 8 : 1");

        let urgent_expiries: Vec<u64> = batch
            .iter()
            .filter(|entry| entry.lane == 0)
            .map(|entry| entry.expires_at)
            .collect();
        let mut sorted = urgent_expiries.clone();
        sorted.sort_unstable();
        assert_eq!(urgent_expiries, sorted, "soonest expiry leads its lane");
    }

    #[test]
    fn a_refusal_parks_inside_the_window_and_a_second_one_drops_it() {
        let mut store = store();
        let id = store
            .add(alice(), note("x", Some("k"), None), 30 * HOUR, ROOMY, 0)
            .unwrap();

        let first = store.take(10);
        assert!(store.park(first[0], 0));

        store.promote(HOUR);
        assert!(store.take(10).is_empty(), "not due yet");

        store.promote(20 * HOUR);
        let second = store.take(10);
        assert_eq!(second.len(), 1);
        assert!(
            second[0].due_at < second[0].expires_at,
            "the attempt lands before the expiry it is for"
        );
        assert!(
            !store.park(second[0], 20 * HOUR),
            "a second refusal drops it"
        );
        assert!(store.content_of(id).is_none());
        assert_eq!(store.backlog(), 0);
    }

    #[test]
    fn a_five_minute_notification_still_gets_its_second_attempt() {
        let five_minutes = 300_000_000_000;
        let due = retry_at(0, five_minutes);

        assert!(due > 0, "not immediately, or the attempt is the same call");
        assert!(due < five_minutes, "and not after it has expired");
    }

    #[test]
    fn the_ceiling_sheds_the_campaign_and_keeps_the_urgent() {
        let mut store = store();
        let tiny = 900;

        let campaign: Vec<NotificationId> = (0..20)
            .filter_map(|i| {
                store.add(
                    alice(),
                    note("campaign", Some(&format!("c{i}")), Some(Urgency::VeryLow)),
                    HOUR,
                    tiny,
                    0,
                )
            })
            .collect();
        let urgent = store
            .add(
                alice(),
                note("urgent", Some("u"), Some(Urgency::High)),
                HOUR,
                tiny,
                0,
            )
            .expect("room is made for it");

        let kept = campaign
            .iter()
            .filter(|id| store.content_of(**id).is_some())
            .count();
        assert!(
            kept < campaign.len(),
            "the campaign paid for the room: {kept} of {} still held",
            campaign.len()
        );
        assert!(store.content_of(urgent).is_some());
        assert_eq!(store.backlog() as usize, kept + 1, "what is shed is gone");
    }

    #[test]
    fn a_sweep_frees_the_room_accepted_content_was_holding() {
        let mut store = store();
        // Room for one notification and no more.
        let tiny = 100;

        let filler = store
            .add(alice(), note("filler", Some("f"), None), HOUR, tiny, 0)
            .expect("the first one fits");
        let batch = store.take(10);
        store.settle(&batch[0]);

        // At the ceiling with nothing left to shed, because accepted content
        // is never shed.
        assert!(store
            .add(alice(), note("x", Some("x"), None), HOUR, tiny, 0)
            .is_none());

        // Past the filler's expiry there is room again, and the add sweeps.
        assert!(store
            .add(alice(), note("x", Some("x"), None), 2 * HOUR, tiny, HOUR)
            .is_some());
        assert!(!store.holds(filler), "it expired an hour ago");
    }

    #[test]
    fn a_deferral_does_not_spend_the_second_attempt() {
        let mut store = store();
        store.add(alice(), note("x", Some("k"), None), 30 * HOUR, ROOMY, 0);

        let first = store.take(10);
        store.defer(first[0], 2 * HOUR);
        store.promote(2 * HOUR);

        let deferred = store.take(10);
        assert_eq!(deferred.len(), 1, "a deferral comes back when asked for");
        assert!(
            store.park(deferred[0], 2 * HOUR),
            "the attempt is still there"
        );

        store.promote(30 * HOUR);
        let last = store.take(10);
        assert!(!store.park(last[0], 25 * HOUR), "and only one of them");
    }

    #[test]
    fn accepted_content_goes_when_the_notification_expires() {
        let mut store = store();
        let id = store
            .add(alice(), note("x", Some("k"), None), HOUR, ROOMY, 0)
            .unwrap();

        let batch = store.take(10);
        store.settle(&batch[0]);
        assert_eq!(store.backlog(), 0, "accepted is not backlog");

        store.sweep(HOUR - 1);
        assert!(store.holds(id), "a channel may still pull it");

        store.sweep(HOUR);
        assert!(!store.holds(id), "nothing will pull it now");
    }

    #[test]
    fn a_dismissed_notification_is_never_sent() {
        let mut store = store();
        store.add(alice(), note("x", Some("k"), None), HOUR, ROOMY, 0);
        store.dismiss(alice(), "k");

        assert_eq!(store.backlog(), 0);
        let batch = store.take(10);
        let (live, expired) = store.sendable(batch, 0);
        assert!(live.is_empty());
        assert_eq!(expired, 0, "a dismissal is not a delivery failure");
    }

    #[test]
    fn an_expired_notification_is_dropped_rather_than_sent() {
        let mut store = store();
        let id = store
            .add(alice(), note("x", Some("k"), None), HOUR, ROOMY, 0)
            .unwrap();

        let batch = store.take(10);
        let (live, expired) = store.sendable(batch, HOUR);

        assert!(live.is_empty());
        assert_eq!(expired, 1);
        assert!(!store.holds(id));
        assert_eq!(store.backlog(), 0);
    }

    #[test]
    fn hours_accumulate_and_the_ring_keeps_a_month() {
        let mut store = store();
        store.record(5 * HOUR + 1, Event::Sent, 3);
        store.record(5 * HOUR + 2_000, Event::Accepted, 2);

        let hours = store.hours();
        assert_eq!(hours.len(), 1);
        assert_eq!((hours[0].sent, hours[0].accepted), (3, 2));
        assert_eq!(hours[0].start, 5 * HOUR);

        for hour in 0..800u64 {
            store.record(hour * HOUR, Event::Sent, 1);
        }
        let ring = store.hours();
        assert_eq!(ring.len(), KEEP_HOURS);
        assert_eq!(ring[0].start, 80 * HOUR, "the oldest hours went");
        assert_eq!(ring[KEEP_HOURS - 1].start, 799 * HOUR);
    }

    #[test]
    fn nothing_is_lost_across_a_reopen() {
        let manager = Box::leak(Box::new(MemoryManager::init(DefaultMemoryImpl::default())));
        let id = {
            let mut store = Store::new(manager, MEMORY_IDS);
            store.add(alice(), note("pending", Some("k"), None), HOUR, ROOMY, 0);
            store.record(HOUR, Event::Sent, 1);
            store.set_batch_limit(17);
            ids::keyed(alice(), "k")
        };

        let reopened = Store::new(manager, MEMORY_IDS);
        assert!(reopened.content_of(id).is_some(), "content survives");
        assert_eq!(reopened.backlog(), 1, "the outbox survives");
        assert_eq!(reopened.hours().len(), 1, "metrics survive");
        assert_eq!(reopened.batch_limit(), 17, "the learned limit survives");
    }
}
