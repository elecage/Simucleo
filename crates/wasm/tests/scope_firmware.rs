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

// ---------------------------------------------------------------- M23

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-bldc-pwm"]
fn tim1_dead_time_shows_between_pa8_falling_and_pa7_rising() {
    // The example project as the web loads it.
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/examples/hal-bldc-pwm.simucleo.json"
    );
    let project: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut sim = Simulator::new();
    sim.load_elf(&firmware("hal-bldc-pwm")).unwrap();
    wired(
        &mut sim,
        project,
        &[
            ("D7", "PA8"),
            ("D11", "PA7"),
            ("D8", "PA9"),
            ("A3", "PB0"),
            ("D2", "PA10"),
            ("CN10_24", "PB1"),
            ("D3", "PB3"),
            ("D4", "PB5"),
            ("D6", "PB10"),
            ("A0", "PA0"),
            ("GND_P1", "GND"),
            ("GND_P2", "GND"),
            ("5V", "5V"),
            ("3V3", "3V3"),
        ],
    );
    sim.set_probes(r#"["PA8","PA7"]"#).unwrap();
    sim.run_for_ms(300.0);
    let console = sim.take_console();
    assert!(console.contains("dead time 500 ns"), "{console}");
    // CH1 falling, 10 µs/div (two PWM periods), 10 % before.
    sim.set_trigger(
        r#"{"source":"PA8","edge":"falling","mode":"single","windowNs":100000,"pre":0.1}"#,
    )
    .unwrap();
    let cap = next_capture(&mut sim, 200.0).expect("a capture");
    let (h0, high) = channel(&cap, "PA8");
    let (l0, low) = channel(&cap, "PA7");
    assert!(h0, "CH1 high before the trigger");
    assert_eq!(high.first(), Some(&(0.0, false)));
    // CH1N turns on DTG = 42 ticks of 84 MHz later: 500 ns.
    let dead = 42.0 * CYCLE_NS;
    assert!(!l0 || !h0, "never both on");
    let rise = low.iter().find(|e| e.0 >= 0.0 && e.1).expect("CH1N rises");
    assert!(
        (rise.0 - dead).abs() <= CYCLE_NS,
        "CH1N rose {} ns after CH1 fell",
        rise.0
    );
    // And the other way round: CH1N off, CH1 on 500 ns later.
    let fall = low
        .iter()
        .find(|e| e.0 > rise.0 && !e.1)
        .expect("CH1N falls");
    let up = high
        .iter()
        .find(|e| e.0 > fall.0 && e.1)
        .expect("CH1 rises");
    assert!(
        (up.0 - fall.0 - dead).abs() <= CYCLE_NS,
        "{} vs {}",
        up.0,
        fall.0
    );
    // At no time are both on.
    let mut times: Vec<f64> = high.iter().chain(&low).map(|e| e.0).collect();
    times.sort_by(f64::total_cmp);
    for t in times {
        assert!(
            !(level_at(h0, &high, t) && level_at(l0, &low, t)),
            "both on at {t} ns"
        );
    }
}

// ---------------------------------------------------------------- M26

/// A content trigger's settings as the waveform view sends them.
fn content_trigger(
    decoder: Value,
    m: Value,
    mode: &str,
    window_ns: f64,
    pre: f64,
    pause: bool,
) -> String {
    serde_json::json!({
        "source": "dec:1",
        "edge": "rising",
        "mode": mode,
        "windowNs": window_ns,
        "pre": pre,
        "pause": pause,
        "content": { "decoder": decoder, "match": m },
    })
    .to_string()
}

fn uart_decoder() -> Value {
    serde_json::json!({"id": 1, "type": "uart", "pins": ["PA2"], "baud": 115200, "parity": "none", "mode": 0, "lsbFirst": false})
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-uart-printf"]
fn uart_text_trigger_is_at_the_start_bit_of_the_text() {
    let bit = 1e9 / 115_200.0;
    // Where "tick 1" starts, from a long edge-triggered capture of
    // everything the firmware prints (M22's path).
    let reference = {
        let mut sim = Simulator::new();
        sim.load_elf(&firmware("hal-uart-printf")).unwrap();
        sim.set_probes(r#"["PA2"]"#).unwrap();
        sim.set_trigger(
            r#"{"source":"PA2","edge":"falling","mode":"single","windowNs":1000000000,"pre":0.01}"#,
        )
        .unwrap();
        let cap = next_capture(&mut sim, 1500.0).expect("a capture");
        let pa2 = channel(&cap, "PA2");
        let frames = uart_frames(pa2.0, &pa2.1, bit);
        let text: String = frames.iter().map(|f| f.1 as char).collect();
        let i = text.find("tick 1").unwrap_or_else(|| panic!("{text:?}"));
        cap["triggerMs"].as_f64().unwrap() * 1e6 + frames[i].0
    };
    let mut sim = Simulator::new();
    sim.load_elf(&firmware("hal-uart-printf")).unwrap();
    sim.set_probes(r#"["PA2","PA5"]"#).unwrap();
    sim.set_trigger(&content_trigger(
        uart_decoder(),
        serde_json::json!({"kind": "text", "text": "tick 1"}),
        "single",
        2e6,
        0.1,
        false,
    ))
    .unwrap();
    let f: Value = serde_json::from_str(&sim.frame()).unwrap();
    assert_eq!(f["scope"]["state"], "armed");
    let cap = next_capture(&mut sim, 1000.0).expect("a capture");
    assert_eq!(cap["source"], "dec:1");
    let t0 = cap["triggerMs"].as_f64().unwrap() * 1e6;
    // To the cycle (and closer: the same edge).
    assert!(
        (t0 - reference).abs() < 0.01,
        "triggered at {t0} ns, \"tick 1\" starts at {reference} ns"
    );
    let pa2 = channel(&cap, "PA2");
    assert!(pa2.1.contains(&(0.0, false)), "the start bit at t = 0");
    let after: Vec<(f64, bool)> = pa2.1.iter().copied().filter(|e| e.0 >= 0.0).collect();
    let text: String = uart_frames(true, &after, bit)
        .iter()
        .map(|f| f.1 as char)
        .collect();
    assert!(text.starts_with("tick 1 at "), "{text:?}");
    // 10 % before: the end of "tick 0 …\r\n" is 500 ms back, so idle.
    assert!(pa2.1.iter().all(|e| e.0 >= 0.0), "{:?}", &pa2.1[..3]);
    let f: Value = serde_json::from_str(&sim.frame()).unwrap();
    assert_eq!(f["scope"]["state"], "stopped");
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-uart-printf"]
fn uart_text_trigger_pauses_right_after_the_window() {
    let mut sim = Simulator::new();
    sim.load_elf(&firmware("hal-uart-printf")).unwrap();
    sim.set_probes(r#"["PA2"]"#).unwrap();
    // "tick 2", 1 ms/div, half before.
    sim.set_trigger(&content_trigger(
        uart_decoder(),
        serde_json::json!({"kind": "text", "text": "tick 2"}),
        "normal",
        10e6,
        0.5,
        true,
    ))
    .unwrap();
    assert_eq!(sim.run_for_ms(2000.0), "");
    assert!(sim.trigger_paused());
    let f: Value = serde_json::from_str(&sim.frame()).unwrap();
    let cap = &f["scope"]["capture"];
    let end_ms = cap["triggerMs"].as_f64().unwrap() + cap["endNs"].as_f64().unwrap() / 1e6;
    let now = f["timeMs"].as_f64().unwrap();
    assert!(
        now >= end_ms && now - end_ms < 0.05,
        "paused at {now} ms, window ends {end_ms} ms"
    );
    // "tick 2 at … ms" goes out after the third 250 ms delay: the run
    // stopped there, not 2 s on.
    assert!((750.0..800.0).contains(&now), "{now}");
    assert!(sim.take_console().contains("tick 2"));
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-bmp280"]
fn i2c_address_trigger_in_hal_bmp280() {
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
    // 0x76 + R: the read after the repeated START.
    sim.set_trigger(&content_trigger(
        serde_json::json!({"id": 1, "type": "i2c", "pins": ["PB8", "PB9"], "baud": 115200, "parity": "none", "mode": 0, "lsbFirst": false}),
        serde_json::json!({"kind": "address", "addr": 0x76, "rw": "R"}),
        "single",
        400e3,
        0.25,
        false,
    ))
    .unwrap();
    let cap = next_capture(&mut sim, 500.0).expect("a capture");
    let (scl, sda) = (channel(&cap, "PB8"), channel(&cap, "PB9"));
    let ev = i2c_decode(&scl, &sda);
    // START, 0x76 + W, register, repeated START, 0x76 + R (0xED), …
    let r = ev.iter().position(|e| e == "EDA").expect("0xED");
    assert_eq!(ev[r - 1], "S", "{ev:?}");
    // The address byte starts at t = 0: SCL's fall after the repeated
    // START (the decoder's start of the byte).
    assert!(scl.1.contains(&(0.0, false)), "{:?}", scl.1);
    let sr = sda
        .1
        .iter()
        .rfind(|e| e.0 < 0.0 && !e.1)
        .expect("SDA falls before");
    assert!(
        level_at(scl.0, &scl.1, sr.0),
        "a repeated START: SDA falls while SCL is high"
    );
    assert!(sr.0 > -10_000.0, "{}", sr.0);
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-ir-remote"]
fn nec_command_trigger_in_hal_ir_remote() {
    let mut sim = Simulator::new();
    sim.load_elf(&firmware("hal-ir-remote")).unwrap();
    wired(
        &mut sim,
        serde_json::json!({
            "parts": [
                {"id": "nucleo", "kind": "nucleo-f401re"},
                {"id": "ir", "kind": "ir-receiver"}
            ],
            "wires": [
                {"a": {"part": "nucleo", "pin": "3V3"}, "b": {"part": "ir", "pin": "VCC"}},
                {"a": {"part": "ir", "pin": "GND"}, "b": {"part": "nucleo", "pin": "GND"}},
                {"a": {"part": "nucleo", "pin": "D3"}, "b": {"part": "ir", "pin": "OUT"}}
            ]
        }),
        &[("D3", "PB3")],
    );
    sim.set_probes(r#"["PB3"]"#).unwrap();
    // OK (0x1C) from address 0x00; 10 ms/div, 10 % before.
    sim.set_trigger(&content_trigger(
        serde_json::json!({"id": 1, "type": "nec", "pins": ["PB3"], "baud": 115200, "parity": "none", "mode": 0, "lsbFirst": false}),
        serde_json::json!({"kind": "nec", "cmd": 0x1c, "addr": 0}),
        "single",
        100e6,
        0.1,
        true,
    ))
    .unwrap();
    assert_eq!(sim.run_for_ms(100.0), "");
    sim.take_console();
    // Another key: no trigger.
    sim.press("ir:5", true);
    assert_eq!(sim.run_for_ms(50.0), "");
    sim.press("ir:5", false);
    assert_eq!(sim.run_for_ms(150.0), "");
    assert!(!sim.trigger_paused());
    let f: Value = serde_json::from_str(&sim.frame()).unwrap();
    assert_eq!(f["scope"]["state"], "armed");
    assert!(f["scope"]["capture"].is_null());
    assert_eq!(sim.take_console(), "NEC addr 0x00 cmd 0x40 key 5\r\n");
    // OK, held 30 ms.
    let pressed = sim.time_ms();
    sim.press("ir:OK", true);
    assert_eq!(sim.run_for_ms(30.0), "");
    sim.press("ir:OK", false);
    assert_eq!(sim.run_for_ms(200.0), "");
    assert!(sim.trigger_paused(), "paused on the capture");
    let f: Value = serde_json::from_str(&sim.frame()).unwrap();
    let cap = &f["scope"]["capture"];
    let t0 = cap["triggerMs"].as_f64().unwrap();
    // The leader starts when the key goes down.
    assert!(
        (t0 - pressed).abs() < 0.01,
        "trigger {t0} ms, pressed {pressed} ms"
    );
    let now = f["timeMs"].as_f64().unwrap();
    assert!((now - (t0 + 90.0)).abs() < 0.05, "paused at {now} ms");
    let (l0, edges) = channel(cap, "PB3");
    assert!(l0, "idle high before");
    assert_eq!(
        edges.first(),
        Some(&(0.0, false)),
        "the leader's mark at t = 0"
    );
    // 9 ms mark, 4.5 ms space, then 32 bits by their space width.
    let mark = edges[1].0;
    assert!((mark - 9e6).abs() < 2e3, "{mark}");
    let falls: Vec<f64> = edges.iter().filter(|e| !e.1).map(|e| e.0).collect();
    let bits: u32 = falls[1..34]
        .windows(2)
        .enumerate()
        .map(|(k, w)| u32::from(w[1] - w[0] > 1.6e6) << k)
        .sum();
    assert_eq!(bits.to_le_bytes(), [0x00, 0xff, 0x1c, 0xe3]);
    assert_eq!(sim.take_console(), "NEC addr 0x00 cmd 0x1C key OK\r\n");
}

// ---------------------------------------------------------------- M28

/// Board pins of the BLDC examples (`hal-bldc-pwm`, `hal-bldc-sensorless`).
const BLDC_SIGNALS: &[(&str, &str)] = &[
    ("D7", "PA8"),
    ("D11", "PA7"),
    ("D8", "PA9"),
    ("A3", "PB0"),
    ("D2", "PA10"),
    ("CN10_24", "PB1"),
    ("D3", "PB3"),
    ("D4", "PB5"),
    ("D6", "PB10"),
    ("A0", "PA0"),
    ("A1", "PA1"),
    ("A2", "PA4"),
    ("A4", "PC1"),
    ("A5", "PC0"),
    ("GND_P1", "GND"),
    ("GND_P2", "GND"),
    ("5V", "5V"),
    ("3V3", "3V3"),
];

/// An example project as the web loads it, with the pot at `pot`.
fn example_project(name: &str, pot: f64) -> Value {
    let path = format!(
        "{}/../../web/examples/{name}.simucleo.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let mut project: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for p in project["parts"].as_array_mut().unwrap() {
        if p["id"] == "pot" {
            p["props"]["position"] = pot.into();
        }
    }
    project
}

/// High pulses (rise, fall) of a captured channel.
fn pulses(level0: bool, edges: &[(f64, bool)]) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    let mut rise = None;
    let _ = level0;
    for &(t, high) in edges {
        match (high, rise) {
            (true, _) => rise = Some(t),
            (false, Some(r)) => {
                out.push((r, t));
                rise = None;
            }
            _ => {}
        }
    }
    out
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-bldc-sensorless"]
fn center_aligned_pwm_pulses_stay_centred_when_the_duty_changes() {
    let mut sim = Simulator::new();
    sim.load_elf(&firmware("hal-bldc-sensorless")).unwrap();
    wired(
        &mut sim,
        example_project("hal-bldc-sensorless", 0.5),
        BLDC_SIGNALS,
    );
    sim.set_probes(r#"["PA8","PA7"]"#).unwrap();
    sim.run_for_ms(2500.0);
    assert!(sim.take_console().contains("closed"));
    // Duty 54 % (27 µs pulses); the pot to 87 % (43 µs). Trigger on the
    // first PA8 pulse wider than 35 µs, the narrow ones before it in the
    // window — if the change came while phase A was the chopping one
    // (else try again).
    let period = 50_000.0;
    for attempt in 0..12 {
        sim.set_trigger(
            r#"{"source":"PA8","edge":"rising","mode":"single","windowNs":400000,"pre":0.6,"width":{"cmp":"gt","ns":35000}}"#,
        )
        .unwrap();
        wired(
            &mut sim,
            example_project("hal-bldc-sensorless", 0.1),
            BLDC_SIGNALS,
        );
        let cap = next_capture(&mut sim, 300.0).expect("a wide pulse");
        let (l0, e) = channel(&cap, "PA8");
        let p = pulses(l0, &e);
        let narrow = p.iter().filter(|(r, f)| f - r < 30_000.0).count();
        let wide = p.iter().filter(|(r, f)| f - r > 40_000.0).count();
        if narrow < 2 || wide < 2 {
            // Back to 54 % and wait for a full turn of the steps.
            wired(
                &mut sim,
                example_project("hal-bldc-sensorless", 0.5),
                BLDC_SIGNALS,
            );
            sim.run_for_ms(60.0 + attempt as f64 * 7.0);
            continue;
        }
        // Every pulse is centred on the same 50 µs grid (the underflows)
        // — except the one the update event falls in the middle of: the
        // preloaded CCR1 is loaded there (RCR = 1: one update per period,
        // at the underflow), so that pulse rose at the old width and falls
        // at the new one (RM0368 §12.3.10). Rising edges are not on a grid.
        // The grid: the centre phase most pulses share (to 0.1 µs).
        let phase =
            |x: &(f64, f64)| (((x.0 + x.1) / 2.0).rem_euclid(period) / 100.0).round() as i64;
        let mut counts = std::collections::HashMap::new();
        for x in &p {
            *counts.entry(phase(x)).or_insert(0) += 1;
        }
        let c0 = *counts.iter().max_by_key(|(_, &n)| n).unwrap().0 as f64 * 100.0;
        let off_grid = |t: f64| {
            let k = ((t - c0) / period).round();
            (t - c0 - k * period).abs()
        };
        // (Only pulses with a neighbour a period away on both sides: a
        // commutation may cut the first or last one of a step short.)
        let near = |a: f64, b: f64| ((a - b).abs() - period).abs() < 10_000.0;
        let inner: Vec<(f64, f64)> = (1..p.len().saturating_sub(1))
            .filter(|&i| near(p[i - 1].0, p[i].0) && near(p[i + 1].0, p[i].0))
            .map(|i| p[i])
            .collect();
        assert!(inner.len() >= 3, "{p:?}");
        let odd: Vec<_> = inner
            .iter()
            .filter(|(r, f)| off_grid((r + f) / 2.0) > 2.0 * CYCLE_NS)
            .collect();

        assert_eq!(odd.len(), 1, "{p:?}");
        let (r, f) = *odd[0];
        let w_old = inner[0].1 - inner[0].0;
        let w_new = inner.last().unwrap().1 - inner.last().unwrap().0;
        assert!(w_new - w_old > 10_000.0, "{p:?}");
        let mid = r + w_old / 2.0;
        assert!(off_grid(mid) <= 2.0 * CYCLE_NS, "{p:?}");
        assert!((f - mid - w_new / 2.0).abs() <= 2.0 * CYCLE_NS, "{p:?}");
        let rises: Vec<f64> = p.iter().map(|x| x.0).collect();
        assert!(
            rises.iter().any(|&t| off_grid(t + w_old / 2.0) > 1000.0),
            "{p:?}"
        );
        // The low side: centred between, half a period off, 500 ns dead
        // time on each side.
        let (n0, ne) = channel(&cap, "PA7");
        let lows = pulses(n0, &ne);
        let (r, f) = *p.last().unwrap();
        let low = lows.iter().find(|(lr, _)| *lr > f).expect("CH1N after");
        assert!(
            (low.0 - f - 42.0 * CYCLE_NS).abs() <= CYCLE_NS,
            "{low:?} after {f}"
        );
        let centre = (r + f) / 2.0;
        assert!(
            ((low.0 + low.1) / 2.0 - centre - period / 2.0).abs() <= 2.0 * CYCLE_NS,
            "{low:?} vs centre {centre}"
        );
        return;
    }
    panic!("never caught the duty change on phase A");
}

#[test]
#[ignore = "needs arm-none-eabi-gcc build of firmware/hal-bldc-pwm"]
fn analog_probe_on_a_bridge_output_shows_the_phase_voltage() {
    let mut sim = Simulator::new();
    sim.load_elf(&firmware("hal-bldc-pwm")).unwrap();
    wired(&mut sim, example_project("hal-bldc-pwm", 0.5), BLDC_SIGNALS);
    sim.set_probes(r#"["PA8","PA7"]"#).unwrap();
    sim.set_analog_probes(r#"["br.OUTA","mot.U"]"#).unwrap();
    sim.run_for_ms(1000.0);
    // 12 ms from a PA8 rising edge (an electrical turn at this speed):
    // phase A chopping, its low side on and floating, in turn.
    sim.set_trigger(
        r#"{"source":"PA8","edge":"rising","mode":"single","windowNs":12000000,"pre":0.1}"#,
    )
    .unwrap();
    let cap = next_capture(&mut sim, 100.0).expect("a capture");
    let at = |l0: bool, e: &[(f64, bool)], t: f64| {
        let i = e.partition_point(|x| x.0 <= t);
        if i == 0 {
            l0
        } else {
            e[i - 1].1
        }
    };
    let (h0, hi) = channel(&cap, "PA8");
    let (l0, lo) = channel(&cap, "PA7");
    let a = &cap["analog"][0];
    assert_eq!(a["name"], "V(br.OUTA)");
    let samples: Vec<(f64, f64)> = a["samples"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s[0].as_f64().unwrap(), s[1].as_f64().unwrap()))
        .collect();
    let v_at = |t: f64| {
        let i = samples.partition_point(|s| s.0 <= t);
        if i == 0 {
            a["v0"].as_f64().unwrap()
        } else {
            samples[i - 1].1
        }
    };
    // The phase voltage follows the switches: PVDD (less the switch's
    // drop) while the high side is on, ground while the low side is.
    let (mut high, mut low, mut float) = (0, 0, 0);
    let end = samples.last().unwrap().0;
    let mut t = -1_200_000.0;
    while t < end {
        let (h, l) = (at(h0, &hi, t), at(l0, &lo, t));
        let v = v_at(t);
        match (h, l) {
            (true, false) => {
                assert!(v > 11.0 && v < 12.01, "{v} V at {t} with the high side on");
                high += 1;
            }
            (false, true) => {
                assert!(v.abs() < 1.0, "{v} V at {t} with the low side on");
                low += 1;
            }
            _ => {
                if v > 1.0 && v < 11.0 {
                    float += 1;
                }
            }
        }
        t += 731.0;
    }
    assert!(high > 50 && low > 50, "{high} {low}");
    // Thousands of steps between the PWM: a floating sector in 2 ms shows
    // the back-EMF on top of the star point, between the rails.
    assert!(float > 50, "{float}");
    // The motor's terminal is the same net.
    assert_eq!(cap["analog"][1]["name"], "V(mot.U)");
    assert!(samples.len() > 100, "{}", samples.len());
}
