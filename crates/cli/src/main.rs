//! `simucleo` – headless runner.
//!
//! ```text
//! simucleo info <firmware.elf>   # show segments, vector table, key symbols
//! simucleo run  <firmware.elf>   # reset and run (stops at first unimplemented instruction for now)
//! ```

use std::process::ExitCode;

use simucleo_core::bus::Bus;
use simucleo_core::cpu::{CpuBackend, StopReason};
use simucleo_cpu_armv7m::ArmV7M;
use simucleo_elf::FirmwareImage;
use simucleo_periph_stm32f4::{map, Stm32f401Bus};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let (cmd, path) = match (args.get(1).map(String::as_str), args.get(2)) {
        (Some(c @ ("info" | "run")), Some(p)) => (c, p),
        _ => {
            eprintln!("usage: simucleo <info|run> <firmware.elf>");
            return ExitCode::from(2);
        }
    };
    match execute(cmd, path) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn execute(cmd: &str, path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let bytes = std::fs::read(path)?;
    let fw = FirmwareImage::parse(&bytes)?;
    let mut bus = Stm32f401Bus::new();
    for seg in &fw.segments {
        bus.load(seg.addr, &seg.data)?;
    }

    if cmd == "info" {
        println!("entry: {:#010x}", fw.entry);
        for s in &fw.segments {
            println!(
                "segment: {:#010x} .. {:#010x} ({} bytes)",
                s.addr,
                s.addr + s.data.len() as u32,
                s.data.len()
            );
        }
        println!("initial SP:    {:#010x}", bus.read_u32(map::FLASH_BASE)?);
        println!(
            "reset vector:  {:#010x}",
            bus.read_u32(map::FLASH_BASE + 4)?
        );
        for name in [
            "Reset_Handler",
            "main",
            "SystemInit",
            "Error_Handler",
            "HardFault_Handler",
            "vTaskStartScheduler",
        ] {
            if let Some(a) = fw.symbol(name) {
                println!("{name:<20} {a:#010x}");
            }
        }
        return Ok(());
    }

    let mut cpu = ArmV7M::new();
    cpu.reset(&mut bus, 0)?;
    let result = cpu.run(&mut bus, 1_000_000);
    let stop = match result.stop {
        StopReason::Unimplemented { pc, opcode } => {
            format!("unimplemented instruction {opcode:#06x} at {pc:#010x}")
        }
        other => format!("{other:?}"),
    };
    println!(
        "backend: {}, stopped after {} cycles: {stop}",
        cpu.name(),
        result.cycles
    );
    println!("pc = {:#010x}", cpu.registers().pc());
    Ok(())
}
