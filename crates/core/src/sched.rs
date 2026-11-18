//! Virtual-clock event scheduler.
//!
//! Peripherals never "tick" every cycle. Instead they schedule an event at
//! the cycle when something observable happens (timer overflow, UART byte
//! shifted out, ADC conversion done) and the machine runs the CPU up to the
//! next event.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::Cycles;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Entry<E: Ord> {
    at: Cycles,
    seq: u64,
    event: E,
}

/// A min-heap of `(cycle, event)` pairs. Events scheduled for the same cycle
/// fire in insertion order.
#[derive(Debug)]
pub struct Scheduler<E: Ord> {
    now: Cycles,
    seq: u64,
    queue: BinaryHeap<Reverse<Entry<E>>>,
}

impl<E: Ord> Default for Scheduler<E> {
    fn default() -> Self {
        Self {
            now: 0,
            seq: 0,
            queue: BinaryHeap::new(),
        }
    }
}

impl<E: Ord> Scheduler<E> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn now(&self) -> Cycles {
        self.now
    }

    /// Schedule `event` to fire `delay` cycles from now.
    pub fn schedule_in(&mut self, delay: Cycles, event: E) {
        self.schedule_at(self.now.saturating_add(delay), event);
    }

    pub fn schedule_at(&mut self, at: Cycles, event: E) {
        let seq = self.seq;
        self.seq += 1;
        self.queue.push(Reverse(Entry {
            at: at.max(self.now),
            seq,
            event,
        }));
    }

    /// Cycle of the earliest pending event, if any.
    pub fn next_deadline(&self) -> Option<Cycles> {
        self.queue.peek().map(|Reverse(e)| e.at)
    }

    /// Advance the clock to `to` (must not go backwards).
    pub fn advance_to(&mut self, to: Cycles) {
        debug_assert!(to >= self.now, "time went backwards");
        self.now = to.max(self.now);
    }

    /// Pop the next event whose deadline is `<= now`.
    pub fn pop_due(&mut self) -> Option<(Cycles, E)> {
        match self.queue.peek() {
            Some(Reverse(e)) if e.at <= self.now => {
                let Reverse(e) = self.queue.pop().unwrap();
                Some((e.at, e.event))
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fires_in_time_then_insertion_order() {
        let mut s = Scheduler::new();
        s.schedule_in(10, "b");
        s.schedule_in(5, "a");
        s.schedule_in(10, "c");
        assert_eq!(s.next_deadline(), Some(5));
        assert_eq!(s.pop_due(), None);
        s.advance_to(10);
        assert_eq!(s.pop_due(), Some((5, "a")));
        assert_eq!(s.pop_due(), Some((10, "b")));
        assert_eq!(s.pop_due(), Some((10, "c")));
        assert_eq!(s.pop_due(), None);
    }
}
