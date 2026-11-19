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

// ---------------------------------------------------------------- M22

/// Edges of a captured channel, by name.
fn channel(cap: &Value, name: &str) -> (bool, Vec<(f64, bool)>) {
    let ch = cap["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no channel {name}"));
    let edges = ch["edges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e[0].as_f64().unwrap(), e[1].as_bool().unwrap()))
        .collect();
    (ch["level0"].as_bool().unwrap(), edges)
}

fn level_at(level0: bool, edges: &[(f64, bool)], t: f64) -> bool {
    edges
        .iter()
        .take_while(|e| e.0 <= t)
        .last()
        .map_or(level0, |e| e.1)
}

/// UART 8N1 frames on a line: (start time, byte, stop bit high).
fn uart_frames(level0: bool, edges: &[(f64, bool)], bit_ns: f64) -> Vec<(f64, u8, bool)> {
    let mut out = Vec::new();
    let mut after = f64::MIN;
    for &(t, l) in edges {
        if l || t < after {
            continue;
        }
        // A start bit: sample each bit in its middle.
        let byte = (0..8).fold(0u8, |a, i| {
            a | (level_at(level0, edges, t + (1.5 + i as f64) * bit_ns) as u8) << i
        });
        let stop = level_at(level0, edges, t + 9.5 * bit_ns);
        out.push((t, byte, stop));
        after = t + 9.6 * bit_ns;
    }
    out
}

/// Bytes on `data` sampled at the rising edges of `clock`.
fn sampled_bytes(clock: &(bool, Vec<(f64, bool)>), data: &(bool, Vec<(f64, bool)>)) -> Vec<u8> {
    let rises: Vec<f64> = clock.1.iter().filter(|e| e.1).map(|e| e.0).collect();
    rises
        .chunks(8)
        .filter(|c| c.len() == 8)
        .map(|c| {
            c.iter()
                .fold(0u8, |a, &t| a << 1 | level_at(data.0, &data.1, t) as u8)
        })
        .collect()
}

/// I2C events on SCL/SDA: "S", "P" and bytes with their acknowledge
/// ("ECA": 0xEC acknowledged, "N" for NACK).
fn i2c_decode(scl: &(bool, Vec<(f64, bool)>), sda: &(bool, Vec<(f64, bool)>)) -> Vec<String> {
    let mut all: Vec<(f64, bool, bool)> = scl.1.iter().map(|e| (e.0, true, e.1)).collect();
    all.extend(sda.1.iter().map(|e| (e.0, false, e.1)));
    all.sort_by(|a, b| a.0.total_cmp(&b.0));
    let (mut c, mut d) = (scl.0, sda.0);
    let mut bits = Vec::new();
    let mut out = Vec::new();
    for (_, is_scl, l) in all {
        if is_scl {
            c = l;
            if c {
                bits.push(d);
                if bits.len() == 9 {
                    let b = bits[..8].iter().fold(0u8, |a, &x| a << 1 | x as u8);
                    out.push(format!("{b:02X}{}", if bits[8] { "N" } else { "A" }));
                    bits.clear();
                }
            }
        } else {
            d = l;
            if c {
                out.push(if d { "P" } else { "S" }.to_string());
                bits.clear();
            }
        }
    }
    out
}

fn wired(sim: &mut Simulator, circuit: Value, signals: &[(&str, &str)]) {
    let signals: serde_json::Map<String, Value> = signals
        .iter()
        .map(|(a, b)| (a.to_string(), Value::from(*b)))
        .collect();
    sim.set_wiring(
        &circuit.to_string(),
        "{}",
        &Value::Object(signals).to_string(),
    )
    .unwrap();
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-uart-printf"]
fn uart_tx_shows_the_printed_text_as_frames_at_the_baud_rate() {
    let mut sim = Simulator::new();
    sim.load_elf(&firmware("hal-uart-printf")).unwrap();
    sim.set_probes(r#"["PA2"]"#).unwrap();
    // The first start bit, 10 ms/div, 10 % before it.
    sim.set_trigger(
        r#"{"source":"PA2","edge":"falling","mode":"single","windowNs":100000000,"pre":0.1}"#,
    )
    .unwrap();
    let cap = next_capture(&mut sim, 300.0).expect("a capture");
    let console = sim.take_console();
    let pa2 = channel(&cap, "PA2");
    // Idle high before the first frame (synthesized: the GPIO does not
    // toggle, USART2 moves bytes).
    assert!(level_at(pa2.0, &pa2.1, -1.0), "TX idles high");
    let bit = 1e9 / 115_200.0;
    let frames = uart_frames(pa2.0, &pa2.1, bit);
    assert!(frames.len() > 50, "{} frames", frames.len());
    assert!(frames.iter().all(|f| f.2), "framing error");
    let text: String = frames.iter().map(|f| f.1 as char).collect();
    assert!(text.starts_with("Hello from Simucleo!"), "{text:?}");
    assert!(
        console.starts_with(&text[..text.len().min(60)]),
        "{text:?} vs {console:?}"
    );
    // Every edge on a bit boundary of the first frame's start, at the baud
    // rate USART2.BRR gives: PCLK1 42 MHz / BRR (≈ 115 200).
    let brr = sim.read_word(0x4000_4408) as f64;
    let baud = 42e6 / brr;
    assert!((baud - 115_200.0).abs() < 0.01 * 115_200.0, "{baud}");
    let bit = 1e9 / baud;
    let t0 = frames[0].0;
    // (The first line goes out back to back.)
    let t1 = frames[40].0;
    for &(t, _) in pa2.1.iter().filter(|e| e.0 >= t0 && e.0 < t1) {
        let k = (t - t0) / bit;
        assert!((k - k.round()).abs() < 0.01, "edge {k} bits in");
    }
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-bmp280"]
fn i2c_bmp280_shows_start_address_and_ack() {
    let mut sim = Simulator::new();
    sim.load_elf(&firmware("hal-bmp280")).unwrap();
    wired(
        &mut sim,
        serde_json::json!({
            "parts": [
                {"id": "nucleo", "kind": "nucleo-f401re"},
                {"id": "baro", "kind": "bmp280", "props": {"address": "0x76"}}
            ],
            "wires": [
                {"a": {"part": "nucleo", "pin": "3V3"}, "b": {"part": "baro", "pin": "VCC"}},
                {"a": {"part": "baro", "pin": "GND"}, "b": {"part": "nucleo", "pin": "GND"}},
                {"a": {"part": "nucleo", "pin": "D15"}, "b": {"part": "baro", "pin": "SCL"}},
                {"a": {"part": "nucleo", "pin": "D14"}, "b": {"part": "baro", "pin": "SDA"}}
            ]
        }),
        &[("D15", "PB8"), ("D14", "PB9")],
    );
    sim.set_probes(r#"["PB8","PB9"]"#).unwrap();
    // SDA falling: the START of the first transaction; 100 µs/div.
    sim.set_trigger(
        r#"{"source":"PB9","edge":"falling","mode":"single","windowNs":1000000,"pre":0.1}"#,
    )
    .unwrap();
    let cap = next_capture(&mut sim, 500.0).expect("a capture");
    let (scl, sda) = (channel(&cap, "PB8"), channel(&cap, "PB9"));
    assert!(scl.0 && sda.0, "bus idle high before the START");
    let ev = i2c_decode(&scl, &sda);
    // HAL_I2C_Mem_Read: START, 0x76 + W, register, repeated START, 0x76 + R.
    assert_eq!(&ev[..2], &["S", "ECA"], "{ev:?}");
    let sr = ev
        .iter()
        .skip(1)
        .position(|e| e == "S")
        .expect("repeated START")
        + 1;
    assert_eq!(ev[sr + 1], "EDA", "{ev:?}");
    assert!(ev.contains(&"P".to_string()), "{ev:?}");
    // 100 kHz SCL.
    let rises: Vec<f64> = scl.1.iter().filter(|e| e.1).map(|e| e.0).collect();
    let period = rises[1] - rises[0];
    assert!((period - 10_000.0).abs() < 100.0, "SCL period {period} ns");
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-shift-register"]
fn spi_bursts_carry_the_bytes_the_firmware_sends() {
    let mut sim = Simulator::new();
    sim.load_elf(&firmware("hal-shift-register")).unwrap();
    sim.set_probes(r#"["PA5","PA7"]"#).unwrap();
    // SCK rising, 1 µs/div: a byte (two after the first 0x00) per capture.
    sim.set_trigger(
        r#"{"source":"PA5","edge":"rising","mode":"normal","windowNs":10000,"pre":0.1}"#,
    )
    .unwrap();
    let mut sent = Vec::new();
    for _ in 0..8 {
        let cap = next_capture(&mut sim, 200.0).expect("a capture");
        let (sck, mosi) = (channel(&cap, "PA5"), channel(&cap, "PA7"));
        assert!(!sck.0, "CPOL 0: SCK idles low");
        let rises: Vec<f64> = sck.1.iter().filter(|e| e.1).map(|e| e.0).collect();
        assert!(
            !rises.is_empty() && rises.len().is_multiple_of(8),
            "whole bytes: {rises:?}"
        );
        // PCLK2 / 16 = 5.25 MHz.
        let period = (rises[7] - rises[0]) / 7.0;
        assert!((period - 1e9 / 5.25e6).abs() < 2.0 * CYCLE_NS, "{period}");
        sent.extend(sampled_bytes(&sck, &mosi));
    }
    // What the firmware printed for each byte it sent: "… 0x08".
    let console = sim.take_console();
    let printed: Vec<u8> = console
        .lines()
        .filter_map(|l| l.trim().rsplit("0x").next())
        .filter_map(|h| u8::from_str_radix(h.trim(), 16).ok())
        .collect();
    assert!(sent.iter().all(|b| b.count_ones() <= 1), "{sent:02X?}");
    let n = sent.len().min(printed.len()).min(6);
    assert!(n >= 5, "{sent:02X?} {printed:02X?}");
    // The captures follow the bytes one by one (the first, 0x00, clears).
    let s = sent
        .iter()
        .position(|&b| b == printed[0])
        .expect("first byte");
    assert_eq!(
        &sent[s..s + n - 1],
        &printed[..n - 1],
        "{sent:02X?} vs {printed:02X?}"
    );
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-adc-servo"]
fn analog_channel_on_the_pot_wiper_shows_its_voltage() {
    let circuit = |pos: f64| {
        serde_json::json!({
            "parts": [
                {"id": "nucleo", "kind": "nucleo-f401re"},
                {"id": "pot", "kind": "potentiometer", "props": {"ohms": "10k", "position": pos}}
            ],
            "wires": [
                {"a": {"part": "nucleo", "pin": "3V3"}, "b": {"part": "pot", "pin": "2"}},
                {"a": {"part": "pot", "pin": "1"}, "b": {"part": "nucleo", "pin": "GND"}},
                {"a": {"part": "pot", "pin": "W"}, "b": {"part": "nucleo", "pin": "A0"}}
            ]
        })
    };
    let mut sim = Simulator::new();
    sim.load_elf(&firmware("hal-adc-servo")).unwrap();
    wired(&mut sim, circuit(0.75), &[("A0", "PA0")]);
    sim.set_analog_probes(r#"["pot.W","PA0"]"#).unwrap();
    sim.run_for_ms(50.0);
    let f: Value = serde_json::from_str(&sim.frame()).unwrap();
    let a = f["analog"].as_array().unwrap();
    assert_eq!(a[0]["name"], "V(pot.W)");
    for ch in a {
        let v = ch["v0"].as_f64().unwrap();
        assert!((v - 0.75 * 3.3).abs() < 0.02, "{ch}");
    }
    // Turn the pot: the change is a sample, and a level trigger falling
    // through 1.65 V captures it with the voltage before.
    sim.set_trigger(
        r#"{"source":"V(pot.W)","edge":"falling","mode":"single","windowNs":2000000,"pre":0.5,"level":1.65,"hysteresis":0.1}"#,
    )
    .unwrap();
    sim.run_for_ms(5.0);
    wired(&mut sim, circuit(0.2), &[("A0", "PA0")]);
    let cap = next_capture(&mut sim, 50.0).expect("a capture");
    let ch = &cap["analog"][0];
    assert_eq!(ch["name"], "V(pot.W)");
    assert!((ch["v0"].as_f64().unwrap() - 2.475).abs() < 0.02, "{ch}");
    let s = ch["samples"].as_array().unwrap();
    assert_eq!(s[0][0].as_f64(), Some(0.0), "the trigger is the change");
    assert!((s[0][1].as_f64().unwrap() - 0.66).abs() < 0.02, "{ch}");
    // And the firmware's ADC reads the same: 0.2 × 4095.
    sim.run_for_ms(1000.0);
    let console = sim.take_console();
    let last = console
        .lines()
        .rev()
        .find(|l| l.starts_with("pot"))
        .unwrap();
    let pot: f64 = last.split_whitespace().nth(1).unwrap().parse().unwrap();
    assert!((pot - 819.0).abs() < 15.0, "{last}");
}
