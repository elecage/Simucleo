//! A bundled web project file (`web/examples/*.simucleo.json`) as the editor
//! hands it to the simulator (`toCircuit` in `web/src/editor/model.ts`):
//! besides the drawn wires, a part's pin that sits in a breadboard hole is
//! joined to that hole, and the breadboard's strips and rails are buses.
//!
//! Since M38 the examples seat their through-hole parts in the breadboard,
//! so a test that loads one needs this. Only the pin offsets of the kinds
//! that sit in a breadboard in the examples loaded here are known; a part
//! of another kind on a breadboard is refused rather than left unconnected.
#![allow(dead_code)]

use serde_json::{json, Value};

/// Pin offsets in grid steps (`web/src/parts/*.tsx`).
fn pins(kind: &str) -> Option<&'static [(&'static str, i64, i64)]> {
    match kind {
        "resistor" => Some(&[("1", 0, 0), ("2", 4, 0)]),
        "potentiometer" => Some(&[("1", 0, 3), ("W", 1, 3), ("2", 2, 3)]),
        _ => None,
    }
}

const COLS: i64 = 30;
const ROWS: [(&str, i64); 10] = [
    ("a", 4),
    ("b", 5),
    ("c", 6),
    ("d", 7),
    ("e", 8),
    ("f", 11),
    ("g", 12),
    ("h", 13),
    ("i", 14),
    ("j", 15),
];
const RAILS: [(&str, i64); 4] = [("tp", 1), ("tn", 2), ("bp", 18), ("bn", 19)];

/// Holes of a half breadboard: (id, x, y) from its origin (`breadboard.tsx`).
fn holes() -> Vec<(String, i64, i64)> {
    let mut out = Vec::new();
    for c in 1..=COLS {
        for (r, y) in ROWS {
            out.push((format!("{r}{c}"), c + 1, y));
        }
        for (r, y) in RAILS {
            if c % 6 != 0 {
                out.push((format!("{r}{c}"), c + 1, y));
            }
        }
    }
    out
}

/// The breadboard's strips (a–e and f–j of each column) and its four rails.
pub fn bus_catalog() -> Value {
    let mut buses: Vec<Vec<String>> = Vec::new();
    for c in 1..=COLS {
        buses.push(ROWS[..5].iter().map(|(r, _)| format!("{r}{c}")).collect());
        buses.push(ROWS[5..].iter().map(|(r, _)| format!("{r}{c}")).collect());
    }
    for (r, _) in RAILS {
        buses.push(
            (1..=COLS)
                .filter(|c| c % 6 != 0)
                .map(|c| format!("{r}{c}"))
                .collect(),
        );
    }
    json!({ "breadboard-half": buses })
}

/// `{ parts, wires }` with a wire from each seated pin to its hole.
pub fn circuit(project: &Value) -> Value {
    let parts = project["parts"].as_array().unwrap();
    let mut wires = project["wires"].as_array().unwrap().clone();
    let at = |p: &Value| (p["x"].as_i64().unwrap(), p["y"].as_i64().unwrap());
    for bb in parts.iter().filter(|p| p["kind"] == "breadboard-half") {
        let (bx, by) = at(bb);
        for part in parts {
            let kind = part["kind"].as_str().unwrap();
            if kind == "breadboard-half" || kind == "nucleo-f401re" {
                continue;
            }
            let (x, y) = at(part);
            let Some(pins) = pins(kind) else {
                // A board 33 × 21 steps: a part of an unknown kind on it may be seated.
                assert!(
                    !(x >= bx && x <= bx + 33 && y >= by - 6 && y <= by + 21),
                    "{} ({kind}) is on a breadboard: add its pins to tests/support/web_project.rs",
                    part["id"]
                );
                continue;
            };
            for (pin, dx, dy) in pins {
                if let Some((hole, _, _)) = holes()
                    .into_iter()
                    .find(|(_, hx, hy)| bx + hx == x + dx && by + hy == y + dy)
                {
                    wires.push(json!({ "a": { "part": part["id"], "pin": pin }, "b": { "part": bb["id"], "pin": hole } }));
                }
            }
        }
    }
    json!({ "parts": project["parts"], "wires": wires })
}
