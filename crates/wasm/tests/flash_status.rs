//! The flash / watchdog status the page's FLASH view shows, and the raw
//! console bytes XMODEM uses, on a fresh board.

use serde_json::Value;
use simucleo_wasm::Simulator;

#[test]
fn a_fresh_board_has_eight_erased_sectors_and_no_watchdog() {
    let mut sim = Simulator::new();
    let s: Value = serde_json::from_str(&sim.flash_status()).unwrap();
    let sectors = s["sectors"].as_array().unwrap();
    assert_eq!(sectors.len(), 8);
    assert_eq!(sectors[0]["start"], 0x0800_0000);
    assert_eq!(sectors[4]["size"], 64 << 10);
    let total: u64 = sectors.iter().map(|x| x["size"].as_u64().unwrap()).sum();
    assert_eq!(total, 512 << 10);
    for x in sectors {
        assert_eq!(x["eraseCount"], 0);
        assert_eq!(x["programmed"], 0);
        assert_eq!(x["used"], 0);
        assert_eq!(x["erasing"], false);
        assert_eq!(x["protected"], false);
    }
    assert_eq!(s["busy"], false);
    assert_eq!(s["activity"], "idle");
    assert_eq!(s["locked"], true);
    assert_eq!(s["watchdog"]["running"], false);
    assert_eq!(s["watchdog"]["timeLeftMs"], Value::Null);
    assert_eq!(s["watchdog"]["resets"], 0);
    assert_eq!(s["resetCause"], "power");
}

#[test]
fn frames_carry_the_flash_status_and_console_bytes_start_empty() {
    let mut sim = Simulator::new();
    let f: Value = serde_json::from_str(&sim.frame()).unwrap();
    assert_eq!(f["flash"]["sectors"].as_array().unwrap().len(), 8);
    assert!(sim.take_console_bytes().is_empty());
    // Nothing runs: the bytes wait in the UART's receive queue.
    sim.console_send_bytes(&[0x01, 0x00, 0xFF]);
}
