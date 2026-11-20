//! Runs the example firmware under `firmware/`. Build it first:
//! `make -C firmware/bare-blinky`, then
//! `cargo test -p simucleo-nucleo --test firmware -- --include-ignored`.

use std::path::PathBuf;

use simucleo_core::bus::Bus;
use simucleo_core::cpu::StopReason;
use simucleo_nucleo::Nucleo;

#[path = "support/web_project.rs"]
mod web_project;

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
#[ignore = "needs arm-none-eabi-gcc build of firmware/lesson-blink-2hz"]
fn lesson_blink_2hz_solution_toggles_every_250ms() {
    // The solution firmware of the "upload your own" lesson (M16): the web
    // grader expects a 500 ms period ± 5 % on PA5.
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("lesson-blink-2hz", "lesson-blink-2hz"))
        .unwrap();
    let r = board.run_for_ns(2.2e9);
    assert!(board.diagnose(&r).is_none(), "{:?}", board.diagnose(&r));
    let t = ld2_toggles_ms(&mut board);
    assert!(t.len() >= 8, "{t:?}");
    // HAL_Delay(250) waits 251 ticks of 1 ms.
    assert!(periods(&t).iter().all(|p| (p - 251.0).abs() < 0.5), "{t:?}");
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

    // Each waiting task's call stack, from the context saved on its stack:
    // where it waits, called from its task function.
    let stack = |b: &Nucleo, n: &str| -> Vec<String> {
        b.task_call_stack(task(n).tcb)
            .iter()
            .map(|f| f.function.clone().unwrap_or_default())
            .collect()
    };
    for (name, wait, func) in [
        ("Blink", "osDelay", "BlinkTask"),
        ("Count", "osDelay", "CountTask"),
        ("Button", "osSemaphoreAcquire", "ButtonTask"),
        ("Flags", "osThreadFlagsWait", "FlagsTask"),
    ] {
        let s = stack(&board, name);
        let w = s.iter().position(|f| f == wait);
        let t = s.iter().position(|f| f == func);
        assert!(
            matches!((w, t), (Some(w), Some(t)) if w + 1 == t),
            "{name}: {s:?}"
        );
        assert_eq!(
            s.last().map(String::as_str),
            Some(func),
            "ends at the task function: {s:?}"
        );
    }
    // The running task's stack is the CPU's.
    let pcs = |f: Vec<simucleo_elf::debug::Frame>| f.iter().map(|f| f.pc).collect::<Vec<_>>();
    assert_eq!(
        pcs(board.task_call_stack(task("IDLE").tcb)),
        pcs(board.call_stack())
    );
    // Looking at a task: its locals and expressions in its frames.
    board.select_task(Some(task("Count").tcb));
    let frames = board.viewed_stack();
    let i = frames
        .iter()
        .position(|f| f.function.as_deref() == Some("CountTask"))
        .unwrap();
    let n = board.locals(i).into_iter().find(|v| v.name == "n").unwrap();
    assert_eq!(n.value, "3", "count 0, 1 and 2 printed");
    assert_eq!(board.evaluate("n * 10", i).unwrap().value, "30");
    // Its registers are saved, not live: they cannot be set.
    assert!(board
        .set_variable("n", "7", i)
        .unwrap_err()
        .contains("task switch"));
    board.select_task(None);
    assert_eq!(pcs(board.viewed_stack()), pcs(board.call_stack()));

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

// ------------------------------------------------ IMU, matrix, IR (M13)

fn imu_matrix_circuit(roll: f64, pitch: f64) -> simucleo_nucleo::Circuit {
    imu_matrix_circuit_shaken(roll, pitch, 0.0)
}

/// Two separate MAX7219 parts: `mx` on SPI1, `bar` on mx's DOUT with the
/// same CLK and CS. `ay` is a shake along Y (g).
fn imu_matrix_circuit_shaken(roll: f64, pitch: f64, ay: f64) -> simucleo_nucleo::Circuit {
    let n = "nucleo";
    m8_circuit(
        serde_json::json!([
            {"id": "imu", "kind": "mpu6050", "props": {"roll": roll, "pitch": pitch, "gz": 12.5, "temp": 28.0, "ay": ay}},
            {"id": "mx", "kind": "max7219", "props": {"count": 1}},
            {"id": "bar", "kind": "max7219", "props": {"count": 1}}
        ]),
        vec![
            wire_json((n, "3V3"), ("imu", "VCC")),
            wire_json(("imu", "GND"), (n, "GND")),
            wire_json((n, "D15"), ("imu", "SCL")),
            wire_json((n, "D14"), ("imu", "SDA")),
            wire_json((n, "5V"), ("mx", "VCC")),
            wire_json(("mx", "GND"), (n, "GND")),
            wire_json((n, "D13"), ("mx", "CLK")),
            wire_json((n, "D11"), ("mx", "DIN")),
            wire_json((n, "D10"), ("mx", "CS")),
            wire_json((n, "5V"), ("bar", "VCC")),
            wire_json(("bar", "GND"), (n, "GND")),
            wire_json(("mx", "DOUT"), ("bar", "DIN")),
            wire_json(("mx", "CLK"), ("bar", "CLK")),
            wire_json(("mx", "CS"), ("bar", "CS")),
        ],
    )
}

/// Rows of the MAX7219 part `id`.
fn matrix_rows(board: &mut Nucleo, id: &str) -> Vec<u8> {
    let v = board.circuit_frame(0.1);
    let m = v
        .iter()
        .find(|p| p.id == id)
        .unwrap()
        .matrix
        .clone()
        .expect("matrix view");
    assert_eq!(m.intensity, [4]);
    m.rows
}

/// The matrix's lit dot as (row, column), bit 7 the left column.
fn matrix_dot(board: &mut Nucleo) -> Vec<(usize, usize)> {
    let rows = matrix_rows(board, "mx");
    let mut dots = Vec::new();
    for (r, row) in rows.iter().enumerate() {
        for c in 0..8 {
            if row & (0x80 >> c) != 0 {
                dots.push((r, c));
            }
        }
    }
    dots
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-imu-matrix"]
fn mpu6050_tilt_moves_the_dot_on_the_max7219_matrix() {
    use simucleo_nucleo::BusCatalog;
    let mut signals = arduino_signals();
    signals.insert("D13".into(), "PA5".into());
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-imu-matrix", "hal-imu-matrix"))
        .unwrap();
    board.set_circuit(
        &imu_matrix_circuit(0.0, 0.0),
        &BusCatalog::default(),
        &signals,
    );
    board.run_for_ns(400e6);
    let text = console_text(&mut board);
    assert!(text.contains("WHO_AM_I 0x68\r\n"), "{text}");
    assert!(
        text.contains("roll 0.0 pitch 0.0 | gyro 0.0 0.0 12.5 dps | 28.0 C | dot row 3 col 3"),
        "{text}"
    );
    assert_eq!(matrix_dot(&mut board), [(3, 3)]);

    // Tilt left and forward: the readings follow, the dot rolls.
    board.set_circuit(
        &imu_matrix_circuit(-30.0, 20.0),
        &BusCatalog::default(),
        &signals,
    );
    board.run_for_ns(300e6);
    let text = console_text(&mut board);
    assert!(text.contains("roll -30.0 pitch 20.0 |"), "{text}");
    let line = text.lines().rev().find(|l| l.starts_with("roll")).unwrap();
    assert!(line.ends_with("dot row 5 col 1 | |a| 1.00 g"), "{line}");
    assert_eq!(matrix_dot(&mut board), [(5, 1)]);

    board.set_circuit(
        &imu_matrix_circuit(90.0, -45.0),
        &BusCatalog::default(),
        &signals,
    );
    board.run_for_ns(300e6);
    let text = console_text(&mut board);
    assert!(text.contains("roll 90.0 pitch -45.0 |"), "{text}");
    assert_eq!(matrix_dot(&mut board), [(0, 7)]);
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-imu-matrix"]
fn second_max7219_part_on_dout_shows_the_shake_bar() {
    use simucleo_nucleo::BusCatalog;
    let mut signals = arduino_signals();
    signals.insert("D13".into(), "PA5".into());
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-imu-matrix", "hal-imu-matrix"))
        .unwrap();
    board.set_circuit(
        &imu_matrix_circuit(0.0, 0.0),
        &BusCatalog::default(),
        &signals,
    );
    board.run_for_ns(400e6);
    let text = console_text(&mut board);
    assert!(text.contains("dot row 3 col 3 | |a| 1.00 g\r\n"), "{text}");
    // Hardware SPI sends both frames in one CS period; the second part,
    // fed only from mx's DOUT, takes the first: a bar of 3 rows for 1 g.
    let bar = |rows: Vec<u8>| rows.iter().filter(|&&r| r == 0xFF).count();
    assert_eq!(
        matrix_rows(&mut board, "bar"),
        [0, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF]
    );
    assert_eq!(matrix_dot(&mut board), [(3, 3)]);

    // Shaken along Y: |a| grows, the bar too; the dot is thrown aside.
    board.set_circuit(
        &imu_matrix_circuit_shaken(0.0, 0.0, 1.2),
        &BusCatalog::default(),
        &signals,
    );
    board.run_for_ns(300e6);
    let text = console_text(&mut board);
    assert!(text.contains("|a| 1.56 g\r\n"), "{text}");
    assert_eq!(bar(matrix_rows(&mut board, "bar")), 5);
    assert_eq!(matrix_dot(&mut board), [(3, 7)]);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-ir-remote"]
fn nec_remote_is_decoded_with_input_capture() {
    use simucleo_nucleo::BusCatalog;
    let n = "nucleo";
    let circuit = m8_circuit(
        serde_json::json!([{"id": "ir", "kind": "ir-receiver"}]),
        vec![
            wire_json((n, "3V3"), ("ir", "VCC")),
            wire_json(("ir", "GND"), (n, "GND")),
            wire_json((n, "D3"), ("ir", "OUT")),
        ],
    );
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-ir-remote", "hal-ir-remote"))
        .unwrap();
    board.set_circuit(&circuit, &BusCatalog::default(), &arduino_signals());
    board.run_for_ns(100e6);
    let text = console_text(&mut board);
    assert!(text.contains("NEC IR receiver on D3"), "{text}");

    // A short press: one frame, no repeat.
    board.press("ir:5", true);
    board.run_for_ns(50e6);
    board.press("ir:5", false);
    board.run_for_ns(150e6);
    let text = console_text(&mut board);
    assert_eq!(text, "NEC addr 0x00 cmd 0x40 key 5\r\n");

    // Held for 300 ms: the frame, then repeat codes at 108 and 216 ms.
    board.press("ir:OK", true);
    board.run_for_ns(300e6);
    board.press("ir:OK", false);
    board.run_for_ns(200e6);
    let text = console_text(&mut board);
    assert_eq!(
        text,
        "NEC addr 0x00 cmd 0x1C key OK\r\nrepeat\r\nrepeat\r\n"
    );

    for (key, cmd) in [("0", 0x19), ("#", 0x0D), ("RIGHT", 0x5A), ("DOWN", 0x52)] {
        board.press(&format!("ir:{key}"), true);
        board.run_for_ns(20e6);
        board.press(&format!("ir:{key}"), false);
        board.run_for_ns(120e6);
        let text = console_text(&mut board);
        assert_eq!(text, format!("NEC addr 0x00 cmd 0x{cmd:02X} key {key}\r\n"));
    }
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

    // Watchpoints survive a reset: the startup code's .bss clear writes
    // `current` again.
    board.set_conditional_breakpoints(&[]);
    let (addr, len) = board.address_of("current", 0).unwrap();
    board.set_watchpoints(&[Watchpoint {
        addr,
        len,
        kind: WatchKind::Write,
    }]);
    board.reset().unwrap();
    let r = board.run_for_ns(10e6);
    assert_eq!(
        r.stop,
        simucleo_core::cpu::StopReason::Watchpoint { addr, write: true }
    );
    assert_eq!(func(&board).as_deref(), Some("Reset_Handler"));
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

// ------------------------------------------------------- new parts (M17)

/// The ROM code a DS18B20 part shows (and the examples print).
fn rom_text(board: &mut Nucleo, id: &str) -> String {
    board
        .circuit_frame(0.0)
        .iter()
        .find(|p| p.id == id)
        .and_then(|p| p.text.clone())
        .unwrap_or_else(|| panic!("{id} shows no ROM code"))
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-onewire-multi"]
fn three_ds18b20_share_one_line_found_by_search_rom() {
    use simucleo_nucleo::BusCatalog;
    let n = "nucleo";
    let circuit = |temps: [f64; 3]| {
        let parts: Vec<serde_json::Value> = (0..3)
            .map(|i| serde_json::json!({"id": format!("t{}", i + 1), "kind": "ds18b20", "props": {"temp": temps[i]}}))
            .collect();
        let mut wires = Vec::new();
        for i in 1..=3 {
            let id = format!("t{i}");
            wires.push(wire_json((n, "3V3"), (&id, "VDD")));
            wires.push(wire_json((&id, "GND"), (n, "GND")));
            wires.push(wire_json((n, "D2"), (&id, "DQ")));
        }
        m8_circuit(serde_json::Value::Array(parts), wires)
    };
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-onewire-multi", "hal-onewire-multi"))
        .unwrap();
    board.set_circuit(
        &circuit([21.5, -4.25, 30.0]),
        &BusCatalog::default(),
        &arduino_signals(),
    );
    let roms: Vec<String> = (1..=3)
        .map(|i| rom_text(&mut board, &format!("t{i}")))
        .collect();
    assert!(roms.iter().all(|r| r.starts_with("28-")), "{roms:?}");
    assert_ne!(roms[0], roms[1]);
    assert_ne!(roms[1], roms[2]);
    board.run_for_ns(1500e6);
    let text = console_text(&mut board);
    assert!(text.contains("found 3 sensors"), "{text}");
    for rom in &roms {
        assert!(text.contains(&format!("ROM {rom}\r\n")), "{rom} in {text}");
    }
    assert!(text.contains(&format!(" {} 21.50 C", roms[0])), "{text}");
    assert!(text.contains(&format!(" {} -4.25 C", roms[1])), "{text}");
    assert!(text.contains(&format!(" {} 30.00 C", roms[2])), "{text}");
    assert!(!text.contains("CRC error"), "{text}");
    // Warming one sensor changes only its line.
    board.set_circuit(
        &circuit([21.5, 33.0, 30.0]),
        &BusCatalog::default(),
        &arduino_signals(),
    );
    board.run_for_ns(2100e6);
    let text = console_text(&mut board);
    let last = text.rsplit("--").nth(1).unwrap_or(&text);
    assert!(last.contains(&format!(" {} 33.00 C", roms[1])), "{text}");
    assert!(last.contains(&format!(" {} 21.50 C", roms[0])), "{text}");
    assert!(last.contains(&format!(" {} 30.00 C", roms[2])), "{text}");
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

/// What the phone of HC-05 part `id` received since the last call.
fn phone_text(board: &mut Nucleo, id: &str) -> String {
    let st = board.bluetooth();
    let s = st.iter().find(|s| s.id == id).expect("an HC-05 part");
    assert!(
        s.received.iter().all(|&(_, garbled)| !garbled),
        "no baud rate mismatch"
    );
    String::from_utf8_lossy(&s.received.iter().map(|b| b.0).collect::<Vec<_>>()).into_owned()
}

fn hc05_circuit(baud: u32) -> simucleo_nucleo::Circuit {
    let n = "nucleo";
    m8_circuit(
        serde_json::json!([{"id": "bt", "kind": "hc05", "props": {"baud": baud}}]),
        vec![
            wire_json((n, "5V"), ("bt", "VCC")),
            wire_json(("bt", "GND"), (n, "GND")),
            wire_json((n, "PA9"), ("bt", "RXD")),
            wire_json(("bt", "TXD"), (n, "D2")),
            wire_json(("bt", "STATE"), (n, "D7")),
        ],
    )
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-bluetooth-led"]
fn phone_commands_over_hc05_switch_ld2_and_get_replies() {
    use simucleo_nucleo::BusCatalog;
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-bluetooth-led", "hal-bluetooth-led"))
        .unwrap();
    board.set_circuit(
        &hc05_circuit(9600),
        &BusCatalog::default(),
        &arduino_signals(),
    );
    board.run_for_ns(100e6);
    assert!(console_text(&mut board).contains("HC-05 on USART1"));
    let st = &board.bluetooth()[0];
    assert_eq!((st.tx_usart, st.rx_usart), (Some("USART1"), Some("USART1")));
    // The phone connects: STATE rises and the firmware greets it.
    board.bluetooth_connect("bt", true);
    board.run_for_ns(200e6);
    assert!(console_text(&mut board).contains("[BT] phone connected"));
    assert!(phone_text(&mut board, "bt").contains("Nucleo LED ready"));
    assert!(!board.pin('A', 5));
    let say = |board: &mut Nucleo, cmd: &str| -> String {
        assert!(board.bluetooth_send("bt", format!("{cmd}\r\n").as_bytes()));
        board.run_for_ns(150e6);
        phone_text(board, "bt")
    };
    assert_eq!(say(&mut board, "on"), "LED ON\r\n");
    assert!(board.pin('A', 5), "LD2 on");
    assert_eq!(say(&mut board, "OFF"), "LED OFF\r\n");
    assert!(!board.pin('A', 5));
    assert_eq!(say(&mut board, "blink"), "LED BLINK (2 Hz)\r\n");
    board.take_pin_events();
    board.run_for_ns(1000e6);
    let toggles = board
        .take_pin_events()
        .into_iter()
        .filter(|e| e.port == 0 && e.pin == 5)
        .count();
    assert!(
        (3..=5).contains(&toggles),
        "2 Hz blink: {toggles} toggles in 1 s"
    );
    assert!(say(&mut board, "status").starts_with("LED BLINKING for 1 s"));
    assert!(say(&mut board, "fly").starts_with("? 'fly'"));
    assert!(console_text(&mut board).contains("[BT] rx: status"));
    // Disconnected: STATE falls, and the phone no longer reaches the board.
    board.bluetooth_connect("bt", false);
    board.run_for_ns(50e6);
    assert!(console_text(&mut board).contains("[BT] phone disconnected"));
    assert!(!board.bluetooth_send("bt", b"on\r\n"));
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-bluetooth-led"]
fn hc05_at_the_wrong_baud_rate_garbles_the_replies() {
    use simucleo_nucleo::BusCatalog;
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-bluetooth-led", "hal-bluetooth-led"))
        .unwrap();
    board.set_circuit(
        &hc05_circuit(115_200),
        &BusCatalog::default(),
        &arduino_signals(),
    );
    board.bluetooth_connect("bt", true);
    board.run_for_ns(300e6);
    let st = board.bluetooth().remove(0);
    assert_eq!(st.baud, 115_200);
    assert!((st.mcu_baud.unwrap() - 9600.0).abs() < 10.0);
    assert!(!st.received.is_empty());
    assert!(st.received.iter().all(|b| b.1), "every byte re-sampled");
    let text: Vec<u8> = st.received.iter().map(|b| b.0).collect();
    assert!(!String::from_utf8_lossy(&text).contains("ready"));
}

fn visual_of(v: &[simucleo_nucleo::PartVisual], id: &str) -> simucleo_nucleo::PartVisual {
    v.iter().find(|p| p.id == id).unwrap().clone()
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-relay"]
fn button_toggles_the_relay_that_switches_a_5v_led() {
    use simucleo_nucleo::BusCatalog;
    let n = "nucleo";
    let circuit = m8_circuit(
        serde_json::json!([
            {"id": "k1", "kind": "relay", "props": {"trigger": "low"}},
            {"id": "r1", "kind": "resistor", "props": {"ohms": "330"}},
            {"id": "lamp", "kind": "led-5mm", "props": {"color": "yellow"}},
            {"id": "sw1", "kind": "tact-switch"}
        ]),
        vec![
            wire_json((n, "5V"), ("k1", "VCC")),
            wire_json(("k1", "GND"), (n, "GND")),
            wire_json((n, "D7"), ("k1", "IN")),
            wire_json((n, "5V"), ("k1", "COM")),
            wire_json(("k1", "NO"), ("r1", "1")),
            wire_json(("r1", "2"), ("lamp", "A")),
            wire_json(("lamp", "K"), (n, "GND")),
            wire_json((n, "D4"), ("sw1", "1a")),
            wire_json(("sw1", "2a"), (n, "GND")),
        ],
    );
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-relay", "hal-relay"))
        .unwrap();
    board.set_circuit(&circuit, &BusCatalog::default(), &arduino_signals());
    board.run_for_ns(100e6);
    board.circuit_frame(0.1);
    board.run_for_ns(50e6);
    let v = board.circuit_frame(0.05);
    assert_eq!(visual_of(&v, "lamp").brightness[0], 0.0);
    assert_eq!(visual_of(&v, "k1").closed, Some(false));
    let text = console_text(&mut board);
    assert!(text.contains("relay OFF"), "{text}");
    for (k, on) in [true, false, true].into_iter().enumerate() {
        board.press("sw1", true);
        // The coil pulls in at once, the contacts ~10 ms later.
        board.run_for_ns(5e6);
        let v = board.circuit_frame(0.005);
        assert_eq!(
            visual_of(&v, "k1").on,
            Some(on as u8 as f64),
            "press {k}: coil LED"
        );
        board.run_for_ns(20e6);
        board.circuit_frame(0.02);
        board.press("sw1", false);
        board.run_for_ns(250e6);
        let v = board.circuit_frame(0.25);
        assert_eq!(visual_of(&v, "k1").closed, Some(on), "press {k}: contacts");
        let lamp = visual_of(&v, "lamp").brightness[0];
        if on {
            assert!(lamp > 0.9, "press {k}: lit from 5 V through COM-NO, {lamp}");
        } else {
            assert_eq!(lamp, 0.0, "press {k}");
        }
        assert_eq!(board.pin('A', 5), on, "LD2 mirrors the relay");
        let text = console_text(&mut board);
        assert!(
            text.contains(if on { "relay ON" } else { "relay OFF" }),
            "{text}"
        );
    }
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-servos-multi"]
fn three_servos_on_tim3_and_tim1_follow_their_own_pulse_widths() {
    use simucleo_core::bus::AccessSize;
    use simucleo_nucleo::BusCatalog;
    let n = "nucleo";
    let ids = ["s1", "s2", "s3"];
    let pins = ["D5", "D9", "D7"];
    let parts: Vec<serde_json::Value> = ids
        .iter()
        .map(|id| serde_json::json!({"id": id, "kind": "servo"}))
        .collect();
    let mut wires = Vec::new();
    for (id, pin) in ids.iter().zip(pins) {
        wires.push(wire_json((n, "5V"), (id, "V+")));
        wires.push(wire_json((id, "GND"), (n, "GND")));
        wires.push(wire_json((n, pin), (id, "SIG")));
    }
    let mut signals = arduino_signals();
    signals.insert("D9".into(), "PC7".into());
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-servos-multi", "hal-servos-multi"))
        .unwrap();
    board.set_circuit(
        &m8_circuit(serde_json::Value::Array(parts), wires),
        &BusCatalog::default(),
        &signals,
    );
    // Compare registers: TIM3 CCR1, CCR2, TIM1 CCR1 (pulse widths in µs).
    let ccr = |board: &Nucleo, i: usize| -> f64 {
        let a = [0x4000_0434, 0x4000_0438, 0x4001_0034][i];
        board.bus.peek(a, AccessSize::Word).unwrap() as f64
    };
    let mut seen = [[f64::MAX, f64::MIN]; 3];
    for frame in 0..250 {
        board.run_for_ns(20e6);
        let v = board.circuit_frame(0.02);
        if frame < 25 {
            continue; // the horns travel from 90° first
        }
        for i in 0..3 {
            let s = visual_of(&v, ids[i]);
            assert!(!s.unpowered);
            let angle = s.angle.unwrap();
            let want = (ccr(&board, i) - 500.0) / 2000.0 * 180.0;
            // A pulse width set within the last 20 ms may not have
            // reached the horn yet (90°/s sweep).
            assert!(
                (angle - want).abs() < 4.5,
                "frame {frame} servo {}: {angle:.1}° for {want:.1}°",
                ids[i]
            );
            seen[i][0] = seen[i][0].min(angle);
            seen[i][1] = seen[i][1].max(angle);
        }
        // A third of a period apart: never all at the same angle.
        let a: Vec<f64> = ids
            .iter()
            .map(|id| visual_of(&v, id).angle.unwrap())
            .collect();
        assert!(
            (a[0] - a[1]).abs() > 20.0 || (a[1] - a[2]).abs() > 20.0,
            "{a:?}"
        );
    }
    for (i, [lo, hi]) in seen.iter().enumerate() {
        assert!(
            *lo < 10.0 && *hi > 170.0,
            "servo {} swept {lo}..{hi}",
            ids[i]
        );
    }
    let text = console_text(&mut board);
    assert!(text.contains("S1 ") && text.contains("S3 "), "{text}");
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

// ---------------------------------------------------- more parts (M19)

/// Board pin → signal for the M19 examples (signal names pass through).
fn m19_signals() -> std::collections::HashMap<String, String> {
    let mut s = arduino_signals();
    for (a, b) in [("D6", "PB10"), ("D13", "PA5"), ("D5", "PB4"), ("A1", "PA1")] {
        s.insert(a.to_string(), b.to_string());
    }
    s
}

/// A wire between two (part, pin) ends.
type WireEnds<'a> = ((&'a str, &'a str), (&'a str, &'a str));

/// A circuit with the board and `parts`; `wires` as (part, pin) pairs.
fn m19_circuit(parts: serde_json::Value, wires: &[WireEnds]) -> simucleo_nucleo::Circuit {
    m8_circuit(parts, wires.iter().map(|&(a, b)| wire_json(a, b)).collect())
}

fn part_visual(v: &[simucleo_nucleo::PartVisual], id: &str) -> simucleo_nucleo::PartVisual {
    v.iter().find(|p| p.id == id).unwrap().clone()
}

/// The props of part `id` changed (a slider moved): send the circuit again.
fn set_part_props(
    board: &mut Nucleo,
    circuit: &mut simucleo_nucleo::Circuit,
    id: &str,
    props: serde_json::Value,
    signals: &std::collections::HashMap<String, String>,
) {
    let p = circuit.parts.iter_mut().find(|p| p.id == id).unwrap();
    for (k, v) in props.as_object().unwrap() {
        p.props.insert(k.clone(), v.clone());
    }
    board.set_circuit(circuit, &breadboard_catalog(), signals);
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-shift-register"]
fn hc595_on_spi_runs_a_knight_rider_on_eight_leds() {
    let n = "nucleo";
    let mut parts = vec![serde_json::json!({"id": "sr", "kind": "hc595"})];
    let mut wires: Vec<WireEnds> = vec![
        ((n, "3V3"), ("sr", "VCC")),
        (("sr", "GND"), (n, "GND")),
        ((n, "3V3"), ("sr", "MR")),
        (("sr", "OE"), (n, "GND")),
        ((n, "D13"), ("sr", "SHCP")),
        ((n, "D11"), ("sr", "DS")),
        ((n, "D10"), ("sr", "STCP")),
    ];
    let names: Vec<(String, String, String)> = (0..8)
        .map(|i| (format!("Q{i}"), format!("r{i}"), format!("l{i}")))
        .collect();
    for (q, r, l) in &names {
        parts.push(serde_json::json!({"id": r, "kind": "resistor", "props": {"ohms": "330"}}));
        parts.push(serde_json::json!({"id": l, "kind": "led-5mm", "props": {"color": "red"}}));
        wires.push((("sr", q.as_str()), (r.as_str(), "1")));
        wires.push(((r.as_str(), "2"), (l.as_str(), "A")));
        wires.push(((l.as_str(), "K"), (n, "GND")));
    }
    let circuit = m19_circuit(serde_json::Value::Array(parts), &wires);
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-shift-register", "hal-shift-register"))
        .unwrap();
    board.set_circuit(
        &circuit,
        &simucleo_nucleo::BusCatalog::default(),
        &m19_signals(),
    );
    // Short frames: the lit LEDs as the eye would see them, step by step.
    let mut seen: Vec<u8> = Vec::new();
    for _ in 0..120 {
        board.run_for_ns(14e6);
        board.circuit_frame(0.014);
        board.run_for_ns(1e6);
        let v = board.circuit_frame(0.001);
        let lit = (0..8).fold(0u8, |a, i| {
            let b = part_visual(&v, &format!("l{i}")).brightness[0];
            a | ((b > 0.5) as u8) << i
        });
        assert_eq!(lit.count_ones(), 1, "one LED at a time: {lit:08b}");
        let reg = part_visual(&v, "sr").register.unwrap();
        assert_eq!(reg.latch, lit, "the LEDs show the storage register");
        if seen.last() != Some(&lit) {
            seen.push(lit);
        }
    }
    // Q0 → Q7 and back: each step one LED over.
    assert!(seen.len() >= 15, "{seen:02X?}");
    for w in seen.windows(2) {
        assert!(w[1] == w[0] << 1 || w[1] == w[0] >> 1, "{seen:02X?}");
    }
    assert!(seen.contains(&0x01) && seen.contains(&0x80), "{seen:02X?}");
    let text = console_text(&mut board);
    assert!(text.contains("74HC595 on SPI1"), "{text}");
    assert!(text.contains("Q0-Q7 #.......  0x01"), "{text}");
    assert!(text.contains("Q0-Q7 .......#  0x80"), "{text}");
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

fn tm1637_circuit(swapped: bool) -> simucleo_nucleo::Circuit {
    let n = "nucleo";
    let (clk, dio) = if swapped {
        ("DIO", "CLK")
    } else {
        ("CLK", "DIO")
    };
    m19_circuit(
        serde_json::json!([{"id": "tm", "kind": "tm1637"}]),
        &[
            ((n, "3V3"), ("tm", "VCC")),
            (("tm", "GND"), (n, "GND")),
            ((n, "D2"), ("tm", clk)),
            ((n, "D3"), ("tm", dio)),
        ],
    )
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-tm1637-clock"]
fn tm1637_clock_is_bit_banged_with_acks() {
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-tm1637-clock", "hal-tm1637-clock"))
        .unwrap();
    board.set_circuit(
        &tm1637_circuit(false),
        &simucleo_nucleo::BusCatalog::default(),
        &m19_signals(),
    );
    board.run_for_ns(3200e6);
    let text = console_text(&mut board);
    assert!(text.contains("TM1637 on D2"), "{text}");
    for t in ["00:00", "00:01", "00:02", "00:03"] {
        assert!(text.contains(&format!("{t}\r\n")), "{text}");
    }
    assert!(!text.contains("no ACK"), "{text}");
    let v = board.circuit_frame(3.2);
    let d = part_visual(&v, "tm").digits.unwrap();
    // 00:03 with the colon (first half of the second).
    assert_eq!(d.segments, [0x3F, 0xBF, 0x3F, 0x4F]);
    assert_eq!((d.brightness, d.on), (7, true));
    // B1: the next brightness.
    board.set_user_button(true);
    board.run_for_ns(100e6);
    board.set_user_button(false);
    board.run_for_ns(100e6);
    assert!(console_text(&mut board).contains("brightness 0"));
    let d = part_visual(&board.circuit_frame(0.2), "tm").digits.unwrap();
    assert_eq!((d.brightness, d.on), (0, true));
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );

    // CLK and DIO swapped: the chip never sees a START, nobody pulls the
    // firmware's DIO (the module's CLK pull-up) low.
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-tm1637-clock", "hal-tm1637-clock"))
        .unwrap();
    board.set_circuit(
        &tm1637_circuit(true),
        &simucleo_nucleo::BusCatalog::default(),
        &m19_signals(),
    );
    board.run_for_ns(600e6);
    assert!(console_text(&mut board).contains("TM1637: no ACK"));
}

/// The SSD1306 screen (64 rows × 128 pixels, MSB first) from base64.
fn screen_pixels(b64: &str) -> Vec<u8> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        _ => 63,
    } as u32;
    let mut out = Vec::new();
    for ch in b64.as_bytes().chunks(4) {
        let n = ch.iter().take_while(|&&c| c != b'=').count();
        let v = ch[..n].iter().fold(0u32, |a, &c| a << 6 | val(c)) << (6 * (4 - n));
        out.extend(&v.to_be_bytes()[1..n]);
    }
    out
}

fn lit_at(screen: &[u8], x: usize, y: usize) -> bool {
    screen[y * 16 + x / 8] >> (7 - x % 8) & 1 != 0
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-joystick-oled"]
fn joystick_on_the_adc_moves_the_dot_on_the_oled() {
    let n = "nucleo";
    let mut circuit = m19_circuit(
        serde_json::json!([
            {"id": "js", "kind": "joystick", "props": {"x": 0.5, "y": 0.5}},
            {"id": "oled", "kind": "oled-ssd1306"}
        ]),
        &[
            ((n, "3V3"), ("js", "+5V")),
            (("js", "GND"), (n, "GND")),
            ((n, "A0"), ("js", "VRx")),
            ((n, "A1"), ("js", "VRy")),
            ((n, "D4"), ("js", "SW")),
            ((n, "3V3"), ("oled", "VCC")),
            (("oled", "GND"), (n, "GND")),
            ((n, "D15"), ("oled", "SCL")),
            ((n, "D14"), ("oled", "SDA")),
        ],
    );
    let signals = m19_signals();
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-joystick-oled", "hal-joystick-oled"))
        .unwrap();
    board.set_circuit(&circuit, &simucleo_nucleo::BusCatalog::default(), &signals);
    board.run_for_ns(300e6);
    let text = console_text(&mut board);
    assert!(text.contains("KY-023 joystick"), "{text}");
    assert!(
        text.contains("X 2047  Y 2047  SW 0") || text.contains("X 2048  Y 2048  SW 0"),
        "{text}"
    );
    let screen = |board: &mut Nucleo| {
        let v = board.circuit_frame(0.1);
        screen_pixels(part_visual(&v, "oled").screen.as_ref().expect("display on"))
    };
    let s = screen(&mut board);
    assert!(lit_at(&s, 64, 34 - 3), "the ring of the dot in the middle");

    // Full right and down, then pressed.
    set_part_props(
        &mut board,
        &mut circuit,
        "js",
        serde_json::json!({"x": 1.0, "y": 0.0}),
        &signals,
    );
    board.run_for_ns(200e6);
    assert!(console_text(&mut board).contains("X 4095  Y    0  SW 0"));
    let s = screen(&mut board);
    assert!(
        lit_at(&s, 123, 59 - 3) && !lit_at(&s, 123, 59),
        "ring at the bottom right"
    );
    set_part_props(
        &mut board,
        &mut circuit,
        "js",
        serde_json::json!({"sw": 1}),
        &signals,
    );
    board.run_for_ns(200e6);
    assert!(console_text(&mut board).contains("SW 1"));
    let s = screen(&mut board);
    assert!(lit_at(&s, 123, 59), "filled while pressed");
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

fn pir_circuit(vcc: &str) -> simucleo_nucleo::Circuit {
    let n = "nucleo";
    m19_circuit(
        serde_json::json!([
            {"id": "pir", "kind": "pir", "props": {"mode": "H", "delay": 3, "warmup": 3}},
            {"id": "r1", "kind": "resistor", "props": {"ohms": "330"}},
            {"id": "led", "kind": "led-5mm", "props": {"color": "red"}}
        ]),
        &[
            ((n, vcc), ("pir", "VCC")),
            (("pir", "GND"), (n, "GND")),
            ((n, "D7"), ("pir", "OUT")),
            ((n, "D6"), ("r1", "1")),
            (("r1", "2"), ("led", "A")),
            (("led", "K"), (n, "GND")),
        ],
    )
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-pir-alarm"]
fn pir_motion_lights_the_led_after_the_warm_up() {
    let signals = m19_signals();
    let mut circuit = pir_circuit("5V");
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-pir-alarm", "hal-pir-alarm"))
        .unwrap();
    board.set_circuit(&circuit, &simucleo_nucleo::BusCatalog::default(), &signals);
    board.run_for_ns(1000e6);
    // Motion during the 3 s warm-up: nothing yet.
    set_part_props(
        &mut board,
        &mut circuit,
        "pir",
        serde_json::json!({"motion": 1}),
        &signals,
    );
    board.run_for_ns(1900e6);
    let text = console_text(&mut board);
    assert!(text.contains("waiting for motion"), "{text}");
    assert!(!text.contains("motion detected"), "{text}");
    board.run_for_ns(200e6);
    let text = console_text(&mut board);
    // The HAL tick starts a few µs after power-up.
    assert!(
        text.contains("[2.999 s] motion detected (#1) - LED on")
            || text.contains("[3.000 s] motion detected (#1) - LED on"),
        "{text}"
    );
    board.circuit_frame(2.1);
    board.run_for_ns(100e6);
    let v = board.circuit_frame(0.1);
    assert!(part_visual(&v, "led").brightness[0] > 0.8);
    assert_eq!(part_visual(&v, "pir").text.as_deref(), Some("high"));
    // The motion stops at 4 s: high until 7 s (mode H, 3 s hold).
    board.run_for_ns(800e6);
    set_part_props(
        &mut board,
        &mut circuit,
        "pir",
        serde_json::json!({"motion": 0}),
        &signals,
    );
    board.run_for_ns(2900e6);
    assert!(!console_text(&mut board).contains("quiet"));
    board.run_for_ns(200e6);
    let text = console_text(&mut board);
    assert!(text.contains("quiet again after 4.0 s - LED off"), "{text}");
    assert!(
        text.contains("[6.999 s]") || text.contains("[7.000 s]"),
        "{text}"
    );
    board.circuit_frame(3.1);
    board.run_for_ns(100e6);
    let v = board.circuit_frame(0.1);
    assert!(part_visual(&v, "led").brightness[0] < 0.1);
    assert_eq!(part_visual(&v, "pir").text.as_deref(), Some("block"));
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );

    // On 3V3 the module does nothing, and says why.
    let mut circuit = pir_circuit("3V3");
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-pir-alarm", "hal-pir-alarm"))
        .unwrap();
    board.set_circuit(&circuit, &simucleo_nucleo::BusCatalog::default(), &signals);
    set_part_props(
        &mut board,
        &mut circuit,
        "pir",
        serde_json::json!({"motion": 1}),
        &signals,
    );
    board.run_for_ns(4000e6);
    assert!(!console_text(&mut board).contains("motion detected"));
    assert!(
        board
            .circuit_warnings()
            .iter()
            .any(|w| w.contains("HC-SR501 needs 4.5")),
        "{:?}",
        board.circuit_warnings()
    );
}

/// The last "T … C  P … hPa  alt … m" line: (°C, hPa, m).
fn bmp_reading(text: &str) -> (f64, f64, f64) {
    let line = text
        .lines()
        .rev()
        .find(|l| l.starts_with("T "))
        .expect(text);
    let w: Vec<&str> = line.split_whitespace().collect();
    (
        w[1].parse().unwrap(),
        w[4].parse().unwrap(),
        w[7].parse().unwrap(),
    )
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-bmp280"]
fn bmp280_compensation_gives_back_the_set_temperature_and_pressure() {
    let n = "nucleo";
    let signals = m19_signals();
    let mut circuit = m19_circuit(
        serde_json::json!([{"id": "baro", "kind": "bmp280", "props": {"temp": 23.4, "pressure": 950}}]),
        &[
            ((n, "3V3"), ("baro", "VCC")),
            (("baro", "GND"), (n, "GND")),
            ((n, "D15"), ("baro", "SCL")),
            ((n, "D14"), ("baro", "SDA")),
        ],
    );
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-bmp280", "hal-bmp280"))
        .unwrap();
    board.set_circuit(&circuit, &simucleo_nucleo::BusCatalog::default(), &signals);
    board.run_for_ns(600e6);
    let text = console_text(&mut board);
    assert!(text.contains("chip id 0x58 (BMP280)"), "{text}");
    assert!(
        text.contains("dig_T1 27504 T2 26435 T3 -1000  dig_P1 36477 P9 6000"),
        "{text}"
    );
    let (t, p, alt) = bmp_reading(&text);
    assert!((t - 23.4).abs() <= 0.02, "{text}");
    assert!((p - 950.0).abs() <= 0.02, "{text}");
    assert!((alt - 540.4).abs() < 1.0, "{text}");
    // A forced conversion at ×2 / ×16 takes about 43 ms (polled every 3 ms).
    let ms: u32 = text
        .split("conversion ")
        .nth(1)
        .and_then(|r| r.split(' ').next())
        .and_then(|v| v.parse().ok())
        .expect(&text);
    assert!((43..=48).contains(&ms), "{text}");

    set_part_props(
        &mut board,
        &mut circuit,
        "baro",
        serde_json::json!({"temp": -5.5, "pressure": 1013.25}),
        &signals,
    );
    board.run_for_ns(1100e6);
    let (t, p, alt) = bmp_reading(&console_text(&mut board));
    assert!(
        (t + 5.5).abs() <= 0.02 && (p - 1013.25).abs() <= 0.02,
        "{t} {p}"
    );
    assert!(alt.abs() < 0.5, "{alt}");
    assert_eq!(
        part_visual(&board.circuit_frame(1.0), "baro")
            .text
            .as_deref(),
        Some("sleep")
    );
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-neopixel-chain"]
fn neopixel_strip_on_the_ring_dout_takes_leds_12_to_19() {
    let n = "nucleo";
    let circuit = m19_circuit(
        serde_json::json!([
            {"id": "ring", "kind": "neopixel-ring", "props": {"count": 12}},
            {"id": "strip", "kind": "neopixel-strip", "props": {"count": 8}}
        ]),
        &[
            ((n, "5V"), ("ring", "VCC")),
            (("ring", "GND"), (n, "GND")),
            ((n, "D5"), ("ring", "DIN")),
            ((n, "5V"), ("strip", "VCC")),
            (("strip", "GND"), (n, "GND")),
            (("ring", "DOUT"), ("strip", "DIN")),
        ],
    );
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-neopixel-chain", "hal-neopixel-chain"))
        .unwrap();
    board.set_circuit(
        &circuit,
        &simucleo_nucleo::BusCatalog::default(),
        &m19_signals(),
    );
    let mut heads = std::collections::BTreeSet::new();
    for _ in 0..30 {
        board.run_for_ns(40e6);
        let v = board.circuit_frame(0.04);
        let ring = part_visual(&v, "ring").leds;
        let strip = part_visual(&v, "strip").leds;
        assert_eq!((ring.len(), strip.len()), (12, 8));
        assert!(ring.iter().all(|&c| c != 0), "{ring:06X?}");
        // The comet: one bright amber LED, dimmer neighbours, the rest dark.
        let head = strip
            .iter()
            .position(|&c| c == 0x201000)
            .unwrap_or_else(|| panic!("{strip:06X?}"));
        assert!(strip
            .iter()
            .enumerate()
            .all(|(i, &c)| i.abs_diff(head) <= 1 || c == 0));
        heads.insert(head);
    }
    assert!(heads.len() >= 4, "the comet moves: {heads:?}");
    let text = console_text(&mut board);
    assert!(text.contains("ring (12) -> DOUT -> strip (8)"), "{text}");
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

// ---------------------------------------------------------- motors (M21)

/// Board pin → signal for the M21 examples.
fn m21_signals() -> std::collections::HashMap<String, String> {
    let mut s = m19_signals();
    for (a, b) in [("D8", "PA9"), ("D9", "PC7")] {
        s.insert(a.to_string(), b.to_string());
    }
    s
}

fn motor_view(v: &[simucleo_nucleo::PartVisual], id: &str) -> simucleo_nucleo::MotorView {
    part_visual(v, id).motor.unwrap()
}

/// The A4988 example's circuit (`load`: brake on the shaft, N·cm).
fn a4988_circuit(load: f64) -> simucleo_nucleo::Circuit {
    let n = "nucleo";
    m19_circuit(
        serde_json::json!([
            {"id": "drv", "kind": "a4988"},
            {"id": "mot", "kind": "stepper-nema17", "props": {"load": load}},
            {"id": "bat", "kind": "battery", "props": {"voltage": 12}}
        ]),
        &[
            ((n, "D3"), ("drv", "STEP")),
            ((n, "D4"), ("drv", "DIR")),
            ((n, "D7"), ("drv", "EN")),
            ((n, "D8"), ("drv", "MS1")),
            ((n, "D9"), ("drv", "MS2")),
            ((n, "D10"), ("drv", "MS3")),
            (("drv", "RST"), ("drv", "SLP")),
            ((n, "3V3"), ("drv", "VDD")),
            (("drv", "GND"), (n, "GND")),
            (("bat", "+"), ("drv", "VMOT")),
            (("bat", "-"), (n, "GND")),
            (("drv", "1A"), ("mot", "A+")),
            (("drv", "1B"), ("mot", "A-")),
            (("drv", "2A"), ("mot", "B+")),
            (("drv", "2B"), ("mot", "B-")),
        ],
    )
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-stepper-a4988"]
fn a4988_ramps_one_revolution_each_way_in_eighth_steps() {
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-stepper-a4988", "hal-stepper-a4988"))
        .unwrap();
    board.set_circuit(
        &a4988_circuit(0.0),
        &simucleo_nucleo::BusCatalog::default(),
        &m21_signals(),
    );
    // Energised at the driver's home position, before the first move.
    board.run_for_ns(80e6);
    let start = motor_view(&board.circuit_frame(0.08), "mot").steps;
    assert!(start.abs() < 0.05, "{start}");
    // Frames of 20 ms: the rotor turns one way, then back, at up to 300 rpm.
    let mut fastest: f64 = 0.0;
    let mut turns = Vec::new();
    for _ in 0..100 {
        board.run_for_ns(20e6);
        let v = board.circuit_frame(0.02);
        let m = part_visual(&v, "mot");
        fastest = fastest.max(m.rpm.unwrap().abs());
        turns.push(m.motor.unwrap().steps - start);
    }
    let text = console_text(&mut board);
    assert!(text.contains("1/8 steps"), "{text}");
    assert!(
        text.contains("rev 1 CW : position 1600 microsteps = 360.0 deg"),
        "{text}"
    );
    assert!(
        text.contains("rev 2 CCW: position 0 microsteps = 0.0 deg"),
        "{text}"
    );
    // Out to 200 full steps and back to 0, nothing lost.
    let max = turns.iter().cloned().fold(f64::MIN, f64::max);
    assert!((max - 200.0).abs() < 0.2, "{max} {turns:?}");
    assert!(turns.iter().any(|s| s.abs() < 0.2), "{turns:?}");
    assert!(fastest > 200.0 && fastest < 330.0, "{fastest} rpm");
    let d = motor_view(&board.circuit_frame(0.0), "drv");
    assert_eq!((d.micro, d.state.as_str()), (8, "on"));
    assert_eq!(motor_view(&board.circuit_frame(0.0), "mot").lost, 0);
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
    // B1: the driver lets go (EN high) after the move in progress.
    board.set_user_button(true);
    board.run_for_ns(30e6);
    board.set_user_button(false);
    board.run_for_ns(1500e6);
    let text = console_text(&mut board);
    assert!(text.contains("driver off (EN high)"), "{text}");
    let v = board.circuit_frame(1.5);
    assert_eq!(motor_view(&v, "drv").state, "disabled");
    assert!(motor_view(&v, "mot").coils.iter().all(|c| c.abs() < 1e-6));
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-stepper-a4988"]
fn a4988_with_a_brake_on_the_shaft_loses_steps() {
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-stepper-a4988", "hal-stepper-a4988"))
        .unwrap();
    // 35 N·cm against 40 N·cm of holding torque: it cannot keep up.
    board.set_circuit(
        &a4988_circuit(35.0),
        &simucleo_nucleo::BusCatalog::default(),
        &m21_signals(),
    );
    board.run_for_ns(1500e6);
    let m = motor_view(&board.circuit_frame(1.5), "mot");
    assert!(m.lost > 0, "{m:?}");
    assert!(
        board
            .circuit_warnings()
            .iter()
            .any(|w| w.starts_with("mot: lost steps")),
        "{:?}",
        board.circuit_warnings()
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-stepper-l298n"]
fn l298n_half_steps_one_revolution_each_way() {
    let n = "nucleo";
    let circuit = m19_circuit(
        serde_json::json!([
            {"id": "br", "kind": "l298n", "props": {"jumpers": "off"}},
            {"id": "mot", "kind": "stepper-nema17"},
            {"id": "bat", "kind": "battery", "props": {"voltage": 12}}
        ]),
        &[
            ((n, "D7"), ("br", "IN1")),
            ((n, "D8"), ("br", "IN2")),
            ((n, "D2"), ("br", "IN3")),
            ((n, "D12"), ("br", "IN4")),
            ((n, "D5"), ("br", "ENA")),
            ((n, "D9"), ("br", "ENB")),
            (("bat", "+"), ("br", "12V")),
            (("bat", "-"), ("br", "GND")),
            (("br", "GND"), (n, "GND")),
            (("br", "OUT1"), ("mot", "A+")),
            (("br", "OUT2"), ("mot", "A-")),
            (("br", "OUT3"), ("mot", "B+")),
            (("br", "OUT4"), ("mot", "B-")),
        ],
    );
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-stepper-l298n", "hal-stepper-l298n"))
        .unwrap();
    board.set_circuit(
        &circuit,
        &simucleo_nucleo::BusCatalog::default(),
        &m21_signals(),
    );
    board.run_for_ns(150e6);
    let start = motor_view(&board.circuit_frame(0.15), "mot").steps;
    let mut seen = Vec::new();
    let mut rpm: f64 = 0.0;
    for _ in 0..60 {
        board.run_for_ns(50e6);
        let v = board.circuit_frame(0.05);
        rpm = rpm.max(part_visual(&v, "mot").rpm.unwrap());
        seen.push(motor_view(&v, "mot").steps - start);
        // 80 % PWM on ENA/ENB: the bridge outputs average to 80 % or less.
        let b = motor_view(&v, "br");
        assert!(b.coils.iter().all(|c| c.abs() <= 0.81), "{:?}", b.coils);
    }
    let text = console_text(&mut board);
    assert!(
        text.contains("rev 1 CW : position 400 half steps = 360 deg"),
        "{text}"
    );
    assert!(
        text.contains("rev 2 CCW: position 0 half steps = 0 deg"),
        "{text}"
    );
    let max = seen.iter().cloned().fold(f64::MIN, f64::max);
    assert!((max - 200.0).abs() < 0.5, "{max} {seen:?}");
    assert!((rpm - 60.0).abs() < 6.0, "{rpm}");
    assert_eq!(motor_view(&board.circuit_frame(0.0), "mot").lost, 0);
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-esc-bldc"]
fn esc_arms_then_follows_the_pot_and_fails_safe_without_signal() {
    let n = "nucleo";
    let mut circuit = m19_circuit(
        serde_json::json!([
            {"id": "esc", "kind": "esc-bldc", "props": {"kv": 1000}},
            {"id": "bat", "kind": "battery", "props": {"voltage": 11.1}},
            {"id": "pot", "kind": "potentiometer", "props": {"position": 0.5}}
        ]),
        &[
            ((n, "D5"), ("esc", "SIG")),
            (("esc", "GND"), (n, "GND")),
            (("bat", "+"), ("esc", "BAT+")),
            (("bat", "-"), ("esc", "GND")),
            ((n, "3V3"), ("pot", "1")),
            (("pot", "W"), (n, "A0")),
            (("pot", "2"), (n, "GND")),
        ],
    );
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-esc-bldc", "hal-esc-bldc"))
        .unwrap();
    let signals = m21_signals();
    board.set_circuit(&circuit, &simucleo_nucleo::BusCatalog::default(), &signals);
    board.run_for_ns(500e6);
    assert_eq!(motor_view(&board.circuit_frame(0.5), "esc").state, "arming");
    board.run_for_ns(1000e6);
    assert_eq!(motor_view(&board.circuit_frame(1.0), "esc").state, "armed");
    // The pot at the middle: about 50 % of 1000 KV × 11.1 V.
    board.run_for_ns(2500e6);
    let rpm = part_visual(&board.circuit_frame(2.5), "esc").rpm.unwrap();
    assert!((rpm - 5550.0).abs() < 300.0, "{rpm}");
    let text = console_text(&mut board);
    assert!(
        text.contains("armed - throttle from the pot on A0"),
        "{text}"
    );
    assert!(
        text.contains("throttle  49 %") || text.contains("throttle  50 %"),
        "{text}"
    );
    // Pot turned towards 3V3 (pin 1): faster.
    set_part_props(
        &mut board,
        &mut circuit,
        "pot",
        serde_json::json!({"position": 0.1}),
        &signals,
    );
    board.run_for_ns(2000e6);
    let rpm = part_visual(&board.circuit_frame(2.0), "esc").rpm.unwrap();
    assert!((rpm - 0.9 * 11100.0).abs() < 400.0, "{rpm}");
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
    // B1: no more pulses — failsafe, the motor runs down.
    board.set_user_button(true);
    board.run_for_ns(30e6);
    board.set_user_button(false);
    board.run_for_ns(2000e6);
    let v = board.circuit_frame(2.0);
    assert_eq!(motor_view(&v, "esc").state, "failsafe");
    assert!(part_visual(&v, "esc").rpm.unwrap() < 1000.0);
    assert!(board
        .circuit_warnings()
        .iter()
        .any(|w| w.contains("failsafe")));
    // B1 again: arming, then running.
    board.set_user_button(true);
    board.run_for_ns(30e6);
    board.set_user_button(false);
    board.run_for_ns(4000e6);
    let v = board.circuit_frame(4.0);
    assert_eq!(motor_view(&v, "esc").state, "armed");
    assert!(part_visual(&v, "esc").rpm.unwrap() > 8000.0);
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-bldc-hall"]
fn bldc_is_commutated_from_its_hall_interrupts() {
    let n = "nucleo";
    let circuit = m19_circuit(
        serde_json::json!([
            {"id": "br", "kind": "bridge-3ph"},
            {"id": "mot", "kind": "bldc-hall"},
            {"id": "bat", "kind": "battery", "props": {"voltage": 12}}
        ]),
        &[
            ((n, "D2"), ("mot", "HA")),
            ((n, "D7"), ("mot", "HB")),
            ((n, "D8"), ("mot", "HC")),
            ((n, "5V"), ("mot", "VCC")),
            (("mot", "GND"), (n, "GND")),
            ((n, "D3"), ("br", "INHA")),
            ((n, "D5"), ("br", "INLA")),
            ((n, "D6"), ("br", "INHB")),
            ((n, "D10"), ("br", "INLB")),
            ((n, "D15"), ("br", "INHC")),
            ((n, "D14"), ("br", "INLC")),
            (("bat", "+"), ("br", "PVDD")),
            (("bat", "-"), (n, "GND")),
            (("br", "GND"), (n, "GND")),
            (("br", "OUTA"), ("mot", "U")),
            (("br", "OUTB"), ("mot", "V")),
            (("br", "OUTC"), ("mot", "W")),
        ],
    );
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-bldc-hall", "hal-bldc-hall"))
        .unwrap();
    board.set_circuit(
        &circuit,
        &simucleo_nucleo::BusCatalog::default(),
        &m21_signals(),
    );
    board.run_for_ns(1500e6);
    let v = board.circuit_frame(1.5);
    let rpm = part_visual(&v, "mot").rpm.unwrap();
    assert!(rpm > 3000.0 && rpm < 3600.0, "{rpm}");
    let text = console_text(&mut board);
    let last = text
        .lines()
        .rev()
        .find(|l| l.starts_with("halls ABC"))
        .unwrap();
    let said: f64 = last.rsplit(' ').next().unwrap().parse().unwrap();
    assert!((said - rpm).abs() < 150.0, "{last} vs {rpm}");
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
    // B1: halls A and B swapped in the firmware — the motor stalls.
    board.set_user_button(true);
    board.run_for_ns(30e6);
    board.set_user_button(false);
    board.run_for_ns(1500e6);
    let v = board.circuit_frame(1.5);
    assert!(part_visual(&v, "mot").rpm.unwrap().abs() < 300.0);
    assert!(motor_view(&v, "mot").stalled);
    assert!(console_text(&mut board).contains("wrong commutation"));
    assert!(
        board
            .circuit_warnings()
            .iter()
            .any(|w| w.starts_with("mot: the motor has current but does not turn")),
        "{:?}",
        board.circuit_warnings()
    );
}

/// The M23 example's circuit: TIM1 CH1–CH3 and CH1N–CH3N on the bridge,
/// halls on D3/D4/D6, a pot on A0 (`pot`: its position).
fn bldc_pwm_circuit(pot: f64) -> simucleo_nucleo::Circuit {
    let n = "nucleo";
    m19_circuit(
        serde_json::json!([
            {"id": "br", "kind": "bridge-3ph"},
            {"id": "mot", "kind": "bldc-hall"},
            {"id": "bat", "kind": "battery", "props": {"voltage": 12}},
            {"id": "pot", "kind": "potentiometer", "props": {"position": pot}}
        ]),
        &[
            ((n, "D3"), ("mot", "HA")),
            ((n, "D4"), ("mot", "HB")),
            ((n, "D6"), ("mot", "HC")),
            ((n, "5V"), ("mot", "VCC")),
            (("mot", "GND"), (n, "GND")),
            ((n, "D7"), ("br", "INHA")),
            ((n, "D11"), ("br", "INLA")),
            ((n, "D8"), ("br", "INHB")),
            ((n, "A3"), ("br", "INLB")),
            ((n, "D2"), ("br", "INHC")),
            ((n, "PB1"), ("br", "INLC")),
            (("bat", "+"), ("br", "PVDD")),
            (("bat", "-"), (n, "GND")),
            (("br", "GND"), (n, "GND")),
            (("br", "OUTA"), ("mot", "U")),
            (("br", "OUTB"), ("mot", "V")),
            (("br", "OUTC"), ("mot", "W")),
            ((n, "3V3"), ("pot", "1")),
            (("pot", "W"), (n, "A0")),
            (("pot", "2"), (n, "GND")),
        ],
    )
}

fn m23_signals() -> std::collections::HashMap<String, String> {
    let mut s = m21_signals();
    for (a, b) in [("A3", "PB0"), ("PB1", "PB1")] {
        s.insert(a.to_string(), b.to_string());
    }
    s
}

/// The last "rpm" the firmware printed.
fn printed_rpm(text: &str) -> f64 {
    let last = text
        .lines()
        .rev()
        .find(|l| l.contains(" rpm "))
        .unwrap_or_else(|| panic!("no rpm line in {text:?}"));
    last.rsplit(' ').next().unwrap().parse().unwrap()
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-bldc-pwm"]
fn bldc_pwm_speed_follows_the_pot_and_the_break_stops_driving() {
    let mut circuit = bldc_pwm_circuit(0.5);
    let signals = m23_signals();
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-bldc-pwm", "hal-bldc-pwm"))
        .unwrap();
    board.set_circuit(&circuit, &simucleo_nucleo::BusCatalog::default(), &signals);
    board.run_for_ns(1500e6);
    let v = board.circuit_frame(1.5);
    let half = part_visual(&v, "mot").rpm.unwrap();
    // Half the duty: about half of the 3300 rpm at full voltage.
    assert!(half > 1200.0 && half < 2100.0, "{half}");
    let text = console_text(&mut board);
    assert!(text.contains("dead time 500 ns"), "{text}");
    assert!(text.contains("run   duty  49 %"), "{text}");
    assert!(
        (printed_rpm(&text) - half).abs() < 150.0,
        "{text} vs {half}"
    );
    // Each high side chops, each low side also on for its own sector.
    let br = motor_view(&v, "br");
    assert!(
        br.duty.iter().all(|&d| d > 0.05 && d < 0.6),
        "{:?}",
        br.duty
    );
    assert!(!br.shoot_through);
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
    // Pot towards 3V3: 90 % duty, faster.
    set_part_props(
        &mut board,
        &mut circuit,
        "pot",
        serde_json::json!({"position": 0.1}),
        &signals,
    );
    board.run_for_ns(1500e6);
    let fast = part_visual(&board.circuit_frame(1.5), "mot").rpm.unwrap();
    assert!(fast > half * 1.5 && fast < 3400.0, "{half} → {fast}");
    let text = console_text(&mut board);
    assert!(
        text.contains("duty  89 %") || text.contains("duty  90 %"),
        "{text}"
    );
    assert!(
        (printed_rpm(&text) - fast).abs() < 150.0,
        "{text} vs {fast}"
    );
    // B1: software break — BIF, the outputs idle, no current, it coasts.
    board.set_user_button(true);
    board.run_for_ns(30e6);
    board.set_user_button(false);
    board.run_for_ns(300e6);
    let text = console_text(&mut board);
    assert!(
        text.contains("break: BIF set, MOE off - outputs idle, the motor coasts"),
        "{text}"
    );
    board.circuit_frame(0.33);
    board.run_for_ns(100e6);
    let v = board.circuit_frame(0.1);
    let coast = part_visual(&v, "mot").rpm.unwrap();
    assert!(coast < fast && coast > 0.0, "{fast} → {coast}");
    assert!(
        motor_view(&v, "mot").coils.iter().all(|c| c.abs() < 1e-6),
        "{:?}",
        motor_view(&v, "mot").coils
    );
    assert!(motor_view(&v, "br").duty.iter().all(|&d| d == 0.0));
    board.run_for_ns(2000e6);
    let stopped = part_visual(&board.circuit_frame(2.0), "mot").rpm.unwrap();
    assert!(stopped < coast * 0.5, "{coast} → {stopped}");
    assert!(console_text(&mut board).contains("break duty"));
    // B1 again: MOE on, driving again.
    board.set_user_button(true);
    board.run_for_ns(30e6);
    board.set_user_button(false);
    board.run_for_ns(1500e6);
    assert!(console_text(&mut board).contains("resumed: MOE on"));
    let again = part_visual(&board.circuit_frame(1.53), "mot").rpm.unwrap();
    assert!(again > fast * 0.9, "{again}");
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}

// ---------------------------------------------------------------- M28

/// The sensorless example as the web loads it (`pot`: wiper position).
fn sensorless_circuit(pot: f64) -> simucleo_nucleo::Circuit {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/examples/hal-bldc-sensorless.simucleo.json"
    );
    let mut project: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for p in project["parts"].as_array_mut().unwrap() {
        if p["id"] == "pot" {
            p["props"]["position"] = pot.into();
        }
    }
    // Parts seated in the breadboard are joined to its holes (M38).
    serde_json::from_value(web_project::circuit(&project)).unwrap()
}

/// The breadboard's strips and rails, for circuits with parts seated in it.
fn breadboard_catalog() -> simucleo_nucleo::BusCatalog {
    serde_json::from_value(web_project::bus_catalog()).unwrap()
}

fn m28_signals() -> std::collections::HashMap<String, String> {
    let mut s = m23_signals();
    for (a, b) in [
        ("A1", "PA1"),
        ("A2", "PA4"),
        ("A4", "PC1"),
        ("A5", "PC0"),
        ("CN10_24", "PB1"),
        ("GND_P1", "GND"),
        ("GND_P2", "GND"),
    ] {
        s.insert(a.to_string(), b.to_string());
    }
    s
}

/// The last line the firmware printed with `state` in it.
fn last_state_line<'a>(text: &'a str, state: &str) -> Option<&'a str> {
    text.lines().rev().find(|l| l.starts_with(state))
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-bldc-sensorless"]
fn sensorless_bldc_aligns_ramps_and_closes_the_loop_on_zero_crossings() {
    let signals = m28_signals();
    let mut circuit = sensorless_circuit(0.5);
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-bldc-sensorless", "hal-bldc-sensorless"))
        .unwrap();
    board.set_circuit(&circuit, &breadboard_catalog(), &signals);
    // Aligning: held still.
    board.run_for_ns(400e6);
    let v = board.circuit_frame(0.4);
    assert!(part_visual(&v, "mot").rpm.unwrap().abs() < 100.0);
    // Ramp, then closed loop: steady at about half the no-load speed.
    board.run_for_ns(1600e6);
    board.circuit_frame(1.6);
    board.run_for_ns(1000e6);
    let mid = part_visual(&board.circuit_frame(1.0), "mot").rpm.unwrap();
    assert!(mid > 1400.0 && mid < 2000.0, "{mid}");
    let text = console_text(&mut board);
    assert!(text.contains("center-aligned 20 kHz, RCR 1"), "{text}");
    let line = last_state_line(&text, "closed").unwrap_or_else(|| panic!("{text}"));
    assert!(line.contains("duty  54 %"), "{line}");
    assert!(
        (printed_rpm_zc(line) - mid).abs() < 100.0,
        "{line} vs {mid}"
    );
    assert!(!text.contains("lost the rotor"), "{text}");
    // It commutated on crossings, not on timeouts: the count keeps pace.
    let zc: u32 = line.rsplit(' ').next().unwrap().parse().unwrap();
    assert!(zc > 500, "{line}");
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
    // The pot towards 3V3: faster; towards GND: slower.
    set_part_props(
        &mut board,
        &mut circuit,
        "pot",
        serde_json::json!({"position": 0.1}),
        &signals,
    );
    board.run_for_ns(1500e6);
    board.circuit_frame(1.5);
    board.run_for_ns(500e6);
    let fast = part_visual(&board.circuit_frame(0.5), "mot").rpm.unwrap();
    assert!(fast > mid * 1.3, "{mid} → {fast}");
    set_part_props(
        &mut board,
        &mut circuit,
        "pot",
        serde_json::json!({"position": 0.9}),
        &signals,
    );
    board.run_for_ns(1500e6);
    board.circuit_frame(1.5);
    board.run_for_ns(500e6);
    let slow = part_visual(&board.circuit_frame(0.5), "mot").rpm.unwrap();
    assert!(slow < mid * 0.7 && slow > 200.0, "{mid} → {slow}");
    let text = console_text(&mut board);
    assert!(!text.contains("lost the rotor"), "{text}");
    let line = last_state_line(&text, "closed").unwrap();
    assert!(
        (printed_rpm_zc(line) - slow).abs() < 100.0,
        "{line} vs {slow}"
    );
}

/// The rpm in a line `closed duty  54 %  rpm 1711  zc 990`.
fn printed_rpm_zc(line: &str) -> f64 {
    let w: Vec<&str> = line.split_whitespace().collect();
    let i = w.iter().position(|&x| x == "rpm").unwrap();
    w[i + 1].parse().unwrap()
}

/// M39: a project built in a CubeIDE workspace on Windows
/// (`firmware/cubeide-blinky`: `C:\Users\…\blinky/Debug` + `../Core/Src/main.c`)
/// gives `/`-separated absolute paths, and its main loop runs.
#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/cubeide-blinky"]
fn cubeide_windows_paths() {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "../../firmware/cubeide-blinky/build/blinky/Debug/blinky.elf",
    ]
    .iter()
    .collect();
    let elf = std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e} (run `make -C firmware/cubeide-blinky` first)",
            path.display()
        )
    });
    let mut board = Nucleo::new();
    board.load_elf(&elf).unwrap();
    let info = board.debug_info().expect("DWARF");
    let root = "C:/Users/student/STM32CubeIDE/workspace_1.16.0/blinky";
    for f in [
        "Core/Src/main.c",
        "Core/Src/stm32f4xx_it.c",
        "Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_gpio.c",
    ] {
        let want = format!("{root}/{f}");
        let i = info.files.iter().position(|p| *p == want);
        let i = i.unwrap_or_else(|| panic!("{want} not in {:?}", info.files));
        assert!(!info.lines_with_code(i as u32).is_empty(), "{want}");
    }
    assert!(
        info.files
            .iter()
            .all(|p| !p.contains('\\') && !p.contains("/Debug/..")),
        "{:?}",
        info.files
    );
    board.run_for_ns(1200e6);
    let toggles = board
        .take_pin_events()
        .into_iter()
        .filter(|e| e.port == 0 && e.pin == 5)
        .count();
    assert!(toggles >= 2, "LD2 toggled {toggles} times");
}

/// SWV: nothing is traced until the "debugger" turns the trace on; then ITM
/// text and words, the traced variable's writes, TIM2's exception trace and
/// a PC-sample profile come out (firmware/hal-swv-trace).
#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-swv-trace"]
fn swv_trace_itm_data_exceptions_and_profile() {
    use simucleo_nucleo::swv::{DataMode, DataTrace, SwvConfig};

    let elf = firmware("hal-swv-trace");
    let mut board = Nucleo::new();
    board.load_elf(&elf).unwrap();
    let fw = board.firmware.as_ref().unwrap();
    let addr_of = |name: &str| {
        *fw.symbols
            .iter()
            .find(|(_, n)| n.as_str() == name)
            .unwrap()
            .0
    };
    let wave = addr_of("wave");

    // Trace off: ITM_SendChar returns at once, nothing is collected.
    board.run_for_ns(50e6);
    let off = board.swv_take();
    assert!(
        off.itm.is_empty()
            && off.data.is_empty()
            && off.exceptions.is_empty()
            && off.profile.is_empty()
    );

    board.swv_configure(Some(SwvConfig {
        ports: 0b11,
        pc_sampling: Some((15, true)), // every 16 × 1024 cycles
        exceptions: true,
        data: vec![DataTrace {
            addr: wave,
            size: 4,
            mode: DataMode::Write,
        }],
    }));
    board.run_for_ns(300e6);
    let f = board.swv_take();
    assert_eq!(f.dropped, 0);

    // Port 0: the text, every 100 ms; port 1: the loop count as words.
    let text: String = f
        .itm
        .iter()
        .filter(|e| e.port == 0)
        .map(|e| e.value as u8 as char)
        .collect();
    let lines: Vec<&str> = text.lines().collect();
    assert!((2..=4).contains(&lines.len()), "ITM text: {text:?}");
    assert!(
        lines[0].starts_with("loop ") && lines[0].contains("wave"),
        "{text:?}"
    );
    let words: Vec<u32> = f
        .itm
        .iter()
        .filter(|e| e.port == 1)
        .map(|e| {
            assert_eq!(e.size, 4);
            e.value
        })
        .collect();
    assert_eq!(words.len(), lines.len());
    assert!(words.windows(2).all(|w| w[1] > w[0]));

    // Data trace: wave written every 5 ms, in steps of ±4 within −100…100.
    let writes: Vec<i32> = f
        .data
        .iter()
        .filter(|d| d.write && d.addr == wave)
        .map(|d| d.value as i32)
        .collect();
    assert!((55..=62).contains(&writes.len()), "{} writes", writes.len());
    assert!(
        writes.windows(2).all(|w| (w[1] - w[0]).abs() == 4),
        "{writes:?}"
    );
    assert!(writes.iter().all(|v| (-104..=104).contains(v)));
    let times: Vec<f64> = f.data.iter().filter(|d| d.write).map(|d| d.t).collect();
    for w in times.windows(2) {
        assert!((4.9e6..5.2e6).contains(&(w[1] - w[0])), "{:?}", w);
    }

    // Exception trace: TIM2 (IRQ 28 = exception 44) enters and exits about
    // 300 times in 300 ms, as does SysTick; each exit is followed by a
    // return to what it interrupted.
    let count = |n: u16, k: &str| {
        f.exceptions
            .iter()
            .filter(|e| e.number == n && e.kind == k)
            .count()
    };
    let tim2 = 16 + 28;
    assert!(
        (298..=302).contains(&count(tim2, "enter")),
        "{}",
        count(tim2, "enter")
    );
    assert_eq!(count(tim2, "enter"), count(tim2, "exit"));
    assert!((298..=302).contains(&count(15, "enter")));
    assert_eq!(
        f.exceptions.iter().find(|e| e.number == tim2).unwrap().name,
        "TIM2"
    );
    for w in f.exceptions.windows(2) {
        if w[0].kind == "exit" {
            assert_eq!(w[1].kind, "return");
        }
    }

    // Profile: the slow filter() is where the awake core spends its time;
    // the rest of the time it sleeps in WFI.
    let total: u64 = f.profile.iter().map(|p| p.samples).sum::<u64>() + f.sleep_samples;
    let expected = (300e-3 * 84e6 / 16384.0) as u64;
    assert!(
        total.abs_diff(expected) <= 2,
        "{total} samples, expected {expected}"
    );
    assert_eq!(
        f.profile[0].function,
        "filter",
        "{:?}",
        &f.profile[..3.min(f.profile.len())]
    );
    assert!(
        f.sleep_samples > f.profile[0].samples,
        "sleep {} vs filter {}",
        f.sleep_samples,
        f.profile[0].samples
    );

    // Stopped: no more packets, and ITM_SendChar is a no-op again.
    board.swv_configure(None);
    board.run_for_ns(50e6);
    let after = board.swv_take();
    assert!(
        after.itm.is_empty()
            && after.data.is_empty()
            && after.exceptions.is_empty()
            && after.profile.is_empty()
    );

    // The settings survive loading the firmware again (as CubeIDE re-applies
    // them when the debug session restarts).
    board.swv_configure(Some(SwvConfig {
        ports: 1,
        pc_sampling: None,
        exceptions: false,
        data: vec![],
    }));
    board.load_elf(&elf).unwrap();
    board.run_for_ns(150e6);
    assert!(!board.swv_take().itm.is_empty());
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-rfid-rc522"]
fn rc522_reads_the_uid_and_blocks_of_the_card_placed_on_it() {
    let n = "nucleo";
    let mut signals = m19_signals();
    signals.insert("D9".into(), "PC7".into());
    let mut circuit = m19_circuit(
        serde_json::json!([
            {"id": "rfid", "kind": "rfid-rc522", "props": {"card": 0}},
            {"id": "rg", "kind": "resistor", "props": {"ohms": "220"}},
            {"id": "green", "kind": "led-5mm", "props": {"color": "green"}},
            {"id": "rr", "kind": "resistor", "props": {"ohms": "220"}},
            {"id": "red", "kind": "led-5mm", "props": {"color": "red"}}
        ]),
        &[
            ((n, "3V3"), ("rfid", "3V3")),
            (("rfid", "GND"), (n, "GND")),
            ((n, "D13"), ("rfid", "SCK")),
            ((n, "D12"), ("rfid", "MISO")),
            ((n, "D11"), ("rfid", "MOSI")),
            ((n, "D10"), ("rfid", "SDA")),
            ((n, "D9"), ("rfid", "RST")),
            ((n, "D7"), ("rg", "1")),
            (("rg", "2"), ("green", "A")),
            (("green", "K"), (n, "GND")),
            ((n, "D6"), ("rr", "1")),
            (("rr", "2"), ("red", "A")),
            (("red", "K"), (n, "GND")),
        ],
    );
    let mut board = Nucleo::new();
    board
        .load_elf(&hal_firmware("hal-rfid-rc522", "hal-rfid-rc522"))
        .unwrap();
    board.set_circuit(&circuit, &simucleo_nucleo::BusCatalog::default(), &signals);
    board.run_for_ns(300e6);
    let text = console_text(&mut board);
    assert!(text.contains("MFRC522 version 0x92 (v2.0)"), "{text}");
    assert!(text.contains("Place a card"), "{text}");
    assert!(!text.contains("UID"), "{text}");
    let mut place = |board: &mut Nucleo, card: u32| {
        set_part_props(
            board,
            &mut circuit,
            "rfid",
            serde_json::json!({ "card": card }),
            &signals,
        );
        board.run_for_ns(350e6);
        // The LEDs as they are at the end (frames average over their time).
        board.circuit_frame(0.0);
        board.run_for_ns(50e6);
        console_text(board)
    };
    let lit = |board: &mut Nucleo, id: &str| {
        part_visual(&board.circuit_frame(0.0), id).brightness[0] > 0.3
    };
    // The key fob: allowed; its visits counter goes up on each placing.
    let text = place(&mut board, 3);
    assert!(
        text.contains("UID: C1 9A 6E 22  (ATQA 04 00, SAK 08, MIFARE Classic 1K)"),
        "{text}"
    );
    assert!(text.contains("access granted"), "{text}");
    assert!(text.contains("block 4: 'Fob: staff #42..'"), "{text}");
    assert!(text.contains("visits: 1 (write block 5: OK)"), "{text}");
    assert!(lit(&mut board, "green") && !lit(&mut board, "red"));
    let text = place(&mut board, 0);
    assert!(text.contains("card removed"), "{text}");
    assert!(!lit(&mut board, "green"));
    let text = place(&mut board, 3);
    assert!(text.contains("visits: 2 (write block 5: OK)"), "{text}");
    // Swapping straight to another card: the fob leaves, card A arrives.
    let text = place(&mut board, 1);
    assert!(text.contains("card removed"), "{text}");
    assert!(text.contains("UID: 7A 3B 1C 9D"), "{text}");
    assert!(text.contains("access denied"), "{text}");
    assert!(text.contains("block 4: 'Card A: guest...'"), "{text}");
    assert!(!text.contains("visits"), "{text}");
    assert!(lit(&mut board, "red") && !lit(&mut board, "green"));
    // The Ultralight sticker: 7-byte UID over two cascade levels.
    let text = place(&mut board, 4);
    assert!(
        text.contains("UID: 04 A1 B2 C3 D4 E5 80  (ATQA 44 00, SAK 00, MIFARE Ultralight)"),
        "{text}"
    );
    assert!(text.contains("pages 4-7: 'Sticker: hello R'"), "{text}");
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.circuit_warnings().is_empty(),
        "{:?}",
        board.circuit_warnings()
    );
}
