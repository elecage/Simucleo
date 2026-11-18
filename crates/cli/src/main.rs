//! `simucleo` – headless runner.
//!
//! ```text
//! simucleo info <firmware.elf>                 # segments, vector table, key symbols
//! simucleo run  <firmware.elf> [--ms <millis>]  # run and report pin changes
//! ```

use std::collections::BTreeMap;
use std::process::ExitCode;

use simucleo_core::bus::Bus;
use simucleo_core::cortexm::exc;
use simucleo_core::cpu::StopReason;
use simucleo_nucleo::Nucleo;
use simucleo_periph_stm32f4::map;

const USAGE: &str =
    "usage: simucleo info <firmware.elf>\n       simucleo run <firmware.elf> [--ms <millis>]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("info") if args.len() == 2 => info(&args[1]),
        Some("run") if args.len() >= 2 => {
            let ms = match args.get(2).map(String::as_str) {
                Some("--ms") => args.get(3).and_then(|v| v.parse().ok()),
                None => Some(1000),
                _ => None,
            };
            match ms {
                Some(ms) => run(&args[1], ms),
                None => Err(USAGE.into()),
            }
        }
        _ => Err(USAGE.into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn load(path: &str) -> Result<Nucleo, Box<dyn std::error::Error>> {
    let mut board = Nucleo::new();
    board.load_elf(&std::fs::read(path)?)?;
    Ok(board)
}

fn info(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut board = load(path)?;
    let fw = board.firmware.clone().unwrap();
    println!("entry: {:#010x}", fw.entry);
    for s in &fw.segments {
        println!(
            "segment: {:#010x} .. {:#010x} ({} bytes)",
            s.addr,
            s.addr + s.data.len() as u32,
            s.data.len()
        );
    }
    println!(
        "initial SP:    {:#010x}",
        board.bus.read_u32(map::FLASH_BASE)?
    );
    println!(
        "reset vector:  {:#010x}",
        board.bus.read_u32(map::FLASH_BASE + 4)?
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
    Ok(())
}

fn port_name(p: u8) -> char {
    (b'A' + p) as char
}

fn run(path: &str, ms: u64) -> Result<(), Box<dyn std::error::Error>> {
    let mut board = load(path)?;
    let hz = board.clock_hz() as u64;
    let started = std::time::Instant::now();
    let r = board.run(ms * hz / 1000);
    let wall = started.elapsed();
    let regs = board.cpu.registers();
    let sim_ms = board.now() as f64 * 1000.0 / hz as f64;

    println!(
        "backend: {}, simulated {:.3} ms ({} cycles at {} MHz) in {:.3} s ({:.1} MIPS-ish)",
        board.cpu.name(),
        sim_ms,
        board.now(),
        hz / 1_000_000,
        wall.as_secs_f64(),
        board.now() as f64 / wall.as_secs_f64().max(1e-9) / 1e6
    );
    let place = |pc: u32| {
        board
            .symbol_at(pc)
            .map(|s| format!(" <{s}>"))
            .unwrap_or_default()
    };
    match r.stop {
        StopReason::BudgetExhausted => println!(
            "still running at pc = {:#010x}{}",
            regs.pc(),
            place(regs.pc())
        ),
        StopReason::Sleeping => println!(
            "sleeping (WFI) at pc = {:#010x}{}",
            regs.pc(),
            place(regs.pc())
        ),
        StopReason::Unimplemented { pc, opcode } => {
            println!(
                "STOP: unimplemented instruction {opcode:#06x} at {pc:#010x}{}",
                place(pc)
            )
        }
        StopReason::Lockup { pc } => println!(
            "STOP: core lockup at {pc:#010x}{} (fault inside HardFault?)",
            place(pc)
        ),
        other => println!("STOP: {other:?}"),
    }
    let ipsr = regs.ipsr();
    if ipsr != 0 {
        println!("in exception handler: {}", exc::name(ipsr));
    }
    if board.sys.hfsr != 0 || board.sys.cfsr != 0 {
        println!(
            "fault status: HFSR={:#010x} CFSR={:#010x} BFAR={:#010x}",
            board.sys.hfsr, board.sys.cfsr, board.sys.bfar
        );
    }

    let events = board.take_pin_events();
    let mut per_pin: BTreeMap<(u8, u8), Vec<_>> = BTreeMap::new();
    for e in &events {
        per_pin.entry((e.port, e.pin)).or_default().push(*e);
    }
    for ((port, pin), evs) in per_pin {
        let to_ms = |t: u64| t as f64 * 1000.0 / hz as f64;
        let shown: Vec<String> = evs
            .iter()
            .take(6)
            .map(|e| {
                format!(
                    "{:.1}ms→{}",
                    to_ms(e.time),
                    match e.level {
                        Some(true) => "H",
                        Some(false) => "L",
                        None => "Z",
                    }
                )
            })
            .collect();
        println!(
            "P{}{:<2} {} changes: {}{}",
            port_name(port),
            pin,
            evs.len(),
            shown.join(", "),
            if evs.len() > 6 { ", …" } else { "" }
        );
    }

    let mut periph: BTreeMap<&str, usize> = BTreeMap::new();
    for a in &board.bus.unimplemented {
        *periph
            .entry(map::peripheral_name(a.addr).unwrap_or("?"))
            .or_default() += 1;
    }
    if !periph.is_empty() {
        let list: Vec<String> = periph.iter().map(|(n, c)| format!("{n}×{c}")).collect();
        println!(
            "accesses to peripherals not modelled yet: {}",
            list.join(", ")
        );
    }
    Ok(())
}
