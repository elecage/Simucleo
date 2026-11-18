//! `make -C firmware/difftest && cargo test -p simucleo-difftest --features unicorn`

#![cfg(feature = "unicorn")]

use std::path::PathBuf;

fn check(variant: &str) {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "firmware",
        "difftest",
        "build",
        &format!("difftest-{variant}.elf"),
    ]
    .iter()
    .collect();
    let elf = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (run `make -C firmware/difftest`)", path.display()));
    let report = simucleo_difftest::run_lockstep(&elf, 5_000_000);
    println!("{variant}: {} instructions compared", report.instructions);
    if let Some(m) = report.mismatch {
        panic!("{variant}: {m}");
    }
    assert!(report.instructions > 1000);
}

#[test]
fn o0() {
    check("O0");
}

#[test]
fn o1() {
    check("O1");
}

#[test]
fn o2() {
    check("O2");
}

#[test]
fn os() {
    check("Os");
}

#[test]
fn o3() {
    check("O3");
}
