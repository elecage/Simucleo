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

// ------------------------------------------------- CubeMX HAL examples (M1)

fn hal_firmware(project: &str, name: &str) -> Vec<u8> {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "firmware",
        project,
        "build",
        &format!("{name}.elf"),
    ]
    .iter()
    .collect();
    std::fs::read(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (run `make -C firmware/{project}`)", path.display()))
}

/// Toggle times of LD2 (PA5) in milliseconds.
fn ld2_toggles_ms(board: &mut Nucleo) -> Vec<f64> {
    let events = board.take_pin_events();
    events
        .iter()
        .filter(|e| e.port == 0 && e.pin == 5)
        .map(|e| board.ns_at(e.time) / 1e6)
        .collect()
}

fn periods(t: &[f64]) -> Vec<f64> {
    t.windows(2).skip(1).map(|w| w[1] - w[0]).collect()
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-blinky (make variants)"]
fn hal_blinky_runs_at_84mhz_with_500ms_period() {
    for variant in ["hal-blinky", "hal-blinky-hse-bypass"] {
        let mut board = Nucleo::new();
        board
            .load_elf(&hal_firmware("hal-blinky", variant))
            .unwrap();
        let r = board.run_for_ns(2.2e9);
        assert!(
            board.diagnose(&r).is_none(),
            "{variant}: {:?}",
            board.diagnose(&r)
        );
        assert_eq!(board.clock_hz(), 84_000_000, "{variant}");
        let t = ld2_toggles_ms(&mut board);
        // HAL_Delay(500) waits 501 ticks of 1 ms.
        assert!(
            periods(&t).iter().all(|p| (p - 501.0).abs() < 0.5),
            "{variant}: {t:?}"
        );
        assert!(
            board.bus.warnings.is_empty(),
            "{variant}: {:?}",
            board.bus.warnings
        );

        // Hold B1: the loop switches to 100 ms.
        board.set_user_button(true);
        board.run_for_ns(1.1e9);
        let t = ld2_toggles_ms(&mut board);
        assert!(
            periods(&t).iter().all(|p| (p - 101.0).abs() < 0.5),
            "{variant} with B1: {t:?}"
        );
    }
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-blinky (make variants)"]
fn hse_without_bypass_ends_in_error_handler() {
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-blinky", "hal-blinky-hse-crystal"))
        .unwrap();
    let r = board.run_for_ns(1e9);
    assert_eq!(
        board.diagnose(&r),
        Some(simucleo_nucleo::Diagnosis::ErrorHandler {
            caller: Some("SystemClock_Config".into())
        })
    );
    // HSE_STARTUP_TIMEOUT is 100 ms of HAL ticks at 16 MHz.
    assert!(
        (100.0..110.0).contains(&(board.time_ns() / 1e6)),
        "{} ms",
        board.time_ns() / 1e6
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-uart-printf"]
fn hal_uart_printf_and_interrupt_echo() {
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-uart-printf", "hal-uart-printf"))
        .unwrap();
    board.run_for_ns(100e6);
    board.console_send(b"abc\r\n");
    let r = board.run_for_ns(900e6);
    assert!(board.diagnose(&r).is_none(), "{:?}", board.diagnose(&r));
    let out: Vec<u8> = board.take_console().iter().map(|b| b.byte).collect();
    let text = String::from_utf8_lossy(&out);
    assert!(
        text.starts_with(
            "Hello from Simucleo! SystemCoreClock = 84000000 Hz\r\nHCLK 84000000, PCLK1 42000000, PCLK2 84000000\r\n"
        ),
        "{text:?}"
    );
    assert!(text.contains("ABC\r\n"), "echo missing: {text:?}");
    assert!(
        text.contains("tick 0 at 2") && text.contains("tick 2 at "),
        "{text:?}"
    );
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
}

// --------------------------------------------- EXTI and timers (M3)

fn console_text(board: &mut Nucleo) -> String {
    let out: Vec<u8> = board.take_console().iter().map(|b| b.byte).collect();
    String::from_utf8_lossy(&out).into_owned()
}

/// (time in cycles, level) of a pin's changes.
fn edges(board: &mut Nucleo, port: u8, pin: u8) -> Vec<(u64, Option<bool>)> {
    board
        .take_pin_events()
        .into_iter()
        .filter(|e| e.port == port && e.pin == pin)
        .map(|e| (e.time, e.level))
        .collect()
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-button-exti"]
fn buttons_raise_exti_interrupts() {
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-button-exti", "hal-button-exti"))
        .unwrap();
    board.run_for_ns(50e6);
    assert!(!board.pin('A', 5));
    for (i, ld2) in [(1, true), (2, false)] {
        board.set_user_button(true);
        board.run_for_ns(20e6);
        board.set_user_button(false);
        board.run_for_ns(20e6);
        assert_eq!(board.pin('A', 5), ld2, "press {i}");
        assert!(
            console_text(&mut board).contains(&format!("B1 pressed ({i})")),
            "press {i}"
        );
    }
    // Button on D2 (PA10, internal pull-up) to GND toggles PA8.
    assert!(board.pin('A', 10), "pull-up holds D2 high");
    board.drive_pin(0, 10, Some(false));
    board.run_for_ns(20e6);
    board.drive_pin(0, 10, None);
    let r = board.run_for_ns(20e6);
    assert!(board.pin('A', 8));
    assert!(console_text(&mut board).contains("D2 pressed (1)"));
    assert!(board.diagnose(&r).is_none(), "{:?}", board.diagnose(&r));
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.bus.regs.accesses.is_empty(),
        "unmodelled: {:?}",
        board.bus.regs.accesses
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-pwm-led"]
fn pwm_led_runs_at_1khz_with_changing_duty() {
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-pwm-led", "hal-pwm-led"))
        .unwrap();
    board.run_for_ns(500e6);
    board.take_pin_events();
    board.run_for_ns(20e6);
    let e = edges(&mut board, 0, 5);
    let rises: Vec<u64> = e
        .iter()
        .filter(|x| x.1 == Some(true))
        .map(|x| x.0)
        .collect();
    assert!(rises.len() >= 18, "{e:?}");
    // 1 kHz at 84 MHz, exactly.
    assert!(rises.windows(2).all(|w| w[1] - w[0] == 84_000), "{rises:?}");
    // High time is a whole number of 1 µs timer ticks and below 100 %.
    for w in e.windows(2) {
        if w[0].1 == Some(true) {
            let high = w[1].0 - w[0].0;
            assert!(high % 84 == 0 && high < 84_000, "{high}");
        }
    }
    // The duty ramps: around 0.5 s it is about 50 %.
    let highs: Vec<u64> = e
        .windows(2)
        .filter(|w| w[0].1 == Some(true))
        .map(|w| w[1].0 - w[0].0)
        .collect();
    let duty = highs[0] as f64 / 84_000.0;
    assert!((0.4..0.6).contains(&duty), "duty {duty}");
    assert!(console_text(&mut board).contains("PWM: LD2 breathing"));
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.bus.regs.accesses.is_empty(),
        "unmodelled: {:?}",
        board.bus.regs.accesses
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-buzzer-melody"]
fn buzzer_plays_notes_on_tim1() {
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-buzzer-melody", "hal-buzzer-melody"))
        .unwrap();
    board.run_for_ns(100e6); // inside C4 (262 Hz)
    board.take_pin_events();
    board.run_for_ns(50e6);
    let rises: Vec<u64> = edges(&mut board, 0, 9)
        .iter()
        .filter(|x| x.1 == Some(true))
        .map(|x| x.0)
        .collect();
    // Period 1e6 / 262 = 3816 timer ticks of 1 µs.
    assert!(rises.len() >= 10, "{rises:?}");
    assert!(
        rises.windows(2).all(|w| w[1] - w[0] == 3816 * 84),
        "{rises:?}"
    );
    board.run_for_ns(2e9);
    let text = console_text(&mut board);
    assert!(text.contains("C4 D4 E4 F4 G4 A4 B4 C5 - G4"), "{text:?}");
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-button-exti"]
fn wired_switch_and_led_through_the_circuit_model() {
    use simucleo_nucleo::{BusCatalog, Circuit};
    use std::collections::HashMap;
    // Switch between D2 and GND; D7 → 330 Ω → LED → GND, on a breadboard
    // row each (the breadboard's buses join the leads).
    let circuit: Circuit = serde_json::from_value(serde_json::json!({
        "parts": [
            {"id": "nucleo", "kind": "nucleo-f401re"},
            {"id": "bb", "kind": "bb"},
            {"id": "sw1", "kind": "tact-switch"},
            {"id": "r1", "kind": "resistor", "props": {"ohms": "330"}},
            {"id": "led1", "kind": "led-5mm", "props": {"color": "red"}}
        ],
        "wires": [
            {"a": {"part": "nucleo", "pin": "D2"}, "b": {"part": "sw1", "pin": "1a"}},
            {"a": {"part": "sw1", "pin": "2b"}, "b": {"part": "nucleo", "pin": "GND_D"}},
            {"a": {"part": "nucleo", "pin": "D7"}, "b": {"part": "bb", "pin": "a1"}},
            {"a": {"part": "r1", "pin": "1"}, "b": {"part": "bb", "pin": "e1"}},
            {"a": {"part": "r1", "pin": "2"}, "b": {"part": "led1", "pin": "A"}},
            {"a": {"part": "led1", "pin": "K"}, "b": {"part": "nucleo", "pin": "GND_D"}}
        ]
    }))
    .unwrap();
    let catalog: BusCatalog = serde_json::from_value(serde_json::json!({
        "bb": [["a1", "b1", "c1", "d1", "e1"]],
        "tact-switch": [["1a", "1b"], ["2a", "2b"]]
    }))
    .unwrap();
    let signals: HashMap<String, String> = [("D2", "PA10"), ("D7", "PA8"), ("GND_D", "GND")]
        .into_iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();

    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-button-exti", "hal-button-exti"))
        .unwrap();
    board.set_circuit(&circuit, &catalog, &signals);
    board.run_for_ns(50e6);
    board.circuit_frame(0.05);
    for (i, lit) in [(1, true), (2, false)] {
        board.press("sw1", true);
        board.run_for_ns(20e6);
        board.press("sw1", false);
        board.run_for_ns(20e6);
        let v = board.circuit_frame(0.04);
        let led = v.iter().find(|p| p.id == "led1").unwrap();
        // (3.3 − 1.9) / (40 + 330 + 15) ≈ 3.6 mA: fully lit
        assert_eq!(led.brightness[0] > 0.5, lit, "press {i}: {led:?}");
        assert!(console_text(&mut board).contains(&format!("D2 pressed ({i})")));
    }
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
    // Hot-plug: remove the resistor → the LED is driven straight from PA8.
    let mut c2 = circuit.clone();
    c2.wires.retain(|w| w.a.part != "r1");
    c2.wires.push(
        serde_json::from_value(serde_json::json!(
            {"a": {"part": "bb", "pin": "b1"}, "b": {"part": "led1", "pin": "A"}}
        ))
        .unwrap(),
    );
    board.set_circuit(&c2, &catalog, &signals);
    board.press("sw1", true);
    board.run_for_ns(20e6);
    board.press("sw1", false);
    board.run_for_ns(20e6);
    let w = board.circuit_warnings();
    assert!(w.iter().any(|w| w.starts_with("led1:")), "{w:?}");
}

// ------------------------------------------------------- FreeRTOS (M4)

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/freertos-two-tasks"]
fn freertos_tasks_run_and_are_visible() {
    use simucleo_nucleo::TaskState;
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("freertos-two-tasks", "freertos-two-tasks"))
        .unwrap();
    let r = board.run_for_ns(2.2e9);
    assert!(board.diagnose(&r).is_none(), "{:?}", board.diagnose(&r));
    let text = console_text(&mut board);
    assert!(text.starts_with("FreeRTOS V11"), "{text:?}");
    assert!(
        text.contains("count 0 at 0 ms\r\ncount 1 at 1001 ms\r\ncount 2 at 2002 ms"),
        "{text:?}"
    );
    // LD2 from the Blink task: 500 ms ticks.
    let t = ld2_toggles_ms(&mut board);
    assert!(periods(&t).iter().all(|p| (p - 500.0).abs() < 1.0), "{t:?}");

    // B1 → EXTI → semaphore → Button task (higher priority) prints.
    board.set_user_button(true);
    board.run_for_ns(20e6);
    board.set_user_button(false);
    board.run_for_ns(20e6);
    let text = console_text(&mut board);
    assert!(text.contains("B1 pressed (1)\r\nflag received"), "{text:?}");

    let snap = board.rtos_snapshot().expect("FreeRTOS detected");
    assert!(snap.scheduler_running);
    let names: Vec<&str> = snap.tasks.iter().map(|t| t.name.as_str()).collect();
    for n in ["Blink", "Count", "Button", "Flags", "IDLE", "Tmr Svc"] {
        assert!(names.contains(&n), "{names:?}");
    }
    let task = |n: &str| snap.tasks.iter().find(|t| t.name == n).unwrap();
    // Between ticks everybody waits; the idle task runs.
    assert_eq!(task("IDLE").state, TaskState::Running);
    assert_eq!(task("Blink").state, TaskState::Blocked);
    assert_eq!(
        task("Button").state,
        TaskState::Blocked,
        "waits forever on the semaphore"
    );
    assert_eq!(
        task("Flags").state,
        TaskState::Blocked,
        "waits forever for a notification (thread flags)"
    );
    // ST's CMSIS-RTOS2 wrapper creates tasks at osPriority − 1.
    assert_eq!(task("Button").priority, 31); // osPriorityAboveNormal (32)
    assert_eq!(snap.api, Some("CMSIS-RTOS2"));
    assert_eq!(task("Blink").stack_size, Some(512));
    let free = task("Count").stack_free_min.unwrap();
    assert!(free > 0 && free < 1024, "{free}");

    // Context switches are logged: Blink runs every 500 ms at least.
    let switches = board.take_task_switches();
    let blink = task("Blink").tcb;
    assert!(switches.iter().any(|&(_, tcb)| tcb == blink));
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/freertos-queue-uart"]
fn freertos_queues_carry_uart_input_and_samples() {
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("freertos-queue-uart", "freertos-queue-uart"))
        .unwrap();
    board.run_for_ns(300e6);
    board.console_send(b"hello rtos\r");
    let r = board.run_for_ns(2e9);
    assert!(board.diagnose(&r).is_none(), "{:?}", board.diagnose(&r));
    let text = console_text(&mut board);
    assert!(text.contains("echo: HELLO RTOS\r\n"), "{text:?}");
    assert!(text.contains("sample 4 at 1000 ms"), "{text:?}");
    assert!(text.contains("heap free "), "{text:?}");
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
}
