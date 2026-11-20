//! External circuit model.
//!
//! The wiring editor sends a [`netlist::Circuit`] (placed parts + wires);
//! [`netlist::build_netlist`] collapses it into electrical nets, which the
//! component models in [`models`] then simulate against MCU pin states;
//! [`sim::CircuitSim`] solves the circuit electrically against the MCU's
//! pin drives.

pub mod devices;
pub mod models;
pub mod netlist;
pub mod sim;
pub mod thermocouple;
pub mod tier8;
pub mod tier9;
