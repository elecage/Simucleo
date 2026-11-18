//! External circuit model.
//!
//! The wiring editor sends a [`netlist::Circuit`] (placed parts + wires);
//! [`netlist::build_netlist`] collapses it into electrical nets, which the
//! component models in [`models`] then simulate against MCU pin states.

pub mod models;
pub mod netlist;
