//! Runs the example firmware under `firmware/`. Build it first:
//! `make -C firmware/bare-blinky`, then
//! `cargo test -p simucleo-nucleo --test firmware -- --include-ignored`.

use std::path::PathBuf;

use simucleo_core::bus::Bus;
use simucleo_core::cpu::StopReason;
use simucleo_nucleo::Nucleo;

fn firmware(name: &str) -> Vec<u8> {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "firmware",
        name,
        "build",
        &format!("{name}.elf"),
    ]
    .iter()
    .collect();
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e} (run `make -C firmware/{name}` first)",
            path.display()
        )
    })
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/bare-blinky"]
fn bare_blinky_toggles_ld2() {
    let mut board = Nucleo::new();
    board.load_elf(&firmware("bare-blinky")).unwrap();
    let r = board.run(40_000_000);
    assert_eq!(
        r.stop,
        StopReason::BudgetExhausted,
        "stopped early at {:?}",
        board.symbol_at(board.cpu.registers().pc())
    );
    let toggles: Vec<_> = board
        .take_pin_events()
        .into_iter()
        .filter(|e| e.port == 0 && e.pin == 5)
        .collect();
    assert!(toggles.len() >= 4, "LD2 toggled {} times", toggles.len());
    // Alternating levels with a steady period.
    for w in toggles.windows(2).skip(1) {
        assert_ne!(w[0].level, w[1].level);
    }
    let periods: Vec<u64> = toggles
        .windows(2)
        .skip(1)
        .map(|w| w[1].time - w[0].time)
        .collect();
    assert!(
        periods.windows(2).all(|p| p[0].abs_diff(p[1]) < p[0] / 100),
        "periods {periods:?}"
    );
}

/// Names of the checks in `firmware/exceptions/main.c`, in order.
const EXCEPTION_CHECKS: [&str; 17] = [
    "SysTick interrupt counts",
    "WFI sleeps until the next SysTick",
    "SVC handler sees the immediate",
    "SVC returns a value through the stacked frame",
    "BASEPRI masks PendSV",
    "PendSV runs when BASEPRI is lowered",
    "nested IRQ preempts by priority",
    "tail-chaining in priority order",
    "IPR implements 4 priority bits",
    "thread mode runs on PSP",
    "EXC_RETURN 0xFFFFFFFD on PSP",
    "S0-S15 and FPSCR restored from the FP frame",
    "EXC_RETURN bit 4 clear with FP frame",
    "UsageFault on divide by zero (DIVBYZERO)",
    "HardFault escalation (FORCED)",
    "FreeRTOS-style PendSV switches tasks alternately",
    "FP registers survive task switches (S16-S31 in PendSV)",
];

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/exceptions"]
fn exception_model_self_test() {
    let mut board = Nucleo::new();
    board.load_elf(&firmware("exceptions")).unwrap();
    let fw = board.firmware.clone().unwrap();
    let done_addr = fw.symbol("checks_done").unwrap();
    let checks_addr = fw.symbol("checks").unwrap();
    let mut finished = false;
    for _ in 0..200 {
        let r = board.run(100_000);
        assert!(
            matches!(r.stop, StopReason::BudgetExhausted | StopReason::Sleeping),
            "stopped: {:?} at {:?}",
            r.stop,
            board.symbol_at(board.cpu.registers().pc())
        );
        if board.bus.read_u32(done_addr).unwrap() == 0xC0FFEE {
            finished = true;
            break;
        }
    }
    let failed: Vec<&str> = EXCEPTION_CHECKS
        .iter()
        .enumerate()
        .filter(|(i, _)| board.bus.read_u32(checks_addr + 4 * *i as u32).unwrap() != 1)
        .map(|(_, n)| *n)
        .collect();
    assert!(failed.is_empty(), "failed checks: {failed:#?}");
    assert!(
        finished,
        "self test did not finish (pc {:?})",
        board.symbol_at(board.cpu.registers().pc())
    );
}
