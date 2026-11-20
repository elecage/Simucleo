//! Native speed of the bundled examples (M31), through the same entry
//! points the web worker uses: `web/scripts/bench.mjs` writes the jobs (ELF
//! paths and the circuits the editor would hand over) and runs
//!
//! ```text
//! cargo run --release -p simucleo-wasm --example bench -- jobs.json
//! ```
//!
//! Each job runs like `benchRun` in `web/src/sim/benchRun.ts`: 10 ms steps,
//! a display frame closed and parsed every 1/60 s of simulated time. One
//! JSON line per job: `{"name", "simMs", "wallMs", "ratio", "stopped"?}`.

use std::time::Instant;

use serde_json::{json, Value};
use simucleo_wasm::Simulator;

const FRAME_MS: f64 = 1000.0 / 60.0;
const STEP_MS: f64 = 10.0;

/// Run `sim_ms` of simulated time; (simulated ms, wall ms, why it stopped).
fn bench(sim: &mut Simulator, sim_ms: f64) -> (f64, f64, Option<String>) {
    let t0 = Instant::now();
    let s0 = sim.time_ms();
    let mut stopped = None;
    while sim.time_ms() - s0 < sim_ms - 1e-6 && stopped.is_none() {
        let mut frame = FRAME_MS;
        while frame > 1e-9 {
            let step = STEP_MS.min(frame);
            let why = sim.run_for_ms(step);
            frame -= step;
            if !why.is_empty() {
                stopped = Some(why);
                break;
            }
        }
        let f: Value = serde_json::from_str(&sim.frame()).expect("frame JSON");
        std::hint::black_box(f);
        sim.take_console();
    }
    let wall = t0.elapsed().as_secs_f64() * 1e3;
    (sim.time_ms() - s0, wall.max(1e-3), stopped)
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: bench <jobs.json>");
    let jobs: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("jobs file"))
            .expect("jobs JSON");
    for job in jobs {
        let name = job["name"].as_str().unwrap_or("?");
        let elf = std::fs::read(job["elf"].as_str().expect("elf path")).expect("ELF");
        let sim_ms = job["simMs"].as_f64().unwrap_or(3000.0);
        let mut sim = Simulator::new();
        sim.load_elf(&elf).expect("load ELF");
        if let Some(w) = job.get("wiring").filter(|w| !w.is_null()) {
            let s = |k: &str| w[k].as_str().expect("wiring JSON").to_owned();
            if sim
                .set_wiring(&s("circuit"), &s("catalog"), &s("signals"))
                .is_err()
            {
                panic!("{name}: the circuit was refused");
            }
        }
        bench(&mut sim, 100.0); // warm up
        let (ran, wall, stopped) = bench(&mut sim, sim_ms);
        let mut out = json!({ "name": name, "simMs": ran, "wallMs": wall, "ratio": ran / wall });
        if let Some(why) = stopped {
            out["stopped"] = json!(why);
        }
        println!("{out}");
    }
}
