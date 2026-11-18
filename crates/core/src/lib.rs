//! Core abstractions shared by every part of the simulator.
//!
//! * [`bus`]   – the memory/peripheral bus seen by the CPU.
//! * [`cpu`]   – the [`cpu::CpuBackend`] trait implemented by the Rust core
//!   (and, natively, by optional backends such as Unicorn).
//! * [`sched`] – a virtual-clock event scheduler. All timing in the simulator
//!   is expressed in CPU cycles, never in wall-clock time.

pub mod bus;
pub mod cpu;
pub mod sched;

/// Simulated time, in CPU clock cycles since reset.
pub type Cycles = u64;
