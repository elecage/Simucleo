//! The PC side of the virtual COM port for the bootloader tests: a console
//! log that runs the board while waiting for text, and an XMODEM-CRC
//! sender (128-byte SOH or 1024-byte STX blocks, CRC-16/CCITT, ACK/NAK,
//! EOT), as a terminal program (Tera Term, minicom's sx) would send a file.

use simucleo_nucleo::Nucleo;

pub const SOH: u8 = 0x01;
pub const STX: u8 = 0x02;
pub const EOT: u8 = 0x04;
pub const ACK: u8 = 0x06;
pub const NAK: u8 = 0x15;
pub const CAN: u8 = 0x18;

/// CRC-16/CCITT as XMODEM-CRC uses it (polynomial 0x1021, initial 0).
pub fn crc16(data: &[u8]) -> u16 {
    data.iter().fold(0u16, |mut crc, &b| {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
        crc
    })
}

/// Everything the board sent on the virtual COM port so far.
#[derive(Default)]
pub struct Vcp {
    pub out: Vec<u8>,
}

impl Vcp {
    /// Run the board for `ms` and collect what it sent.
    pub fn run(&mut self, board: &mut Nucleo, ms: f64) {
        let r = board.run_for_ns(ms * 1e6);
        assert!(board.diagnose(&r).is_none(), "{:?}", board.diagnose(&r));
        self.out.extend(board.take_console().iter().map(|b| b.byte));
    }

    /// The text from byte `from` on (non-ASCII bytes shown as escapes).
    pub fn text(&self, from: usize) -> String {
        self.out[from.min(self.out.len())..]
            .iter()
            .map(|&b| match b {
                b'\r' => String::new(),
                b'\n' | 0x20..=0x7E => (b as char).to_string(),
                _ => format!("<{b:02X}>"),
            })
            .collect()
    }

    /// Run until `needle` appears after byte `from`, at most `max_ms`;
    /// returns the index just after it.
    pub fn wait_for(
        &mut self,
        board: &mut Nucleo,
        from: usize,
        needle: &str,
        max_ms: f64,
    ) -> usize {
        let n = needle.as_bytes();
        let mut waited = 0.0;
        loop {
            if let Some(i) = self.out[from.min(self.out.len())..]
                .windows(n.len())
                .position(|w| w == n)
            {
                return from + i + n.len();
            }
            assert!(
                waited < max_ms,
                "no {needle:?} within {max_ms} ms; console from there:\n{}",
                self.text(from)
            );
            self.run(board, 5.0);
            waited += 5.0;
        }
    }

    /// Run until one of `bytes` comes after byte `from`; returns it.
    fn wait_byte(&mut self, board: &mut Nucleo, from: usize, bytes: &[u8], max_ms: f64) -> u8 {
        let mut waited = 0.0;
        loop {
            if let Some(&b) = self.out[from..].iter().find(|b| bytes.contains(b)) {
                return b;
            }
            assert!(
                waited < max_ms,
                "no reply within {max_ms} ms:\n{}",
                self.text(from)
            );
            self.run(board, 1.0);
            waited += 1.0;
        }
    }

    /// Send `data` with XMODEM-CRC once the receiver asks with 'C' (after
    /// byte `from`). `block` is 128 or 1024; `corrupt_once` sends that block
    /// (0-based) once with a wrong CRC first, which must be NAKed and then
    /// resent. Returns the number of NAKs.
    pub fn xmodem_send(
        &mut self,
        board: &mut Nucleo,
        from: usize,
        data: &[u8],
        block: usize,
        corrupt_once: Option<usize>,
    ) -> u32 {
        self.wait_for(board, from, "C", 3000.0);
        let mut naks = 0;
        for (i, chunk) in data.chunks(block).enumerate() {
            let mut payload = chunk.to_vec();
            payload.resize(block, 0x1A);
            let n = (i + 1) as u8;
            let mut frame = vec![if block == 1024 { STX } else { SOH }, n, !n];
            frame.extend_from_slice(&payload);
            frame.extend_from_slice(&crc16(&payload).to_be_bytes());
            let mut tries = 0;
            loop {
                let mut sent = frame.clone();
                if corrupt_once == Some(i) && tries == 0 {
                    let last = sent.len() - 1;
                    sent[last] ^= 0x55;
                }
                let mark = self.out.len();
                board.console_send(&sent);
                match self.wait_byte(board, mark, &[ACK, NAK, CAN], 3000.0) {
                    ACK => break,
                    NAK => {
                        naks += 1;
                        tries += 1;
                        assert!(tries < 10, "block {i} NAKed {tries} times");
                    }
                    _ => panic!("receiver cancelled at block {i}:\n{}", self.text(from)),
                }
            }
        }
        let mark = self.out.len();
        board.console_send(&[EOT]);
        assert_eq!(self.wait_byte(board, mark, &[ACK, NAK], 3000.0), ACK);
        naks
    }
}
