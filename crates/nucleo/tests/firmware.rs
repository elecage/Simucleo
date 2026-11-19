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

// ------------------------------------------------------- analog (M5)

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-adc-servo"]
fn adc_reads_the_circuit_and_drives_servo_and_motor() {
    use simucleo_nucleo::{BusCatalog, Circuit};
    use std::collections::HashMap;
    let circuit = |pot: f64, lux: f64| -> Circuit {
        serde_json::from_value(serde_json::json!({
            "parts": [
                {"id": "nucleo", "kind": "nucleo-f401re"},
                {"id": "pot", "kind": "potentiometer", "props": {"ohms": "10k", "position": pot}},
                {"id": "r1", "kind": "resistor", "props": {"ohms": "10k"}},
                {"id": "ldr", "kind": "ldr", "props": {"lux": lux}},
                {"id": "tmp", "kind": "temp-sensor", "props": {"temp": 30, "model": "TMP36"}},
                {"id": "sv", "kind": "servo"},
                {"id": "m", "kind": "dc-motor"}
            ],
            "wires": [
                {"a": {"part": "nucleo", "pin": "3V3"}, "b": {"part": "pot", "pin": "2"}},
                {"a": {"part": "pot", "pin": "1"}, "b": {"part": "nucleo", "pin": "GND"}},
                {"a": {"part": "pot", "pin": "W"}, "b": {"part": "nucleo", "pin": "A0"}},
                {"a": {"part": "nucleo", "pin": "3V3"}, "b": {"part": "r1", "pin": "1"}},
                {"a": {"part": "r1", "pin": "2"}, "b": {"part": "nucleo", "pin": "A1"}},
                {"a": {"part": "ldr", "pin": "1"}, "b": {"part": "nucleo", "pin": "A1"}},
                {"a": {"part": "ldr", "pin": "2"}, "b": {"part": "nucleo", "pin": "GND"}},
                {"a": {"part": "nucleo", "pin": "3V3"}, "b": {"part": "tmp", "pin": "VS"}},
                {"a": {"part": "tmp", "pin": "GND"}, "b": {"part": "nucleo", "pin": "GND"}},
                {"a": {"part": "tmp", "pin": "OUT"}, "b": {"part": "nucleo", "pin": "A2"}},
                {"a": {"part": "nucleo", "pin": "5V"}, "b": {"part": "sv", "pin": "V+"}},
                {"a": {"part": "sv", "pin": "GND"}, "b": {"part": "nucleo", "pin": "GND"}},
                {"a": {"part": "nucleo", "pin": "D9"}, "b": {"part": "sv", "pin": "SIG"}},
                {"a": {"part": "nucleo", "pin": "5V"}, "b": {"part": "m", "pin": "VCC"}},
                {"a": {"part": "m", "pin": "GND"}, "b": {"part": "nucleo", "pin": "GND"}},
                {"a": {"part": "nucleo", "pin": "D5"}, "b": {"part": "m", "pin": "IA"}},
                {"a": {"part": "nucleo", "pin": "D4"}, "b": {"part": "m", "pin": "IB"}}
            ]
        }))
        .unwrap()
    };
    let signals: HashMap<String, String> = [
        ("A0", "PA0"),
        ("A1", "PA1"),
        ("A2", "PA4"),
        ("D9", "PC7"),
        ("D5", "PB4"),
        ("D4", "PB5"),
    ]
    .into_iter()
    .map(|(a, b)| (a.to_string(), b.to_string()))
    .collect();
    let catalog = BusCatalog::default();

    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-adc-servo", "hal-adc-servo"))
        .unwrap();
    board.set_circuit(&circuit(0.75, 1000.0), &catalog, &signals);
    board.run_for_ns(100e6);
    board.circuit_frame(0.1);
    // Let the servo travel (0.1 s per 60°) frame by frame.
    for _ in 0..60 {
        board.run_for_ns(16e6);
        board.circuit_frame(0.016);
    }
    let text = console_text(&mut board);
    let last = text.lines().rev().find(|l| l.starts_with("pot")).unwrap();
    // pot 0.75 × 4096 ≈ 3071; TMP36 at 30 °C; bright light pulls A1 low.
    let pot: u32 = last.split_whitespace().nth(1).unwrap().parse().unwrap();
    assert!((3060..3080).contains(&pot), "{last}");
    assert!(
        last.contains("TMP36 30.0 C") || last.contains("TMP36 29.9 C"),
        "{last}"
    );
    assert!(last.contains("chip 25.0 C"), "{last}");
    let light: u32 = last
        .split('|')
        .nth(1)
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    assert!(light < 200, "{last}");
    let v = board.circuit_frame(0.016);
    let sv = v.iter().find(|p| p.id == "sv").unwrap();
    // 500 + 3071·2000/4095 ≈ 2000 µs → 135°.
    assert!((sv.angle.unwrap() - 135.0).abs() < 2.0, "{sv:?}");
    let m = v.iter().find(|p| p.id == "m").unwrap();
    assert!(m.rpm.unwrap() > 100.0, "bright: fast — {m:?}");

    // Turn the pot to the start: the servo swings back.
    board.set_circuit(&circuit(0.0, 1000.0), &catalog, &signals);
    for _ in 0..60 {
        board.run_for_ns(16e6);
        board.circuit_frame(0.016);
    }
    let v = board.circuit_frame(0.016);
    let sv = v.iter().find(|p| p.id == "sv").unwrap();
    assert!(sv.angle.unwrap() < 2.0, "{sv:?}");

    // A warmer die: the internal sensor follows (2.5 mV/°C).
    board.bus.adc.die_temp = 50.0;
    board.run_for_ns(600e6);
    let text = console_text(&mut board);
    let last = text.lines().rev().find(|l| l.starts_with("pot")).unwrap();
    let chip: f64 = last
        .split("chip ")
        .nth(1)
        .unwrap()
        .split(' ')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    assert!((chip - 50.0).abs() < 1.0, "{last}");
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

// --------------------------------------------------------- I2C (M6)

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-i2c-oled"]
fn i2c_clock_reads_rtc_and_sensor_and_draws_on_the_oled() {
    use simucleo_nucleo::{BusCatalog, Circuit};
    use std::collections::HashMap;
    let module = |id: &str| {
        serde_json::json!([
            {"a": {"part": "nucleo", "pin": "3V3"}, "b": {"part": id, "pin": "VCC"}},
            {"a": {"part": id, "pin": "GND"}, "b": {"part": "nucleo", "pin": "GND"}},
            {"a": {"part": "nucleo", "pin": "D15"}, "b": {"part": id, "pin": "SCL"}},
            {"a": {"part": "nucleo", "pin": "D14"}, "b": {"part": id, "pin": "SDA"}}
        ])
    };
    let mut wires = Vec::new();
    for id in ["oled", "rtc", "aht"] {
        wires.extend(module(id).as_array().unwrap().iter().cloned());
    }
    let circuit: Circuit = serde_json::from_value(serde_json::json!({
        "parts": [
            {"id": "nucleo", "kind": "nucleo-f401re"},
            {"id": "oled", "kind": "oled-ssd1306"},
            {"id": "rtc", "kind": "rtc-ds3231"},
            {"id": "aht", "kind": "aht20", "props": {"temp": 21.5, "humidity": 40}}
        ],
        "wires": wires
    }))
    .unwrap();
    let signals: HashMap<String, String> = [("D15", "PB8"), ("D14", "PB9")]
        .into_iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();

    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-i2c-oled", "hal-i2c-oled"))
        .unwrap();
    // 2030-06-15 08:59:58 UTC
    board.set_wall_clock(1_907_744_398.0);
    board.set_circuit(&circuit, &BusCatalog::default(), &signals);
    board.run_for_ns(3500e6);
    let text = console_text(&mut board);
    assert!(text.contains("scan: 0x38 0x3C 0x68"), "{text}");
    assert!(
        text.contains("2030-06-15 08:59:59 | 21.5 C 40.0 %RH"),
        "{text}"
    );
    assert!(text.contains("2030-06-15 09:00:01"), "{text}");

    let v = board.circuit_frame(3.5);
    let oled = v.iter().find(|p| p.id == "oled").unwrap();
    let screen = oled.screen.as_ref().expect("display on");
    assert!(screen.chars().any(|c| c != 'A'), "something drawn");
    assert_eq!(
        v.iter().find(|p| p.id == "rtc").unwrap().text.as_deref(),
        Some("2030-06-15 09:00:01")
    );
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );

    // B1 sets the seconds to 00.
    board.set_user_button(true);
    board.run_for_ns(200e6);
    board.set_user_button(false);
    board.run_for_ns(300e6);
    let text = console_text(&mut board);
    assert!(text.contains("seconds set to 00"), "{text}");
    assert!(text.contains("09:00:00"), "{text}");
}

// --------------------------------------------------------- SPI (M6)

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-spi-sd-logger"]
fn spi_sd_logger_formats_the_card_and_appends_csv_lines() {
    use simucleo_nucleo::{BusCatalog, Circuit};
    use std::collections::HashMap;
    let w = |a: (&str, &str), b: (&str, &str)| serde_json::json!({"a": {"part": a.0, "pin": a.1}, "b": {"part": b.0, "pin": b.1}});
    let n = "nucleo";
    let mut wires = vec![
        // SD card module (5 V, regulated on board)
        w((n, "5V"), ("sd", "VCC")),
        w(("sd", "GND"), (n, "GND")),
        w((n, "D13"), ("sd", "SCK")),
        w((n, "D12"), ("sd", "MISO")),
        w((n, "D11"), ("sd", "MOSI")),
        w((n, "D10"), ("sd", "CS")),
        // SPI OLED
        w((n, "3V3"), ("oled", "VCC")),
        w(("oled", "GND"), (n, "GND")),
        w((n, "D13"), ("oled", "D0")),
        w((n, "D11"), ("oled", "D1")),
        w((n, "D9"), ("oled", "CS")),
        w((n, "D8"), ("oled", "DC")),
        w((n, "D7"), ("oled", "RES")),
    ];
    for id in ["rtc", "aht"] {
        wires.push(w((n, "3V3"), (id, "VCC")));
        wires.push(w((id, "GND"), (n, "GND")));
        wires.push(w((n, "D15"), (id, "SCL")));
        wires.push(w((n, "D14"), (id, "SDA")));
    }
    let circuit: Circuit = serde_json::from_value(serde_json::json!({
        "parts": [
            {"id": "nucleo", "kind": "nucleo-f401re"},
            {"id": "sd", "kind": "sd-card", "props": {"size": 32}},
            {"id": "oled", "kind": "oled-ssd1306-spi"},
            {"id": "rtc", "kind": "rtc-ds3231"},
            {"id": "aht", "kind": "aht20", "props": {"temp": 19.0, "humidity": 55}}
        ],
        "wires": wires
    }))
    .unwrap();
    let signals: HashMap<String, String> = [
        ("D15", "PB8"),
        ("D14", "PB9"),
        ("D13", "PA5"),
        ("D12", "PA6"),
        ("D11", "PA7"),
        ("D10", "PB6"),
        ("D9", "PC7"),
        ("D8", "PA9"),
        ("D7", "PA8"),
    ]
    .into_iter()
    .map(|(a, b)| (a.to_string(), b.to_string()))
    .collect();

    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-spi-sd-logger", "hal-spi-sd-logger"))
        .unwrap();
    // 2026-03-01 12:00:00 UTC
    board.set_wall_clock(1_772_366_400.0);
    board.set_circuit(&circuit, &BusCatalog::default(), &signals);
    board.run_for_ns(3500e6);
    let text = console_text(&mut board);
    assert!(text.contains("blank card: formatting... done"), "{text}");
    assert!(text.contains("SD card: FAT16"), "{text}");
    assert!(text.contains("2026-03-01 12:00:02,19.0,55.0"), "{text}");
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
    let v = board.circuit_frame(3.5);
    assert!(v.iter().find(|p| p.id == "oled").unwrap().screen.is_some());

    // The log reads back, on the board and in the card image.
    board.set_user_button(true);
    board.run_for_ns(100e6);
    board.set_user_button(false);
    board.run_for_ns(200e6);
    let text = console_text(&mut board);
    assert!(text.contains("  time,temp_c,humidity_pct"), "{text}");
    let image = board.sd_image("sd").unwrap();
    assert_eq!(image.len(), 32 << 20);
    let hay = String::from_utf8_lossy(&image);
    assert!(hay.contains("LOG     CSV"), "directory entry");
    assert!(hay.contains("time,temp_c,humidity_pct\n2026-03-01 12:00:0"));

    // Power-cycle the board with the same card: the file is appended to.
    board
        .load_elf(&hal_firmware("hal-spi-sd-logger", "hal-spi-sd-logger"))
        .unwrap();
    board.set_circuit(&circuit, &BusCatalog::default(), &signals);
    board.run_for_ns(1500e6);
    let text = console_text(&mut board);
    assert!(!text.contains("formatting"), "{text}");
    assert!(text.contains("logging to LOG.CSV ("), "{text}");
    assert!(!text.contains("logging to LOG.CSV (0 bytes)"), "{text}");
}

// ------------------------------------------- DMA, input capture (M7)

fn wire_json(a: (&str, &str), b: (&str, &str)) -> serde_json::Value {
    serde_json::json!({"a": {"part": a.0, "pin": a.1}, "b": {"part": b.0, "pin": b.1}})
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-neopixel-dma"]
fn neopixel_ring_is_driven_by_timer_pwm_and_dma() {
    use simucleo_nucleo::{BusCatalog, Circuit};
    use std::collections::HashMap;
    let n = "nucleo";
    let circuit: Circuit = serde_json::from_value(serde_json::json!({
        "parts": [
            {"id": "nucleo", "kind": "nucleo-f401re"},
            {"id": "ring", "kind": "neopixel", "props": {"count": 12, "layout": "ring"}}
        ],
        "wires": [
            wire_json((n, "5V"), ("ring", "VCC")),
            wire_json(("ring", "GND"), (n, "GND")),
            wire_json((n, "D5"), ("ring", "DIN"))
        ]
    }))
    .unwrap();
    let signals: HashMap<String, String> = [("D5".to_string(), "PB4".to_string())].into();

    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-neopixel-dma", "hal-neopixel-dma"))
        .unwrap();
    board.set_circuit(&circuit, &BusCatalog::default(), &signals);
    board.run_for_ns(1100e6);
    let text = console_text(&mut board);
    let line = text.lines().find(|l| l.starts_with("frames")).expect(&text);
    let frames: u32 = line
        .split_whitespace()
        .nth(1)
        .unwrap()
        .trim_end_matches(',')
        .parse()
        .unwrap();
    assert!(frames > 30, "{line}");
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );

    // The ring shows the last frame the firmware computed: a rainbow at
    // brightness 32 with LED 0 matching the printed colour.
    let v = board.circuit_frame(1.1);
    let leds = &v.iter().find(|p| p.id == "ring").unwrap().leds;
    assert_eq!(leds.len(), 12);
    assert!(leds.iter().all(|&c| c != 0), "{leds:06X?}");
    let distinct: std::collections::BTreeSet<_> = leds.iter().collect();
    assert!(distinct.len() >= 10, "a rainbow: {leds:06X?}");
    assert!(leds
        .iter()
        .all(|&c| (c >> 16 & 0xFF) <= 32 && (c >> 8 & 0xFF) <= 32 && (c & 0xFF) <= 32));
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-dht-capture"]
fn dht22_is_read_with_input_capture() {
    use simucleo_nucleo::{BusCatalog, Circuit};
    use std::collections::HashMap;
    let n = "nucleo";
    let circuit = |model: &str, temp: f64| -> Circuit {
        serde_json::from_value(serde_json::json!({
            "parts": [
                {"id": "nucleo", "kind": "nucleo-f401re"},
                {"id": "dht", "kind": "dht", "props": {"model": model, "temp": temp, "humidity": 48.3}}
            ],
            "wires": [
                wire_json((n, "3V3"), ("dht", "VCC")),
                wire_json(("dht", "GND"), (n, "GND")),
                wire_json((n, "D3"), ("dht", "DATA"))
            ]
        }))
        .unwrap()
    };
    let signals: HashMap<String, String> = [("D3".to_string(), "PB3".to_string())].into();

    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-dht-capture", "hal-dht-capture"))
        .unwrap();
    board.set_circuit(&circuit("DHT22", -7.4), &BusCatalog::default(), &signals);
    board.run_for_ns(3200e6);
    let text = console_text(&mut board);
    assert!(
        text.contains("humidity 48.3 %  temperature -7.4 C"),
        "{text}"
    );
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );

    board.set_circuit(&circuit("DHT11", 23.6), &BusCatalog::default(), &signals);
    board.run_for_ns(2100e6);
    let text = console_text(&mut board);
    // The firmware decodes for a DHT22: a DHT11's bytes (48, 0, 23, 6)
    // come out as nonsense, the classic wrong-model mistake.
    assert!(
        text.contains("humidity 1228.8 %  temperature 589.4 C"),
        "{text}"
    );
}

// ------------------------------------------------- more parts (M8)

fn m8_circuit(parts: serde_json::Value, wires: Vec<serde_json::Value>) -> simucleo_nucleo::Circuit {
    let mut all = vec![serde_json::json!({"id": "nucleo", "kind": "nucleo-f401re"})];
    all.extend(parts.as_array().unwrap().iter().cloned());
    serde_json::from_value(serde_json::json!({"parts": all, "wires": wires})).unwrap()
}

/// Arduino header names → MCU signals (board pins named by signal pass through).
fn arduino_signals() -> std::collections::HashMap<String, String> {
    [
        ("D2", "PA10"),
        ("D3", "PB3"),
        ("D4", "PB5"),
        ("D5", "PB4"),
        ("D7", "PA8"),
        ("D10", "PB6"),
        ("D11", "PA7"),
        ("D12", "PA6"),
        ("D14", "PB9"),
        ("D15", "PB8"),
        ("A0", "PA0"),
    ]
    .into_iter()
    .map(|(a, b)| (a.to_string(), b.to_string()))
    .collect()
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-7seg-keypad"]
fn seven_segment_multiplexing_and_keypad() {
    use simucleo_nucleo::BusCatalog;
    let n = "nucleo";
    let mut wires = Vec::new();
    let mut parts = vec![
        serde_json::json!({"id": "disp", "kind": "seven-segment-4", "props": {"common": "cathode"}}),
        serde_json::json!({"id": "kp", "kind": "keypad-4x4"}),
    ];
    for (i, seg) in ["a", "b", "c", "d", "e", "f", "g", "dp"].iter().enumerate() {
        let r = format!("r{i}");
        parts.push(serde_json::json!({"id": r, "kind": "resistor", "props": {"ohms": "470"}}));
        wires.push(wire_json((n, &format!("PC{i}")), (&r, "1")));
        wires.push(wire_json((&r, "2"), ("disp", seg)));
    }
    for d in 0..4 {
        wires.push(wire_json(
            (n, &format!("PB{}", 12 + d)),
            ("disp", &format!("D{}", d + 1)),
        ));
    }
    for (i, pin) in ["PC8", "PC9", "PC10", "PC11"].iter().enumerate() {
        wires.push(wire_json((n, pin), ("kp", &format!("R{}", i + 1))));
    }
    for (i, pin) in ["PC12", "PD2", "PB1", "PB2"].iter().enumerate() {
        wires.push(wire_json((n, pin), ("kp", &format!("C{}", i + 1))));
    }
    let circuit = m8_circuit(serde_json::Value::Array(parts), wires);
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-7seg-keypad", "hal-7seg-keypad"))
        .unwrap();
    board.set_circuit(&circuit, &BusCatalog::default(), &arduino_signals());
    board.run_for_ns(100e6);
    board.circuit_frame(0.1);
    // Type 4, 2, then #.
    for key in ["kp:4", "kp:2", "kp:#"] {
        board.press(key, true);
        board.run_for_ns(60e6);
        board.press(key, false);
        board.run_for_ns(60e6);
    }
    let text = console_text(&mut board);
    assert!(
        text.contains("key 4\r\nkey 2\r\nvalue 42\r\nkey #"),
        "{text}"
    );
    board.circuit_frame(0.0);
    board.run_for_ns(40e6);
    let v = board.circuit_frame(0.04);
    let b = &v.iter().find(|p| p.id == "disp").unwrap().brightness;
    // Digits 3 and 4 show "4" (b, c, f, g) and "2" (a, b, d, e, g), each
    // lit a quarter of the time; digits 1 and 2 are blank.
    let lit = |d: usize| -> Vec<usize> { (0..8).filter(|&s| b[d * 8 + s] > 0.1).collect() };
    assert_eq!(lit(0), Vec::<usize>::new(), "{b:.2?}");
    assert_eq!(lit(2), [1, 2, 5, 6], "{b:.2?}");
    assert_eq!(lit(3), [0, 1, 3, 4, 6], "{b:.2?}");
    assert!(b[3 * 8] < 0.4, "multiplexed: a quarter duty, {b:.2?}");
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-encoder-stepper-lcd"]
fn encoder_turns_the_stepper_and_the_lcd_shows_it() {
    use simucleo_nucleo::BusCatalog;
    let n = "nucleo";
    let parts = serde_json::json!([
        {"id": "enc", "kind": "rotary-encoder"},
        {"id": "mot", "kind": "stepper-28byj48"},
        {"id": "lcd", "kind": "lcd-i2c", "props": {"address": "0x27"}},
        {"id": "r1", "kind": "resistor", "props": {"ohms": "10k"}},
        {"id": "ntc", "kind": "thermistor", "props": {"ohms": "10k", "temp": 40}}
    ]);
    let wires = vec![
        wire_json((n, "3V3"), ("enc", "+")),
        wire_json(("enc", "GND"), (n, "GND")),
        wire_json((n, "D12"), ("enc", "CLK")),
        wire_json((n, "D11"), ("enc", "DT")),
        wire_json((n, "D10"), ("enc", "SW")),
        wire_json((n, "5V"), ("mot", "VCC")),
        wire_json(("mot", "GND"), (n, "GND")),
        wire_json((n, "D2"), ("mot", "IN1")),
        wire_json((n, "D3"), ("mot", "IN2")),
        wire_json((n, "D4"), ("mot", "IN3")),
        wire_json((n, "D5"), ("mot", "IN4")),
        wire_json((n, "5V"), ("lcd", "VCC")),
        wire_json(("lcd", "GND"), (n, "GND")),
        wire_json((n, "D15"), ("lcd", "SCL")),
        wire_json((n, "D14"), ("lcd", "SDA")),
        wire_json((n, "3V3"), ("r1", "1")),
        wire_json(("r1", "2"), (n, "A0")),
        wire_json((n, "A0"), ("ntc", "1")),
        wire_json(("ntc", "2"), (n, "GND")),
    ];
    let circuit = m8_circuit(parts, wires);
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware(
            "hal-encoder-stepper-lcd",
            "hal-encoder-stepper-lcd",
        ))
        .unwrap();
    board.set_circuit(&circuit, &BusCatalog::default(), &arduino_signals());
    board.run_for_ns(300e6);
    // The driver's inputs float high at reset (PB4 has a pull-up): measure
    // from where the shaft is now.
    let start = board
        .circuit_frame(0.3)
        .iter()
        .find(|p| p.id == "mot")
        .unwrap()
        .angle
        .unwrap();
    // Two detents clockwise: 2/20 of a turn = 36°, 409 half steps.
    board.rotate("enc", 2);
    board.run_for_ns(2500e6);
    let text = console_text(&mut board);
    assert!(text.contains("detents 2 target 409"), "{text}");
    let v = board.circuit_frame(2.8);
    let mot = v.iter().find(|p| p.id == "mot").unwrap();
    let angle = (mot.angle.unwrap() - start).rem_euclid(360.0);
    // The first step may be lost: at reset the rotor sat on the coil the
    // pulled-up input energised, three half steps from where firmware starts.
    assert!(
        (angle - 409.0 * 360.0 / 4096.0).abs() <= 360.0 / 4096.0 + 1e-9,
        "{angle}"
    );
    let lcd = v
        .iter()
        .find(|p| p.id == "lcd")
        .unwrap()
        .lcd
        .clone()
        .unwrap();
    let row = |r: usize| String::from_utf8_lossy(&lcd.rows[r]).to_string();
    assert!(row(0).starts_with("Pos   35.9"), "{:?}", row(0));
    assert!(row(1).starts_with("NTC 40.0"), "{:?} (40 °C NTC)", row(1));
    assert_eq!(lcd.rows[1][9], 0, "custom degree sign");
    assert!(lcd.backlight);
    // Back one detent.
    board.rotate("enc", -1);
    board.run_for_ns(1000e6);
    let text = console_text(&mut board);
    assert!(text.contains("detents 1 target 204"), "{text}");
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-sonar-onewire"]
fn sonar_and_ds18b20_are_timed_in_microseconds() {
    use simucleo_nucleo::BusCatalog;
    let n = "nucleo";
    let circuit = |cm: f64| {
        m8_circuit(
            serde_json::json!([
                {"id": "us", "kind": "hc-sr04", "props": {"distance": cm}},
                {"id": "ds", "kind": "ds18b20", "props": {"temp": -3.25}}
            ]),
            vec![
                wire_json((n, "5V"), ("us", "VCC")),
                wire_json(("us", "GND"), (n, "GND")),
                wire_json((n, "D7"), ("us", "TRIG")),
                wire_json((n, "D3"), ("us", "ECHO")),
                wire_json((n, "3V3"), ("ds", "VDD")),
                wire_json(("ds", "GND"), (n, "GND")),
                wire_json((n, "D2"), ("ds", "DQ")),
            ],
        )
    };
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-sonar-onewire", "hal-sonar-onewire"))
        .unwrap();
    board.set_circuit(&circuit(123.4), &BusCatalog::default(), &arduino_signals());
    board.run_for_ns(2200e6);
    let text = console_text(&mut board);
    assert!(text.contains("DS18B20 ROM 28-"), "{text}");
    assert!(text.contains("CRC ok"), "{text}");
    assert!(
        text.contains("distance 123.4 cm | temperature -3.25 C"),
        "{text}"
    );
    board.set_circuit(&circuit(7.0), &BusCatalog::default(), &arduino_signals());
    board.run_for_ns(2200e6);
    let text = console_text(&mut board);
    assert!(text.contains("distance 7.0 cm"), "{text}");
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

// ----------------------------------------------- source-level debugging (M9)

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-7seg-keypad"]
fn breakpoints_steps_call_stack_and_variables() {
    use simucleo_nucleo::{Step, StepEnd};
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-7seg-keypad", "hal-7seg-keypad"))
        .unwrap();
    let info = board.debug_info().expect("DWARF");
    let main_c = info
        .files
        .iter()
        .position(|f| f.ends_with("hal-7seg-keypad/main.c"))
        .unwrap() as u32;
    let line = |b: &Nucleo| {
        b.debug_info()
            .unwrap()
            .location(b.cpu.registers().pc())
            .map(|l| l.1)
    };
    let func = |b: &Nucleo| b.call_stack().first().and_then(|f| f.function.clone());

    // Break on SystemClock_Config(); (line 92).
    let (l, addrs) = info.breakpoint_addresses(main_c, 92).unwrap();
    assert_eq!(l, 92);
    board.set_breakpoints(&addrs);
    let r = board.run_for_ns(100e6);
    assert!(
        matches!(r.stop, simucleo_core::cpu::StopReason::Breakpoint(_)),
        "{r:?}"
    );
    assert_eq!(line(&board), Some(92));

    // Over: the clock set-up runs, we are on the next line.
    assert_eq!(board.step(Step::Over), StepEnd::Done);
    assert_eq!(line(&board), Some(93));
    assert_eq!(board.clock_hz(), 84_000_000, "SystemClock_Config ran");
    // Into MX_GPIO_Init, then out again.
    assert_eq!(board.step(Step::Into), StepEnd::Done);
    assert_eq!(func(&board).as_deref(), Some("MX_GPIO_Init"));
    let stack: Vec<_> = board
        .call_stack()
        .iter()
        .map(|f| f.function.clone().unwrap_or_default())
        .collect();
    assert_eq!(stack[..2], ["MX_GPIO_Init", "main"]);
    assert_eq!(board.step(Step::Out), StepEnd::Done);
    assert_eq!(func(&board).as_deref(), Some("main"));
    // Instruction steps move the pc.
    let pc = board.cpu.registers().pc();
    assert_eq!(board.step(Step::Instruction), StepEnd::Done);
    assert_ne!(board.cpu.registers().pc(), pc);

    // Run on to the keypad loop and read variables.
    board.set_breakpoints(&[]);
    let (_, addrs) = board
        .debug_info()
        .unwrap()
        .breakpoint_addresses(main_c, 102)
        .unwrap();
    board.set_breakpoints(&addrs);
    let r = board.run_for_ns(100e6);
    assert!(
        matches!(r.stop, simucleo_core::cpu::StopReason::Breakpoint(_)),
        "{r:?}"
    );
    let locals = board.locals(0);
    let names: Vec<&str> = locals.iter().map(|v| v.name.as_str()).collect();
    assert!(
        names.contains(&"value") && names.contains(&"len"),
        "{names:?}"
    );
    let globals = board.globals(&[main_c]);
    let keys = globals.iter().find(|g| g.name == "KEYS").unwrap();
    assert_eq!(keys.ty, "const char[4][4]");
    assert_eq!(keys.children[1].value, "\"456B\"");
    let htim = globals.iter().find(|g| g.name == "htim10").unwrap();
    let inst = htim.children.iter().find(|c| c.name == "Instance").unwrap();
    assert_eq!(inst.value, "0x40014400");
    // Watch expressions.
    let info = board.debug_info().unwrap();
    let frame = board.call_stack()[0].clone();
    let read = |a: u32, n: usize| -> Option<Vec<u8>> {
        (0..n as u32).map(|i| board.peek_byte(a + i)).collect()
    };
    let ev = |e: &str| info.evaluate(e, &frame, &read).map(|v| v.value);
    assert_eq!(ev("KEYS[1][3]").unwrap(), "66 'B'");
    assert_eq!(ev("KEYS[2]").unwrap(), "\"789C\"");
    assert_eq!(ev("FONT[8] == 0x7F").unwrap(), "1");
    assert_eq!(ev("(FONT[1] + 2) * 3").unwrap(), "24");
    assert_eq!(ev("htim10.Instance").unwrap(), "0x40014400");
    assert_eq!(ev("htim10.Instance->ARR").unwrap(), "999");
    assert_eq!(ev("htim10.Init.Period + 1").unwrap(), "1000");
    assert_eq!(ev("value").unwrap(), "0");
    assert!(ev("nosuch").is_err());
    assert!(ev("KEYS[9][0]").unwrap_err().contains("out of range"));
    assert!(info
        .condition("len == 0 && current >= 0", &frame, &read)
        .unwrap());
    assert!(!info.condition("KEYS[0][0] != '1'", &frame, &read).unwrap());
    // Short-circuit: the right side is not needed (and fails).
    assert!(!info.condition("len != 0 && nosuch", &frame, &read).unwrap());
    assert!(info.condition("len == 0 || nosuch", &frame, &read).unwrap());
    assert!(info.condition("len == 0 && nosuch", &frame, &read).is_err());
    // The skipped side is parsed whole, not cut short by its error.
    assert_eq!(ev("0 && KEYS[9] + 1").unwrap(), "0");
    assert_eq!(ev("1 || KEYS[9][0] * (nosuch->x + 2)").unwrap(), "1");
    assert_eq!(ev("(0 && nosuch) + 5").unwrap(), "5");
    assert!(ev("0 && (1 +").is_err(), "syntax errors still count");
    drop(info);

    // Setting variables: a local, a struct member, a peripheral register
    // through a pointer, an array element; the program sees the change.
    // Here `value` is a known constant: nothing to write to.
    assert!(board
        .set_variable("value", "1234", 0)
        .unwrap_err()
        .contains("no storage"));
    assert_eq!(
        board
            .set_variable("htim10.Init.Period", "499", 0)
            .unwrap()
            .value,
        "499"
    );
    // (A smaller ARR than the counter would make the timer count all the
    // way round, as on the chip: go up, then back.)
    assert_eq!(
        board
            .set_variable("htim10.Instance->ARR", "1999", 0)
            .unwrap()
            .value,
        "1999"
    );
    assert_eq!(
        board.peek_byte(0x4001_442C),
        Some(0xCF),
        "TIM10 ARR low byte"
    );
    assert_eq!(
        board
            .set_variable("htim10.Instance->ARR", "999", 0)
            .unwrap()
            .value,
        "999"
    );
    assert_eq!(
        board.set_variable("digits[2]", "FONT[8]", 0).unwrap().value,
        "127"
    );
    assert!(board
        .set_variable("digits[0]", "300", 0)
        .unwrap_err()
        .contains("does not fit"));
    assert!(board.set_variable("htim10", "1", 0).is_err());
    assert!(board.set_variable("1 + 2", "3", 0).is_err());

    // A parameter in a register: show_number(n, len) at its entry has n in
    // r0. Setting it changes what the function shows.
    let show = board
        .debug_info()
        .unwrap()
        .functions
        .iter()
        .find(|f| f.name == "show_number")
        .unwrap()
        .low;
    board.set_breakpoints(&[show]);
    let r = board.run_for_ns(10e6);
    assert!(
        matches!(r.stop, simucleo_core::cpu::StopReason::Breakpoint(_)),
        "{r:?}"
    );
    assert_eq!(info_write_kind(&board, "n"), "register");
    assert_eq!(board.set_variable("n", "4321", 0).unwrap().value, "4321");
    assert_eq!(board.cpu.registers().r[0], 4321);
    assert_eq!(board.set_variable("len", "4", 0).unwrap().value, "4");
    board.set_breakpoints(&[]);
    board.step(Step::Out);
    let digits = board.evaluate("digits", 0).unwrap();
    let shown: Vec<&str> = digits.children.iter().map(|c| c.value.as_str()).collect();
    // FONT[4], FONT[3], FONT[2], FONT[1] (102, 79, 91, 6), left to right.
    assert_eq!(shown, ["102", "79", "91", "6"], "{digits:?}");

    // A breakpoint inside the timer interrupt shows the interrupted code.
    board.set_breakpoints(&[]);
    let cb = board
        .debug_info()
        .unwrap()
        .functions
        .iter()
        .find(|f| f.name == "HAL_TIM_PeriodElapsedCallback")
        .unwrap()
        .low;
    board.set_breakpoints(&[cb]);
    board.run_for_ns(10e6);
    let stack = board.call_stack();
    assert_eq!(
        stack[0].function.as_deref(),
        Some("HAL_TIM_PeriodElapsedCallback")
    );
    assert!(
        stack.iter().any(|f| f.exception),
        "an exception frame: {stack:?}"
    );
    assert!(
        stack.iter().any(|f| f.function.as_deref() == Some("main")),
        "{stack:?}"
    );
    // Data watchpoints: writes to `current` happen only in the callback,
    // right after it computes the next digit.
    board.set_breakpoints(&[]);
    use simucleo_core::cpu::{WatchKind, Watchpoint};
    let (addr, len) = board.address_of("current", 0).unwrap();
    assert_eq!(len, 4);
    assert_eq!(board.address_of("digits[2]", 0).unwrap().1, 1);
    assert_eq!(board.address_of("KEYS[1]", 0).unwrap().1, 4);
    assert_eq!(board.address_of("htim10.Init", 0).unwrap().1, 24);
    assert!(board.address_of("1 + 2", 0).is_err());
    board.set_watchpoints(&[Watchpoint {
        addr,
        len,
        kind: WatchKind::Write,
    }]);
    let before = board
        .evaluate("current", 0)
        .unwrap()
        .value
        .parse::<i64>()
        .unwrap();
    let r = board.run_for_ns_debug(10e6);
    assert_eq!(
        r.stop,
        simucleo_core::cpu::StopReason::Watchpoint { addr, write: true }
    );
    assert_eq!(
        func(&board).as_deref(),
        Some("HAL_TIM_PeriodElapsedCallback")
    );
    assert_eq!(line(&board), Some(47), "stopped after the store on line 46");
    let after = board
        .evaluate("current", 0)
        .unwrap()
        .value
        .parse::<i64>()
        .unwrap();
    assert_eq!(after, (before + 1) & 3);
    // A read watchpoint on the digit patterns: line 47 reads one.
    let (daddr, dlen) = board.address_of("digits", 0).unwrap();
    board.set_watchpoints(&[Watchpoint {
        addr: daddr,
        len: dlen,
        kind: WatchKind::Read,
    }]);
    let r = board.run_for_ns_debug(10e6);
    assert!(
        matches!(r.stop, simucleo_core::cpu::StopReason::Watchpoint { addr: a, write: false } if (daddr..daddr + 4).contains(&a)),
        "{r:?}"
    );
    // Stepping: the rest of this callback no longer writes `current`;
    // stepping over line 46 next time does.
    board.set_watchpoints(&[Watchpoint {
        addr,
        len,
        kind: WatchKind::Write,
    }]);
    assert_eq!(board.step(Step::Out), StepEnd::Done);
    board.set_watchpoints(&[]);
    let (_, l46) = board
        .debug_info()
        .unwrap()
        .breakpoint_addresses(main_c, 46)
        .unwrap();
    board.set_breakpoints(&l46);
    let r = board.run_for_ns_debug(10e6);
    assert!(
        matches!(r.stop, simucleo_core::cpu::StopReason::Breakpoint(_)),
        "{r:?}"
    );
    board.set_breakpoints(&[]);
    board.set_watchpoints(&[Watchpoint {
        addr,
        len,
        kind: WatchKind::Write,
    }]);
    assert_eq!(
        board.step(Step::Over),
        StepEnd::Watchpoint { addr, write: true }
    );
    board.set_watchpoints(&[]);

    // Conditional breakpoints: the timer callback runs every millisecond
    // and steps `current` through 0..3; stop only where it is 2.
    let bp = |c: &str| [(cb, Some(c.to_string()))];
    board.set_conditional_breakpoints(&bp("current == 2"));
    for _ in 0..3 {
        let r = board.run_for_ns_debug(10e6);
        assert!(
            matches!(r.stop, simucleo_core::cpu::StopReason::Breakpoint(a) if a == cb & !1),
            "{r:?}"
        );
        assert_eq!(board.evaluate("current", 0).unwrap().value, "2");
    }
    // Never true: it runs the whole time.
    board.set_conditional_breakpoints(&bp("current > 3"));
    let t = board.time_ns();
    let r = board.run_for_ns_debug(5e6);
    assert!(
        !matches!(r.stop, simucleo_core::cpu::StopReason::Breakpoint(_)),
        "{r:?}"
    );
    assert!(board.time_ns() - t >= 5e6 - 1e3);
    // A false hit right at the end of the time budget is not a stop either
    // (the next hit comes 1 ms after this one: end the run on, just before
    // and just after it, a cycle at a time).
    board.set_conditional_breakpoints(&bp("current == 2"));
    board.run_for_ns_debug(10e6);
    board.set_conditional_breakpoints(&bp("current > 3"));
    let cycle = 1e9 / board.clock_hz() as f64;
    for k in -4..=4 {
        let r = board.run_for_ns_debug(1e6 + k as f64 * cycle);
        assert!(
            !matches!(r.stop, simucleo_core::cpu::StopReason::Breakpoint(_)),
            "k = {k}: {r:?}"
        );
        // Back to the callback for the next try.
        board.set_conditional_breakpoints(&bp("current == 2"));
        board.run_for_ns_debug(10e6);
        board.set_conditional_breakpoints(&bp("current > 3"));
    }
    // A condition that cannot be evaluated stops (to show the error).
    board.set_conditional_breakpoints(&bp("nosuch == 1"));
    let r = board.run_for_ns_debug(5e6);
    assert!(
        matches!(r.stop, simucleo_core::cpu::StopReason::Breakpoint(_)),
        "{r:?}"
    );
    assert!(board.evaluate("nosuch", 0).is_err());
    // Two conditions at one address: it stops when either holds.
    board.set_conditional_breakpoints(&[
        (cb, Some("current == 1".into())),
        (cb, Some("current == 3".into())),
    ]);
    let mut seen = Vec::new();
    for _ in 0..4 {
        let r = board.run_for_ns_debug(10e6);
        assert!(
            matches!(r.stop, simucleo_core::cpu::StopReason::Breakpoint(_)),
            "{r:?}"
        );
        seen.push(board.evaluate("current", 0).unwrap().value);
    }
    assert_eq!(seen, ["1", "3", "1", "3"]);
    // An unconditional breakpoint at the same address wins.
    board.set_conditional_breakpoints(&[(cb, Some("current > 3".into())), (cb, None)]);
    let r = board.run_for_ns_debug(5e6);
    assert!(
        matches!(r.stop, simucleo_core::cpu::StopReason::Breakpoint(_)),
        "{r:?}"
    );
}

/// Whether a variable is set in memory or in a register (for the log).
fn info_write_kind(board: &Nucleo, name: &str) -> &'static str {
    let info = board.debug_info().unwrap();
    let frame = board.call_stack()[0].clone();
    let read = |a: u32, n: usize| -> Option<Vec<u8>> {
        (0..n as u32).map(|i| board.peek_byte(a + i)).collect()
    };
    match info.assignment(name, "0", &frame, &read) {
        Ok(simucleo_elf::debug::Write::Memory { .. }) => "memory",
        Ok(simucleo_elf::debug::Write::Register { .. }) => "register",
        Err(_) => "neither",
    }
}
