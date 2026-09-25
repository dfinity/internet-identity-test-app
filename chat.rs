//! One chatroom, so notifications can be tested end to end: joining and
//! sending are the two things that produce a notification for someone else.
//!
//! Members are principals, capped at [`CAPACITY`]. A join beyond the cap
//! evicts whoever has been quiet longest, where joining and sending both count
//! as activity.

use candid::{CandidType, Deserialize, Principal};
use ic_cdk::api::{msg_caller, time};
use ic_cdk_macros::{query, update};
use identity_notifications as notifications;
use identity_notifications::Notification;
use std::cell::RefCell;

const CAPACITY: usize = 100;

/// Every message is about the same thing — the room — so they share one key,
/// and a second message replaces the notification the first one left.
const KEY: &str = "chat";

#[derive(Clone, Debug, CandidType, Deserialize)]
pub struct Member {
    pub who: Principal,
    /// Joined or last sent, in nanoseconds since the epoch.
    pub last_active: u64,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
pub struct ChatMessage {
    pub from: Principal,
    pub text: String,
    pub at: u64,
}

#[derive(Clone, Debug, Default, CandidType, Deserialize)]
pub struct Room {
    pub members: Vec<Member>,
    pub messages: Vec<ChatMessage>,
}

thread_local! {
    static ROOM: RefCell<Room> = RefCell::new(Room::default());
}

/// Joins the room, or refreshes the caller's activity if they are already in
/// it. Returns whoever was evicted to make room.
#[update]
pub fn chat_join() -> Option<Principal> {
    ROOM.with_borrow_mut(|room| join(room, msg_caller(), time()))
}

fn join(room: &mut Room, who: Principal, now: u64) -> Option<Principal> {
    if let Some(member) = room.members.iter_mut().find(|member| member.who == who) {
        member.last_active = now;
        return None;
    }

    room.members.push(Member {
        who,
        last_active: now,
    });

    if room.members.len() <= CAPACITY {
        return None;
    }

    let quietest = room
        .members
        .iter()
        .enumerate()
        .min_by_key(|(_, member)| member.last_active)
        .map(|(at, _)| at)
        .expect("the room is over capacity, so it has members");
    Some(room.members.remove(quietest).who)
}

/// Posts a message and notifies everyone else in the room.
#[update]
pub fn chat_send(text: String) {
    let caller = msg_caller();
    let now = time();

    let members = ROOM.with_borrow_mut(|room| {
        if let Some(member) = room.members.iter_mut().find(|member| member.who == caller) {
            member.last_active = now;
        }

        room.messages.push(ChatMessage {
            from: caller,
            text: text.clone(),
            at: now,
        });

        room.members
            .iter()
            .map(|member| member.who)
            .collect::<Vec<_>>()
    });

    for member in members.into_iter().filter(|member| *member != caller) {
        notifications::send(
            member,
            Notification {
                title: "Test app chat".to_string(),
                body: text.clone(),
                url: chat_url(),
                key: Some(KEY.to_string()),
                ..Default::default()
            },
        );
    }
}

#[query]
pub fn chat_room() -> Room {
    ROOM.with_borrow(Clone::clone)
}

/// Where acting on a notification takes the user. Internet Identity refuses a
/// URL that is not on the sending origin, which is the origin the library is
/// configured with.
fn chat_url() -> Option<String> {
    #[cfg(target_arch = "wasm32")]
    {
        use ic_cdk::api::{env_var_name_exists, env_var_value};

        if env_var_name_exists("notification_origin") {
            return Some(format!("{}/#chat", env_var_value("notification_origin")));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(n: u64) -> Principal {
        Principal::from_slice(&n.to_be_bytes())
    }

    #[test]
    fn joining_again_only_refreshes() {
        let mut room = Room::default();
        assert_eq!(join(&mut room, member(1), 10), None);
        assert_eq!(join(&mut room, member(1), 20), None);

        assert_eq!(room.members.len(), 1);
        assert_eq!(room.members[0].last_active, 20);
    }

    #[test]
    fn the_next_member_evicts_the_quietest() {
        let mut room = Room::default();
        for n in 0..CAPACITY as u64 {
            assert_eq!(join(&mut room, member(n), n + 1), None, "the room has room");
        }

        // The first to join has been quiet longest, until it comes back.
        let refreshed = member(0);
        join(&mut room, refreshed, 1_000);

        let evicted = join(&mut room, member(CAPACITY as u64), 1_001);
        assert_eq!(evicted, Some(member(1)), "the next quietest goes instead");
        assert_eq!(room.members.len(), CAPACITY);
        assert!(room.members.iter().any(|member| member.who == refreshed));
    }
}
