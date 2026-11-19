//! `simucleo` – headless runner.
//!
//! ```text
//! simucleo info <firmware.elf>                 # segments, vector table, key symbols
//! simucleo run  <firmware.elf> [--ms <millis>] [--input <text>] [--baud <rate>]
//!     # run; print the ST-LINK virtual COM port (USART2), pin changes,
//!     # warnings and, if the firmware got stuck, why
//! simucleo gdb  <firmware.elf> [--port 3333]   # GDB remote server
//! ```

mod gdb;

use std::collections::{BTreeMap, BTreeSet};
use std::process::ExitCode;

use simucleo_core::bus::Bus;
use simucleo_core::cortexm::exc;
use simucleo_core::cpu::StopReason;
use simucleo_nucleo::Nucleo;
use simucleo_periph_stm32f4::{map, regmap};

const USAGE: &str = "usage: simucleo info <firmware.elf>
       simucleo run <firmware.elf> [--ms <millis>] [--input <text>] [--input-at <millis>] [--baud <terminal baud>]
       simucleo gdb <firmware.elf> [--port <tcp port, default 3333>]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("info") if args.len() == 2 => info(&args[1]),
        Some("gdb") if args.len() == 2 || (args.len() == 4 && args[2] == "--port") => {
            let port = args.get(3).and_then(|p| p.parse().ok()).unwrap_or(3333);
            load(&args[1]).and_then(|b| gdb::serve(b, port))
        }
        Some("run") if args.len() >= 2 => match parse_run_options(&args[2..]) {
            Some(opts) => run(&args[1], opts),
            None => Err(USAGE.into()),
        },
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

struct RunOptions {
    ms: f64,
    input: Option<String>,
    /// When to type the input (firmware must be listening by then).
    input_at_ms: f64,
    baud: Option<u32>,
}

fn parse_run_options(args: &[String]) -> Option<RunOptions> {
    let mut o = RunOptions {
        ms: 1000.0,
        input: None,
        input_at_ms: 100.0,
        baud: None,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--ms" => o.ms = it.next()?.parse().ok()?,
            "--input" => o.input = Some(it.next()?.replace("\\n", "\n").replace("\\r", "\r")),
            "--input-at" => o.input_at_ms = it.next()?.parse().ok()?,
            "--baud" => o.baud = Some(it.next()?.parse().ok()?),
            _ => return None,
        }
    }
    Some(o)
}

fn run(path: &str, opts: RunOptions) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::Write;
    let mut board = load(path)?;
    if let Some(b) = opts.baud {
        board.bus.usart[simucleo_nucleo::VCP].host_baud = b;
    }
    let mut pending_input = opts.input.clone();
    let started = std::time::Instant::now();
    let mut garbled = 0usize;
    let mut r = None;
    // Run in 10 ms slices so console output appears as it is produced.
    let slices = (opts.ms / 10.0).ceil().max(1.0) as u64;
    for _ in 0..slices {
        if board.time_ns() >= opts.input_at_ms * 1e6 {
            if let Some(text) = pending_input.take() {
                board.console_send(text.as_bytes());
            }
        }
        let res = board.run_for_ns(10e6);
        let out = board.take_console();
        garbled += out.iter().filter(|b| b.garbled).count();
        let bytes: Vec<u8> = out.iter().map(|b| b.byte).collect();
        std::io::stdout().write_all(&bytes)?;
        std::io::stdout().flush()?;
        if !matches!(res.stop, StopReason::BudgetExhausted | StopReason::Sleeping) {
            r = Some(res);
            break;
        }
    }
    let wall = started.elapsed();
    let regs = board.cpu.registers();
    println!();
    println!("---");
    println!(
        "backend: {}, simulated {:.3} ms in {:.3} s; core clock now {:.1} MHz",
        board.cpu.name(),
        board.time_ns() / 1e6,
        wall.as_secs_f64(),
        board.clock_hz() as f64 / 1e6
    );
    if garbled > 0 {
        let baud = board.bus.usart[simucleo_nucleo::VCP]
            .baud(&board.bus.clocks())
            .unwrap_or(0.0);
        println!(
            "virtual COM port: {garbled} bytes garbled — USART2 sends at {baud:.0} baud but the terminal listens at {}",
            board.bus.usart[simucleo_nucleo::VCP].host_baud
        );
    }
    match &r {
        Some(res) => match board.diagnose(res) {
            Some(d) => println!("STOP: {d}"),
            None => println!("STOP: {:?}", res.stop),
        },
        None => {
            let place = board
                .symbol_at(regs.pc())
                .map(|s| format!(" <{s}>"))
                .unwrap_or_default();
            println!("still running at pc = {:#010x}{place}", regs.pc());
        }
    }
    let ipsr = regs.ipsr();
    if ipsr != 0 {
        println!("in exception handler: {}", exc::name(ipsr));
    }

    for w in &board.bus.warnings {
        println!("warning: {w}");
    }

    let events = board.take_pin_events();
    let mut per_pin: BTreeMap<(u8, u8), Vec<_>> = BTreeMap::new();
    for e in &events {
        per_pin.entry((e.port, e.pin)).or_default().push(*e);
    }
    for ((port, pin), evs) in per_pin {
        let shown: Vec<String> = evs
            .iter()
            .take(6)
            .map(|e| {
                let level = match e.level {
                    Some(true) => "H",
                    Some(false) => "L",
                    None => "Z",
                };
                format!("{:.1}ms→{level}", board.ns_at(e.time) / 1e6)
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

    let mut periph: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for key in board.bus.regs.accesses.keys() {
        let name = regmap::describe(key.addr);
        let p = name.split('.').next().unwrap_or("?").to_string();
        periph.entry(p).or_default().insert(name);
    }
    if !periph.is_empty() {
        println!("peripherals used but not simulated yet (registers keep values, no behaviour):");
        for (p, regs) in periph {
            let list: Vec<&str> = regs
                .iter()
                .map(|s| s.split('.').nth(1).unwrap_or(s))
                .collect();
            println!("  {p}: {}", list.join(", "));
        }
    }
    Ok(())
}
