//! The oscilloscope trigger on example firmware, through the same entry
//! points the web worker uses. Build the firmware first (see
//! `crates/nucleo/tests/firmware.rs`), then
//! `cargo test -p simucleo-wasm --test scope_firmware -- --include-ignored`.

use std::path::PathBuf;

use serde_json::Value;
use simucleo_wasm::Simulator;

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

/// Run until a capture arrives in a frame (at most `ms` of simulated time).
fn next_capture(sim: &mut Simulator, ms: f64) -> Option<Value> {
    let mut t = 0.0;
    while t < ms {
        let why = sim.run_for_ms(5.0);
        assert_eq!(why, "", "firmware stopped");
        t += 5.0;
        let f: Value = serde_json::from_str(&sim.frame()).unwrap();
        if !f["scope"]["capture"].is_null() {
            return Some(f["scope"]["capture"].clone());
        }
    }
    None
}

/// High pulse widths (ns) of a captured channel: rising then falling edge.
fn high_widths(ch: &Value) -> Vec<f64> {
    let edges: Vec<(f64, bool)> = ch["edges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e[0].as_f64().unwrap(), e[1].as_bool().unwrap()))
        .collect();
    edges
        .windows(2)
        .filter(|w| w[0].1 && !w[1].1)
        .map(|w| w[1].0 - w[0].0)
        .collect()
}

const CYCLE_NS: f64 = 1e9 / 84e6;

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-adc-servo"]
fn servo_pulse_width_matches_what_the_firmware_sets() {
    let mut sim = Simulator::new();
    sim.load_elf(&firmware("hal-adc-servo")).unwrap();
    sim.set_probes(r#"["PC7"]"#).unwrap();
    // 400 µs/div, trigger at 10%.
    sim.set_trigger(
        r#"{"source":"PC7","edge":"rising","mode":"normal","windowNs":4000000,"pre":0.1}"#,
    )
    .unwrap();
    sim.run_for_ms(600.0);
    let console = sim.take_console();
    // "… servo 1499 us …": the compare value of the last line printed.
    let us: f64 = console
        .rsplit("servo ")
        .next()
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| panic!("no servo line in {console:?}"));
    sim.frame();
    let cap = next_capture(&mut sim, 100.0).expect("a capture");
    let ch = &cap["channels"][0];
    assert_eq!(ch["name"], "PC7");
    // The trigger is the rising edge at t = 0.
    assert_eq!(ch["edges"][0][0].as_f64(), Some(0.0));
    let w = high_widths(ch);
    assert_eq!(w.len(), 1, "one pulse in 4 ms: {w:?}");
    assert!(
        (w[0] - us * 1000.0).abs() <= CYCLE_NS,
        "pulse {} ns, firmware sets {us} µs",
        w[0]
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-neopixel-dma"]
fn neopixel_bits_are_captured_at_full_resolution() {
    let mut sim = Simulator::new();
    sim.load_elf(&firmware("hal-neopixel-dma")).unwrap();
    sim.set_probes(r#"["PB4"]"#).unwrap();
    // 1 µs/div: 10 µs, 8 bits of 1.25 µs.
    sim.set_trigger(
        r#"{"source":"PB4","edge":"rising","mode":"single","windowNs":10000,"pre":0.1}"#,
    )
    .unwrap();
    let cap = next_capture(&mut sim, 500.0).expect("a capture");
    let ch = &cap["channels"][0];
    let w = high_widths(ch);
    assert!(w.len() >= 7, "{w:?}");
    // T0H = 34 and T1H = 67 timer ticks at 84 MHz (0.40 and 0.80 µs).
    for x in &w {
        let ok = [34.0, 67.0]
            .iter()
            .any(|t| (x - t * CYCLE_NS).abs() <= CYCLE_NS);
        assert!(ok, "high {x} ns is no WS2812 bit: {w:?}");
    }
    // Single: nothing more.
    assert!(next_capture(&mut sim, 100.0).is_none());
    let f: Value = serde_json::from_str(&sim.frame()).unwrap();
    assert_eq!(f["scope"]["state"], "stopped");
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-adc-servo"]
fn pause_on_trigger_stops_the_run_just_after_the_window() {
    let mut sim = Simulator::new();
    sim.load_elf(&firmware("hal-adc-servo")).unwrap();
    sim.set_probes(r#"["PC7"]"#).unwrap();
    sim.set_trigger(
        r#"{"source":"PC7","edge":"rising","mode":"single","windowNs":2000000,"pre":0.5,"pause":true}"#,
    )
    .unwrap();
    let before = sim.time_ms();
    assert_eq!(sim.run_for_ms(100.0), "");
    assert!(sim.trigger_paused());
    let f: Value = serde_json::from_str(&sim.frame()).unwrap();
    let cap = &f["scope"]["capture"];
    let end_ms = cap["triggerMs"].as_f64().unwrap() + cap["endNs"].as_f64().unwrap() / 1e6;
    let now = f["timeMs"].as_f64().unwrap();
    assert!(
        now >= end_ms && now - end_ms < 0.05,
        "paused at {now} ms, window ends {end_ms} ms"
    );
    assert!(now - before < 50.0, "paused within the first servo periods");
}
