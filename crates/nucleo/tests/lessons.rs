//! The lesson firmware of M32 (`firmware/lesson-*`), run without a circuit.
//! Build it first (see .github/workflows/ci.yml), then
//! `cargo test --release -p simucleo-nucleo --test lessons -- --include-ignored`.
//! The web lessons grade the same firmware in its circuits (web/e2e/m32.spec.ts).

use std::path::PathBuf;

use simucleo_nucleo::Nucleo;

fn board(project: &str) -> Nucleo {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "firmware",
        project,
        "build",
        &format!("{project}.elf"),
    ]
    .iter()
    .collect();
    let elf = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (run `make -C firmware/{project}`)", path.display()));
    let mut board = Nucleo::new();
    board.load_elf(&elf).unwrap();
    board
}

fn console_text(board: &mut Nucleo) -> String {
    let out: Vec<u8> = board.take_console().iter().map(|b| b.byte).collect();
    String::from_utf8_lossy(&out).into_owned()
}

/// Times in ms of the changes of pin `pin` of port `port` (0 = A, 1 = B, …).
fn toggles_ms(board: &mut Nucleo, port: u8, pin: u8) -> Vec<(f64, Option<bool>)> {
    let events = board.take_pin_events();
    events
        .iter()
        .filter(|e| e.port == port && e.pin == pin)
        .map(|e| (board.ns_at(e.time) / 1e6, e.level))
        .collect()
}

fn rises(t: &[(f64, Option<bool>)]) -> Vec<f64> {
    t.iter()
        .filter(|(_, l)| *l == Some(true))
        .map(|(t, _)| *t)
        .collect()
}

fn gaps(t: &[f64]) -> Vec<f64> {
    t.windows(2).map(|w| w[1] - w[0]).collect()
}

fn healthy(board: &mut Nucleo, r: &simucleo_core::cpu::RunResult) {
    assert!(board.diagnose(r).is_none(), "{:?}", board.diagnose(r));
    assert!(board.bus.warnings.is_empty(), "{:?}", board.bus.warnings);
    assert!(
        board.bus.regs.accesses.is_empty(),
        "unmodelled: {:?}",
        board.bus.regs.accesses
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/lesson-led-on"]
fn led_on_drives_d7_high_and_sleeps() {
    let mut b = board("lesson-led-on");
    let r = b.run_for_ns(100e6);
    healthy(&mut b, &r);
    assert!(b.pin('A', 8) && b.pin('A', 5));
    assert!(console_text(&mut b).contains("D7 (PA8) = 1, LD2 (PA5) = 1: LEDs on"));
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/lesson-button-poll"]
fn button_poll_follows_d2_with_the_led() {
    let mut b = board("lesson-button-poll");
    b.run_for_ns(50e6);
    assert!(b.pin('A', 10), "the pull-up holds D2 high");
    assert!(!b.pin('A', 8));
    for i in 1..=2 {
        b.drive_pin(0, 10, Some(false)); // pressed: D2 to GND
        b.run_for_ns(60e6);
        assert!(b.pin('A', 8), "press {i}: LED on");
        b.drive_pin(0, 10, None);
        let r = b.run_for_ns(60e6);
        healthy(&mut b, &r);
        assert!(!b.pin('A', 8), "release {i}: LED off");
        let text = console_text(&mut b);
        assert!(
            text.contains(&format!("pressed ({i})\r\nreleased\r\n")),
            "{text:?}"
        );
    }
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/lesson-knight-rider"]
fn knight_rider_sweeps_with_a_600ms_period_at_the_ends() {
    let mut b = board("lesson-knight-rider");
    let r = b.run_for_ns(3.2e9);
    healthy(&mut b, &r);
    let events = b.take_pin_events();
    // D2 (PA10) and D5 (PB4): once per sweep of 6 steps × 101 ms (HAL_Delay(100)).
    for (port, pin) in [(0u8, 10u8), (1, 4)] {
        let r: Vec<f64> = events
            .iter()
            .filter(|e| e.port == port && e.pin == pin && e.level == Some(true))
            .map(|e| b.ns_at(e.time) / 1e6)
            .collect();
        assert!(r.len() >= 4, "{port}.{pin}: {r:?}");
        assert!(
            gaps(&r).iter().all(|g| (600.0..615.0).contains(g)),
            "{port}.{pin}: {:?}",
            gaps(&r)
        );
    }
    // Only one LED at a time.
    for (port, pin) in [(1u8, 3u8), (1, 5)] {
        assert!(
            events.iter().any(|e| e.port == port && e.pin == pin),
            "{port}.{pin} never changed"
        );
    }
    assert!(console_text(&mut b).contains("sweep 3"));
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/lesson-timer-irq"]
fn timer_interrupt_keeps_its_period_while_the_main_loop_drifts() {
    let mut b = board("lesson-timer-irq");
    let r = b.run_for_ns(2.5e9);
    healthy(&mut b, &r);
    let events = b.take_pin_events();
    let times = |port: u8, pin: u8| -> Vec<f64> {
        events
            .iter()
            .filter(|e| e.port == port && e.pin == pin)
            .map(|e| b.ns_at(e.time) / 1e6)
            .collect()
    };
    // D7: every 50 timer interrupts; LD2 every 500 — to the microsecond.
    let d7 = gaps(&times(0, 8));
    assert!(
        d7.len() >= 40 && d7.iter().all(|g| (g - 50.0).abs() < 0.05),
        "{d7:?}"
    );
    let ld2 = gaps(&times(0, 5));
    assert!(
        ld2.len() >= 3 && ld2.iter().all(|g| (g - 500.0).abs() < 0.05),
        "{ld2:?}"
    );
    // D6 from HAL_Delay(50) + printf: longer, by the loop's own work.
    let d6 = gaps(&times(1, 10));
    assert!(d6.iter().skip(1).all(|g| *g > 51.5 && *g < 56.0), "{d6:?}");
    assert!(console_text(&mut b).contains("loop 10: tick "));
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/lesson-uart-cmd"]
fn uart_command_line_parses_and_answers() {
    let mut b = board("lesson-uart-cmd");
    b.run_for_ns(50e6);
    for cmd in ["help", "LED on", "blink 5", "blink 100", "fly"] {
        b.console_send(format!("{cmd}\r\n").as_bytes());
        b.run_for_ns(50e6);
    }
    b.take_pin_events();
    let r = b.run_for_ns(1e9);
    healthy(&mut b, &r);
    let text = console_text(&mut b);
    for want in [
        "Command line ready - type help\r\n",
        "> help\r\nOK commands: help, led on, led off, blink <ms>, status\r\n",
        "> led on\r\nOK led on\r\n",
        "> blink 5\r\nERR blink: 20-2000 ms\r\n",
        "> blink 100\r\nOK blink 100 ms\r\n",
        "> fly\r\nERR unknown command 'fly' - type help\r\n",
    ] {
        assert!(text.contains(want), "{want:?} in {text:?}");
    }
    let t: Vec<f64> = toggles_ms(&mut b, 0, 5).iter().map(|(t, _)| *t).collect();
    assert!(
        t.len() >= 9 && gaps(&t).iter().all(|g| (g - 100.0).abs() < 1.0),
        "{t:?}"
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/lesson-sleep-wfi"]
fn wfi_sleeps_between_timer_interrupts_and_busy_waiting_does_not() {
    let mut b = board("lesson-sleep-wfi");
    let r = b.run_for_ns(2.1e9);
    healthy(&mut b, &r);
    let text = console_text(&mut b);
    let asleep: Vec<f64> = text
        .lines()
        .filter_map(|l| l.strip_prefix("WFI: asleep "))
        .map(|l| l.split('%').next().unwrap().parse().unwrap())
        .collect();
    assert!(
        !asleep.is_empty() && asleep.iter().all(|a| *a > 95.0),
        "{text:?}"
    );
    let d7 = rises(&toggles_ms(&mut b, 0, 8));
    assert!(gaps(&d7).iter().all(|g| (g - 200.0).abs() < 0.5), "{d7:?}");

    b.set_user_button(true);
    b.run_for_ns(250e6);
    b.set_user_button(false);
    let r = b.run_for_ns(2.2e9);
    healthy(&mut b, &r);
    let text = console_text(&mut b);
    assert!(text.contains("mode busy-wait\r\n"), "{text:?}");
    assert!(text.contains("busy: asleep 0.0% of 10"), "{text:?}");
    // The LED does not notice.
    let d7 = rises(&toggles_ms(&mut b, 0, 8));
    assert!(gaps(&d7).iter().all(|g| (g - 200.0).abs() < 0.5), "{d7:?}");
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/lesson-scope-mystery"]
fn scope_mystery_signals_have_the_documented_frequency_and_duty() {
    let mut b = board("lesson-scope-mystery");
    b.run_for_ns(20e6);
    b.take_pin_events();
    let r = b.run_for_ns(1.1e9);
    healthy(&mut b, &r);
    let events = b.take_pin_events();
    // (port, pin, period µs, high µs): D3, D6, D5, D9.
    for (port, pin, period, high) in [
        (1u8, 3u8, 1000.0, 500.0),
        (1, 10, 1000.0, 750.0),
        (1, 4, 500.0, 125.0),
        (2, 7, 500.0, 300.0),
    ] {
        let e: Vec<(f64, bool)> = events
            .iter()
            .filter(|e| e.port == port && e.pin == pin && e.level.is_some())
            .take(40)
            .map(|e| (b.ns_at(e.time) / 1e3, e.level.unwrap()))
            .collect();
        let up: Vec<f64> = e.iter().filter(|x| x.1).map(|x| x.0).collect();
        assert!(
            gaps(&up).iter().all(|g| (g - period).abs() < 0.5),
            "{port}.{pin}: {:?}",
            gaps(&up)
        );
        let w: Vec<f64> = e
            .windows(2)
            .filter(|w| w[0].1 && !w[1].1)
            .map(|w| w[1].0 - w[0].0)
            .collect();
        assert!(
            !w.is_empty() && w.iter().all(|x| (x - high).abs() < 0.5),
            "{port}.{pin}: {w:?}"
        );
    }
    // D12 blinks at 1 Hz, D11 stays low.
    let d12: Vec<_> = events
        .iter()
        .filter(|e| e.port == 0 && e.pin == 6)
        .collect();
    assert_eq!(d12.len(), 2, "two toggles in 1.1 s");
    assert!(!events
        .iter()
        .any(|e| e.port == 0 && e.pin == 7 && e.level == Some(true)));
    assert!(console_text(&mut b).contains("LED1 goes on the 2 kHz signal with 25% duty"));
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/lesson-parking"]
fn parking_sensor_without_a_sensor_says_no_echo_and_stays_green() {
    let mut b = board("lesson-parking");
    let r = b.run_for_ns(1.2e9);
    healthy(&mut b, &r);
    assert!(console_text(&mut b).contains("dist: no echo  zone GREEN\r\n"));
    assert!(b.pin('B', 5) && !b.pin('B', 4) && !b.pin('B', 10));
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/lesson-thermostat"]
fn thermostat_without_a_sensor_fails_safe() {
    // Nothing on I2C: the OLED and AHT20 do not answer — the heater stays off
    // (relay IN high, active low) instead of an Error_Handler.
    let mut b = board("lesson-thermostat");
    let r = b.run_for_ns(1.5e9);
    assert!(b.diagnose(&r).is_none(), "{:?}", b.diagnose(&r));
    assert!(console_text(&mut b).contains("sensor not answering - heater OFF\r\n"));
    assert!(b.pin('A', 8), "relay IN high = off");
    assert!(!b.pin('A', 5));
}
