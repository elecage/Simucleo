//! Wiring → netlist extraction.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

/// A pin on a placed part, e.g. `{ part: "led1", pin: "A" }`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct PinRef {
    pub part: String,
    pub pin: String,
}

impl PinRef {
    pub fn new(part: impl Into<String>, pin: impl Into<String>) -> Self {
        Self {
            part: part.into(),
            pin: pin.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PartInstance {
    pub id: String,
    /// Part definition id, e.g. `"led-5mm"` or `"breadboard-half"`.
    pub kind: String,
    /// Part properties from the editor (`{"ohms": "220"}`, `{"color": "red"}`).
    #[serde(default)]
    pub props: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Wire {
    pub a: PinRef,
    pub b: PinRef,
}

/// What the wiring editor sends to the simulator.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Circuit {
    pub parts: Vec<PartInstance>,
    pub wires: Vec<Wire>,
}

/// Groups of pins that are electrically connected *inside* a part kind
/// (breadboard rows and power rails, the two legs of a tactile switch that
/// are always joined, the GND pins of the Nucleo board, …).
pub trait PartCatalog {
    fn internal_buses(&self, kind: &str) -> &[Vec<String>];
}

/// A [`PartCatalog`] backed by a map, as sent by the front-end:
/// `{ "breadboard-half": [["a1","b1","c1","d1","e1"], ...], ... }`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BusCatalog(pub HashMap<String, Vec<Vec<String>>>);

impl PartCatalog for BusCatalog {
    fn internal_buses(&self, kind: &str) -> &[Vec<String>] {
        self.0.get(kind).map(Vec::as_slice).unwrap_or(&[])
    }
}

/// An electrical net: a set of pins at the same potential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Net {
    pub pins: Vec<PinRef>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Netlist {
    pub nets: Vec<Net>,
}

impl Netlist {
    /// Index of the net containing `pin`, if the pin is connected to anything.
    pub fn net_of(&self, pin: &PinRef) -> Option<usize> {
        self.nets.iter().position(|n| n.pins.contains(pin))
    }
}

struct UnionFind {
    parent: Vec<usize>,
}

impl UnionFind {
    fn find(&mut self, x: usize) -> usize {
        let mut root = x;
        while self.parent[root] != root {
            root = self.parent[root];
        }
        let mut x = x;
        while self.parent[x] != root {
            let next = self.parent[x];
            self.parent[x] = root;
            x = next;
        }
        root
    }

    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.parent[ra.max(rb)] = ra.min(rb);
        }
    }
}

/// Collapse wires and part-internal buses into nets.
///
/// Only pins that are wired or part of an internal bus appear. Output is
/// deterministic (nets and pins sorted) so the editor can diff netlists when
/// the user rewires a running simulation.
pub fn build_netlist(circuit: &Circuit, catalog: &dyn PartCatalog) -> Netlist {
    let mut ids: HashMap<PinRef, usize> = HashMap::new();
    let mut pins: Vec<PinRef> = Vec::new();
    let mut uf = UnionFind { parent: Vec::new() };
    let mut id_of = |p: PinRef, uf: &mut UnionFind| -> usize {
        *ids.entry(p.clone()).or_insert_with(|| {
            pins.push(p);
            uf.parent.push(uf.parent.len());
            uf.parent.len() - 1
        })
    };

    for part in &circuit.parts {
        for bus in catalog.internal_buses(&part.kind) {
            let mut first = None;
            for pin in bus {
                let id = id_of(PinRef::new(&part.id, pin), &mut uf);
                match first {
                    None => first = Some(id),
                    Some(f) => uf.union(f, id),
                }
            }
        }
    }
    for w in &circuit.wires {
        let a = id_of(w.a.clone(), &mut uf);
        let b = id_of(w.b.clone(), &mut uf);
        uf.union(a, b);
    }

    let mut groups: BTreeMap<usize, Vec<PinRef>> = BTreeMap::new();
    for (i, pin) in pins.iter().enumerate() {
        groups.entry(uf.find(i)).or_default().push(pin.clone());
    }
    let mut nets: Vec<Net> = groups
        .into_values()
        .map(|mut pins| {
            pins.sort();
            Net { pins }
        })
        .collect();
    nets.sort_by(|a, b| a.pins[0].cmp(&b.pins[0]));
    Netlist { nets }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Catalog;
    static BB_BUSES: std::sync::LazyLock<Vec<Vec<String>>> = std::sync::LazyLock::new(|| {
        vec![
            ["a1", "b1", "c1", "d1", "e1"].map(String::from).to_vec(),
            ["a2", "b2", "c2", "d2", "e2"].map(String::from).to_vec(),
        ]
    });

    impl PartCatalog for Catalog {
        fn internal_buses(&self, kind: &str) -> &[Vec<String>] {
            match kind {
                "breadboard" => &BB_BUSES,
                _ => &[],
            }
        }
    }

    fn wire(a: (&str, &str), b: (&str, &str)) -> Wire {
        Wire {
            a: PinRef::new(a.0, a.1),
            b: PinRef::new(b.0, b.1),
        }
    }

    #[test]
    fn led_blink_circuit_through_breadboard() {
        // PA5 -> bb row1 ; LED anode in row1, cathode in row2 ; row2 -> GND
        let circuit = Circuit {
            parts: vec![
                PartInstance {
                    id: "mcu".into(),
                    kind: "nucleo-f401re".into(),
                    props: Default::default(),
                },
                PartInstance {
                    id: "bb".into(),
                    kind: "breadboard".into(),
                    props: Default::default(),
                },
                PartInstance {
                    id: "led1".into(),
                    kind: "led-5mm".into(),
                    props: Default::default(),
                },
            ],
            wires: vec![
                wire(("mcu", "PA5"), ("bb", "a1")),
                wire(("led1", "A"), ("bb", "e1")),
                wire(("led1", "K"), ("bb", "e2")),
                wire(("bb", "a2"), ("mcu", "GND")),
            ],
        };
        let nl = build_netlist(&circuit, &Catalog);
        assert_eq!(nl.nets.len(), 2);
        let pa5 = nl.net_of(&PinRef::new("mcu", "PA5")).unwrap();
        assert_eq!(nl.net_of(&PinRef::new("led1", "A")), Some(pa5));
        let gnd = nl.net_of(&PinRef::new("mcu", "GND")).unwrap();
        assert_eq!(nl.net_of(&PinRef::new("led1", "K")), Some(gnd));
        assert_ne!(pa5, gnd);
    }

    #[test]
    fn circuit_json_roundtrip() {
        let json = r#"{"parts":[{"id":"r1","kind":"resistor"}],
                       "wires":[{"a":{"part":"r1","pin":"1"},"b":{"part":"mcu","pin":"PA0"}}]}"#;
        let c: Circuit = serde_json::from_str(json).unwrap();
        assert_eq!(c.wires[0].b, PinRef::new("mcu", "PA0"));
        let nl = build_netlist(&c, &Catalog);
        assert_eq!(nl.nets.len(), 1);
    }
}
