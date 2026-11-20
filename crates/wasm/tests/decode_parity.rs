//! The content trigger's streaming decoders (src/decode.rs) against the
//! waveform view's TypeScript decoders (web/src/run/decode.ts): the
//! fixture holds synthetic streams with the items and content matches the
//! TypeScript side found in them (written by `web/scripts/decode-parity.ts`
//! and checked against the TypeScript decoders by `npm test`). Here every
//! stream goes through the Rust decoders edge by edge — in run slices of
//! random length, and with simultaneous edges in either order — and must
//! give the same.

use serde::Deserialize;
use serde_json::Value;
use simucleo_wasm::decode::{Decoder, DecoderSpec, Fault, Item, Kind, Match, Matcher};

#[derive(Deserialize)]
struct Line {
    level0: bool,
    edges: Vec<(f64, bool)>,
}

#[derive(Deserialize)]
struct MatchCase {
    #[serde(rename = "match")]
    m: Match,
    starts: Vec<f64>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    decoder: DecoderSpec,
    from: f64,
    lines: Vec<Option<Line>>,
    items: Vec<Value>,
    matches: Vec<MatchCase>,
}

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("fixtures/decode-parity.json")).unwrap()
}

/// How the edges are fed.
#[derive(Clone, Copy, Debug)]
enum Feed {
    /// Time order, the decoder's first pin first at equal times, with an
    /// `advance` at random points between edges (run slices).
    Slices(u64),
    /// Time order, the last pin first at equal times, no slices.
    Reversed,
}

fn decode(case: &Case, feed: Feed) -> Vec<Item> {
    let levels: Vec<bool> = case
        .lines
        .iter()
        .map(|l| l.as_ref().is_some_and(|l| l.level0))
        .collect();
    let present: Vec<bool> = case.lines.iter().map(Option::is_some).collect();
    let mut dec = Decoder::new(&case.decoder, &levels, &present, case.from).unwrap();
    let mut all: Vec<(f64, usize, bool)> = case
        .lines
        .iter()
        .enumerate()
        .filter_map(|(k, l)| l.as_ref().map(|l| (k, l)))
        .flat_map(|(k, l)| l.edges.iter().map(move |&(t, v)| (t, k, v)))
        .collect();
    match feed {
        Feed::Slices(_) => all.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1))),
        Feed::Reversed => all.sort_by(|a, b| a.0.total_cmp(&b.0).then(b.1.cmp(&a.1))),
    }
    let mut out = Vec::new();
    let mut seed = match feed {
        Feed::Slices(s) => s,
        Feed::Reversed => 0,
    };
    let mut prev = f64::MIN;
    for &(t, k, v) in &all {
        if seed != 0 && t > prev {
            // A run slice ends somewhere between the last edge and this one
            // (or exactly at the last one).
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let x = (seed >> 33) as f64 / (1u64 << 31) as f64;
            if x < 0.3 && prev > f64::MIN {
                let at = if x < 0.1 { prev } else { prev + (t - prev) * x };
                dec.advance(at, &mut out);
            }
        }
        dec.edge(k, t, v, &mut out);
        prev = t;
    }
    dec.advance(prev + 1e10, &mut out);
    out
}

fn summarize(items: &[Item]) -> Vec<Value> {
    let mut v: Vec<&Item> = items.iter().collect();
    v.sort_by(|a, b| {
        a.start
            .total_cmp(&b.start)
            .then(a.kind.name().cmp(b.kind.name()))
    });
    v.iter()
        .map(|a| {
            serde_json::json!([
                a.kind.name(),
                a.start,
                a.end,
                a.value,
                a.miso,
                a.addr,
                a.read.map(|r| if r { "R" } else { "W" }),
                a.index,
                a.fault.map(|f| match f {
                    Fault::Partial => "partial",
                    Fault::Other => "other",
                }),
            ])
        })
        .collect()
}

fn same_item(a: &Value, b: &Value) -> bool {
    let (a, b) = (a.as_array().unwrap(), b.as_array().unwrap());
    a.len() == b.len()
        && a.iter().zip(b).enumerate().all(|(k, (x, y))| {
            if k == 1 || k == 2 {
                let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
                // Starts are edge times (exact); ends may be computed.
                if k == 1 {
                    x == y
                } else {
                    (x - y).abs() <= 1e-6 * y.abs().max(1.0)
                }
            } else if let (Some(x), Some(y)) = (x.as_f64(), y.as_f64()) {
                x == y
            } else {
                x == y
            }
        })
}

#[test]
fn rust_decoders_give_the_typescript_items_and_matches() {
    let f = fixture();
    assert!(f.cases.len() >= 20, "{} cases", f.cases.len());
    for case in &f.cases {
        for feed in [Feed::Slices(1), Feed::Slices(0x5eed), Feed::Reversed] {
            let items = decode(case, feed);
            let got = summarize(&items);
            assert_eq!(
                got.len(),
                case.items.len(),
                "{} ({feed:?}): {} items, TypeScript {}",
                case.name,
                got.len(),
                case.items.len()
            );
            for (i, (g, e)) in got.iter().zip(&case.items).enumerate() {
                assert!(
                    same_item(g, e),
                    "{} ({feed:?}) item {i}: {g} vs TypeScript {e}",
                    case.name
                );
            }
            for mc in &case.matches {
                let mut m = Matcher::new(mc.m.clone());
                let starts: Vec<f64> = items.iter().filter_map(|it| m.item(it)).collect();
                assert_eq!(
                    starts, mc.starts,
                    "{} ({feed:?}): matches of {:?}",
                    case.name, mc.m
                );
            }
        }
    }
}

#[test]
fn every_kind_of_item_and_error_is_covered() {
    let f = fixture();
    let mut seen = std::collections::BTreeSet::new();
    for c in &f.cases {
        for it in &c.items {
            seen.insert(format!(
                "{}:{}:{}",
                c.decoder.kind,
                it[0].as_str().unwrap(),
                it[8]
            ));
        }
        for m in &c.matches {
            assert!(
                !m.starts.is_empty()
                    || matches!(m.m, Match::Nec { addr: Some(1), .. })
                    || c.decoder.lsb_first
                    || c.name.contains("spi"),
                "{}: {:?} never matches",
                c.name,
                m.m
            );
        }
    }
    for want in [
        "uart:data:null",
        "uart:data:\"other\"",
        "i2c:address:\"other\"",
        "i2c:restart:null",
        "onewire:data:\"partial\"",
        "onewire:reset:\"other\"",
        "onewire:triplet:null",
        "ws2812:pixel:\"partial\"",
        "ws2812:pixel:\"other\"",
        "nec:leader:null",
        "nec:leader:\"partial\"",
        "nec:leader:\"other\"",
        "nec:repeat:null",
    ] {
        assert!(seen.contains(want), "no {want} in the fixture: {seen:?}");
    }
    let _ = Kind::Data;
}
