//! GDB remote serial protocol server: `simucleo gdb <firmware.elf>`, then
//! in GDB `target extended-remote :3333` (or VS Code Cortex-Debug with an
//! external GDB server). Registers, memory, software breakpoints,
//! stepping, continue with Ctrl-C, `monitor reset`; the ST-LINK virtual
//! COM port is printed on the server's terminal.

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

use simucleo_core::cpu::StopReason;
use simucleo_nucleo::{Nucleo, Step};

/// The register layout GDB sees: the M-profile core, the stack pointers,
/// the FPU (as d0–d15) and the special registers.
const TARGET_XML: &str = r#"<?xml version="1.0"?>
<!DOCTYPE target SYSTEM "gdb-target.dtd">
<target version="1.0">
  <architecture>arm</architecture>
  <feature name="org.gnu.gdb.arm.m-profile">
    <reg name="r0" bitsize="32"/><reg name="r1" bitsize="32"/><reg name="r2" bitsize="32"/><reg name="r3" bitsize="32"/>
    <reg name="r4" bitsize="32"/><reg name="r5" bitsize="32"/><reg name="r6" bitsize="32"/><reg name="r7" bitsize="32"/>
    <reg name="r8" bitsize="32"/><reg name="r9" bitsize="32"/><reg name="r10" bitsize="32"/><reg name="r11" bitsize="32"/>
    <reg name="r12" bitsize="32"/>
    <reg name="sp" bitsize="32" type="data_ptr"/>
    <reg name="lr" bitsize="32"/>
    <reg name="pc" bitsize="32" type="code_ptr"/>
    <reg name="xpsr" bitsize="32"/>
  </feature>
  <feature name="org.gnu.gdb.arm.m-system">
    <reg name="msp" bitsize="32" type="data_ptr"/>
    <reg name="psp" bitsize="32" type="data_ptr"/>
  </feature>
  <feature name="org.gnu.gdb.arm.vfp">
    <reg name="d0" bitsize="64" type="ieee_double"/><reg name="d1" bitsize="64" type="ieee_double"/>
    <reg name="d2" bitsize="64" type="ieee_double"/><reg name="d3" bitsize="64" type="ieee_double"/>
    <reg name="d4" bitsize="64" type="ieee_double"/><reg name="d5" bitsize="64" type="ieee_double"/>
    <reg name="d6" bitsize="64" type="ieee_double"/><reg name="d7" bitsize="64" type="ieee_double"/>
    <reg name="d8" bitsize="64" type="ieee_double"/><reg name="d9" bitsize="64" type="ieee_double"/>
    <reg name="d10" bitsize="64" type="ieee_double"/><reg name="d11" bitsize="64" type="ieee_double"/>
    <reg name="d12" bitsize="64" type="ieee_double"/><reg name="d13" bitsize="64" type="ieee_double"/>
    <reg name="d14" bitsize="64" type="ieee_double"/><reg name="d15" bitsize="64" type="ieee_double"/>
    <reg name="fpscr" bitsize="32" type="int" group="float"/>
  </feature>
  <feature name="net.simucleo.cortex-m.special">
    <reg name="primask" bitsize="32" group="system"/>
    <reg name="basepri" bitsize="32" group="system"/>
    <reg name="faultmask" bitsize="32" group="system"/>
    <reg name="control" bitsize="32" group="system"/>
  </feature>
</target>
"#;

/// Register numbers in the layout above.
const NUM_REGS: usize = 40;

/// Size in bytes of register `n`.
fn reg_size(n: usize) -> usize {
    if (19..35).contains(&n) {
        8
    } else {
        4
    }
}

fn read_reg(board: &Nucleo, n: usize) -> Option<u64> {
    let r = board.cpu.registers();
    Some(match n {
        0..=15 => r.r[n] as u64,
        16 => r.xpsr as u64,
        17 => r.msp as u64,
        18 => r.psp as u64,
        19..=34 => {
            let d = n - 19;
            r.s[2 * d] as u64 | (r.s[2 * d + 1] as u64) << 32
        }
        35 => r.fpscr as u64,
        36 => r.primask as u64,
        37 => r.basepri as u64,
        38 => r.faultmask as u64,
        39 => r.control as u64,
        _ => return None,
    })
}

/// Thread mode with CONTROL.SPSEL set: the process stack is in use.
fn psp_active(r: &simucleo_core::cpu::Registers) -> bool {
    r.control & 2 != 0 && r.xpsr & 0x1FF == 0
}

fn write_reg(board: &mut Nucleo, n: usize, v: u64) -> bool {
    let mut r = board.cpu.registers();
    match n {
        0..=15 => r.r[n] = v as u32,
        16 => r.xpsr = v as u32,
        // The active stack pointer is r13 (the CPU takes the active bank
        // from it): keep the two in step.
        17 => {
            r.msp = v as u32;
            if !psp_active(&r) {
                r.r[13] = v as u32;
            }
        }
        18 => {
            r.psp = v as u32;
            if psp_active(&r) {
                r.r[13] = v as u32;
            }
        }
        19..=34 => {
            let d = n - 19;
            r.s[2 * d] = v as u32;
            r.s[2 * d + 1] = (v >> 32) as u32;
        }
        35 => r.fpscr = v as u32,
        36 => r.primask = v as u32,
        37 => r.basepri = v as u32,
        38 => r.faultmask = v as u32,
        39 => r.control = v as u32,
        _ => return false,
    }
    board.cpu.set_registers(&r);
    true
}

fn hex_le(v: u64, bytes: usize) -> String {
    v.to_le_bytes()[..bytes]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn parse_hex_le(s: &str) -> Option<u64> {
    let mut v = 0u64;
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        let b = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
        v |= (b as u64) << (8 * i);
    }
    Some(v)
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok())
        .collect()
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// One end of the protocol: framing, checksums, acknowledgements.
struct Conn {
    stream: TcpStream,
    buf: Vec<u8>,
    ack: bool,
}

enum Incoming {
    Packet(String),
    Interrupt,
    Closed,
}

impl Conn {
    fn send(&mut self, data: &str) -> std::io::Result<()> {
        let sum = data.bytes().fold(0u8, |a, b| a.wrapping_add(b));
        self.stream
            .write_all(format!("${data}#{sum:02x}").as_bytes())?;
        self.stream.flush()
    }

    /// Next packet or Ctrl-C; `block` = wait for one.
    fn next(&mut self, block: bool) -> std::io::Result<Option<Incoming>> {
        loop {
            // Something complete in the buffer?
            while let Some(&b) = self.buf.first() {
                match b {
                    b'+' | b'-' => {
                        self.buf.remove(0);
                    }
                    0x03 => {
                        self.buf.remove(0);
                        return Ok(Some(Incoming::Interrupt));
                    }
                    b'$' => {
                        let Some(hash) = self.buf.iter().position(|&c| c == b'#') else {
                            break;
                        };
                        if self.buf.len() < hash + 3 {
                            break;
                        }
                        let body = String::from_utf8_lossy(&self.buf[1..hash]).into_owned();
                        self.buf.drain(..hash + 3);
                        if self.ack {
                            self.stream.write_all(b"+")?;
                        }
                        return Ok(Some(Incoming::Packet(body)));
                    }
                    _ => {
                        self.buf.remove(0);
                    }
                }
            }
            self.stream.set_nonblocking(!block)?;
            let mut tmp = [0u8; 4096];
            match self.stream.read(&mut tmp) {
                Ok(0) => return Ok(Some(Incoming::Closed)),
                Ok(n) => self.buf.extend_from_slice(&tmp[..n]),
                Err(e) if e.kind() == ErrorKind::WouldBlock => return Ok(None),
                Err(e) => return Err(e),
            }
        }
    }
}

/// The server: one board, one client at a time.
pub struct Server {
    pub board: Nucleo,
    /// Software breakpoints GDB inserted.
    breakpoints: std::collections::BTreeSet<u32>,
    /// Print the virtual COM port on stdout.
    pub echo_console: bool,
}

impl Server {
    pub fn new(board: Nucleo) -> Self {
        Self {
            board,
            breakpoints: Default::default(),
            echo_console: true,
        }
    }

    fn flush_console(&mut self) {
        let out = self.board.take_console();
        if self.echo_console && !out.is_empty() {
            let bytes: Vec<u8> = out.iter().map(|b| b.byte).collect();
            let _ = std::io::stdout().write_all(&bytes);
            let _ = std::io::stdout().flush();
        }
    }

    /// Stop reply for a stop reason.
    fn stop_reply(&self, stop: &StopReason) -> String {
        match stop {
            StopReason::Breakpoint(_) => "T05swbreak:;".into(),
            StopReason::Lockup { .. }
            | StopReason::Halted { .. }
            | StopReason::Unimplemented { .. } => {
                // The firmware is stuck: report it as a trap so GDB shows where.
                "T05".into()
            }
            _ => "T05".into(),
        }
    }

    /// Run until a breakpoint, a stop, or Ctrl-C from GDB.
    fn cont(&mut self, conn: &mut Conn) -> std::io::Result<String> {
        loop {
            let r = self.board.run_for_ns(1e6);
            self.flush_console();
            match r.stop {
                StopReason::BudgetExhausted | StopReason::Sleeping | StopReason::Yield => {}
                StopReason::ResetRequested => {}
                ref other => {
                    if let Some(d) = self.board.diagnose(&r) {
                        eprintln!("[simucleo] {d}");
                    }
                    return Ok(self.stop_reply(other));
                }
            }
            match conn.next(false)? {
                Some(Incoming::Interrupt) => return Ok("T02".into()),
                Some(Incoming::Closed) => return Err(ErrorKind::ConnectionAborted.into()),
                // GDB sends nothing else while the target runs.
                _ => {}
            }
        }
    }

    fn read_memory(&self, addr: u32, len: usize) -> Option<Vec<u8>> {
        (0..len as u32)
            .map(|i| self.board.peek_byte(addr.wrapping_add(i)))
            .collect()
    }

    fn write_memory(&mut self, addr: u32, data: &[u8]) -> bool {
        self.board.write_memory(addr, data)
    }

    /// Handle one packet; `None` ends the session (kill).
    fn handle(&mut self, p: &str, conn: &mut Conn) -> std::io::Result<Option<String>> {
        let reply = match p {
            "?" => "S05".to_string(),
            "g" => (0..NUM_REGS).map(|n| hex_le(read_reg(&self.board, n).unwrap_or(0), reg_size(n))).collect(),
            "c" | "vCont;c" => self.cont(conn)?,
            "s" | "vCont;s" | "vCont;s:1" | "vCont;s:1;c" => {
                self.board.step(Step::Instruction);
                self.flush_console();
                "T05".into()
            }
            "vCont?" => "vCont;c;s;t".into(),
            "qC" => "QC1".into(),
            "qAttached" => "1".into(),
            "qfThreadInfo" => "m1".into(),
            "qsThreadInfo" => "l".into(),
            "qSymbol::" => "OK".into(),
            "QStartNoAckMode" => {
                conn.send("OK")?;
                conn.ack = false;
                // Already answered.
                return Ok(Some("\u{0}".into()));
            }
            "D" | "D;1" => {
                conn.send("OK")?;
                return Ok(None);
            }
            "k" | "vKill;1" => return Ok(None),
            _ if p.starts_with("qSupported") => "PacketSize=4000;qXfer:features:read+;vContSupported+;swbreak+;hwbreak+;QStartNoAckMode+".into(),
            _ if p.starts_with("qXfer:features:read:target.xml:") => {
                let range = &p["qXfer:features:read:target.xml:".len()..];
                let (off, len) = range.split_once(',').unwrap_or(("0", "0"));
                let off = usize::from_str_radix(off, 16).unwrap_or(0);
                let len = usize::from_str_radix(len, 16).unwrap_or(0);
                let xml = TARGET_XML.as_bytes();
                if off >= xml.len() {
                    "l".into()
                } else {
                    let end = (off + len).min(xml.len());
                    format!("{}{}", if end == xml.len() { 'l' } else { 'm' }, String::from_utf8_lossy(&xml[off..end]))
                }
            }
            _ if p.starts_with('H') => "OK".into(),
            _ if p.starts_with('T') => "OK".into(),
            _ if p.starts_with("vMustReplyEmpty") => String::new(),
            _ if p.starts_with('p') => {
                let n = usize::from_str_radix(&p[1..], 16).unwrap_or(usize::MAX);
                match read_reg(&self.board, n) {
                    Some(v) => hex_le(v, reg_size(n)),
                    None => "E01".into(),
                }
            }
            _ if p.starts_with('P') => {
                let (n, v) = p[1..].split_once('=').unwrap_or(("", ""));
                let n = usize::from_str_radix(n, 16).unwrap_or(usize::MAX);
                match parse_hex_le(v) {
                    Some(v) if write_reg(&mut self.board, n, v) => "OK".into(),
                    _ => "E01".into(),
                }
            }
            _ if p.starts_with('G') => {
                let mut pos = 1;
                for n in 0..NUM_REGS {
                    let w = 2 * reg_size(n);
                    if let Some(v) = p.get(pos..pos + w).and_then(parse_hex_le) {
                        write_reg(&mut self.board, n, v);
                    }
                    pos += w;
                }
                "OK".into()
            }
            _ if p.starts_with('m') => {
                let (a, l) = p[1..].split_once(',').unwrap_or(("", ""));
                match (u32::from_str_radix(a, 16), usize::from_str_radix(l, 16)) {
                    (Ok(a), Ok(l)) => match self.read_memory(a, l.min(0x1000)) {
                        Some(b) => to_hex(&b),
                        None => "E01".into(),
                    },
                    _ => "E01".into(),
                }
            }
            _ if p.starts_with('M') => {
                let (head, data) = p[1..].split_once(':').unwrap_or(("", ""));
                let a = head.split(',').next().and_then(|a| u32::from_str_radix(a, 16).ok());
                match (a, from_hex(data)) {
                    (Some(a), Some(d)) if self.write_memory(a, &d) => "OK".into(),
                    _ => "E01".into(),
                }
            }
            _ if p.starts_with("Z0,") || p.starts_with("Z1,") || p.starts_with("z0,") || p.starts_with("z1,") => {
                let addr = p[3..].split(',').next().and_then(|a| u32::from_str_radix(a, 16).ok());
                match addr {
                    Some(a) if p.starts_with('Z') => {
                        self.board.cpu.add_breakpoint(a);
                        self.breakpoints.insert(a & !1);
                        "OK".into()
                    }
                    Some(a) => {
                        self.board.cpu.remove_breakpoint(a);
                        self.breakpoints.remove(&(a & !1));
                        "OK".into()
                    }
                    None => "E01".into(),
                }
            }
            _ if p.starts_with("qRcmd,") => {
                let cmd = from_hex(&p[6..]).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
                let out = self.monitor(cmd.trim());
                conn.send(&format!("O{}", to_hex(out.as_bytes())))?;
                "OK".into()
            }
            _ => String::new(),
        };
        Ok(Some(reply))
    }

    /// `monitor …` commands.
    fn monitor(&mut self, cmd: &str) -> String {
        match cmd {
            "reset" | "reset halt" => match self.board.reset() {
                Ok(()) => "board reset\n".into(),
                Err(e) => format!("reset failed: {e:?}\n"),
            },
            "time" => format!(
                "{:.6} s simulated, {} cycles at {} Hz\n",
                self.board.time_ns() / 1e9,
                self.board.now(),
                self.board.clock_hz()
            ),
            _ => "monitor commands: reset, time\n".into(),
        }
    }

    /// Serve one GDB session on an accepted connection.
    pub fn session(&mut self, stream: TcpStream) -> std::io::Result<()> {
        stream.set_nodelay(true)?;
        stream.set_read_timeout(Some(Duration::from_secs(3600)))?;
        let mut conn = Conn {
            stream,
            buf: Vec::new(),
            ack: true,
        };
        loop {
            let Some(msg) = conn.next(true)? else {
                continue;
            };
            match msg {
                Incoming::Closed => return Ok(()),
                Incoming::Interrupt => conn.send("T02")?,
                Incoming::Packet(p) => match self.handle(&p, &mut conn)? {
                    None => return Ok(()),
                    Some(r) if r == "\u{0}" => {}
                    Some(r) => conn.send(&r)?,
                },
            }
        }
    }
}

/// `simucleo gdb <elf> [--port N]`: accept GDB connections one after another.
pub fn serve(board: Nucleo, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    eprintln!(
        "[simucleo] GDB server on 127.0.0.1:{} — in GDB: target extended-remote :{}",
        listener.local_addr()?.port(),
        listener.local_addr()?.port()
    );
    let mut server = Server::new(board);
    for stream in listener.incoming() {
        let stream = stream?;
        eprintln!("[simucleo] GDB connected from {}", stream.peer_addr()?);
        if let Err(e) = server.session(stream) {
            eprintln!("[simucleo] session ended: {e}");
        } else {
            eprintln!("[simucleo] GDB disconnected");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal GDB client.
    struct Client(TcpStream);

    impl Client {
        fn cmd(&mut self, p: &str) -> String {
            let sum = p.bytes().fold(0u8, |a, b| a.wrapping_add(b));
            self.0
                .write_all(format!("${p}#{sum:02x}").as_bytes())
                .unwrap();
            self.reply()
        }
        fn reply(&mut self) -> String {
            let mut buf = Vec::new();
            let mut b = [0u8; 1];
            loop {
                self.0.read_exact(&mut b).unwrap();
                match b[0] {
                    b'+' if buf.is_empty() => {}
                    b'#' => {
                        let mut cs = [0u8; 2];
                        self.0.read_exact(&mut cs).unwrap();
                        self.0.write_all(b"+").unwrap();
                        let s = String::from_utf8_lossy(&buf[1..]).into_owned();
                        // Console output from `monitor` comes first.
                        if s.starts_with('O') && s != "OK" {
                            buf.clear();
                            continue;
                        }
                        return s;
                    }
                    c => buf.push(c),
                }
            }
        }
    }

    fn firmware() -> Option<Vec<u8>> {
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../firmware/hal-7seg-keypad/build/hal-7seg-keypad.elf"
        );
        std::fs::read(p).ok()
    }

    #[test]
    #[ignore = "needs arm-none-eabi-gcc build of firmware/hal-7seg-keypad"]
    fn rsp_breakpoint_continue_registers_memory_step() {
        let elf = firmware().expect("built firmware");
        let main = simucleo_elf::FirmwareImage::parse(&elf)
            .unwrap()
            .symbol("main")
            .unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            // The board is not Send: build it on the server's thread.
            let mut board = Nucleo::new();
            board.load_elf(&elf).unwrap();
            let mut s = Server::new(board);
            s.echo_console = false;
            let (stream, _) = listener.accept().unwrap();
            s.session(stream).unwrap();
        });
        let mut c = Client(TcpStream::connect(("127.0.0.1", port)).unwrap());
        assert!(c
            .cmd("qSupported:multiprocess+")
            .contains("qXfer:features:read+"));
        assert!(c
            .cmd("qXfer:features:read:target.xml:0,fff")
            .contains("org.gnu.gdb.arm.m-profile"));
        assert_eq!(c.cmd("?"), "S05");
        // Registers: 16 core + xpsr + msp + psp (4 bytes), 16 doubles, 5 more.
        let g = c.cmd("g");
        assert_eq!(g.len(), 2 * (19 * 4 + 16 * 8 + 5 * 4));
        assert_eq!(c.cmd(&format!("Z0,{main:x},2")), "OK");
        assert_eq!(c.cmd("c"), "T05swbreak:;");
        let pc = u32::from_le_bytes(from_hex(&c.cmd("pf")).unwrap().try_into().unwrap());
        assert_eq!(pc, main);
        // Memory: the vector table's initial SP.
        assert_eq!(c.cmd("m8000000,4"), "00800120");
        // Write a register and read it back.
        assert_eq!(c.cmd("P0=78563412"), "OK");
        assert_eq!(c.cmd("p0"), "78563412");
        // MSP is the active stack in main: writing it moves sp too, and
        // writing sp moves MSP.
        let sp = c.cmd("pd");
        assert_eq!(c.cmd("P11=f0ff0120"), "OK");
        assert_eq!(c.cmd("pd"), "f0ff0120");
        assert_eq!(c.cmd(&format!("Pd={sp}")), "OK");
        assert_eq!(c.cmd("p11"), sp);
        // PSP is not in use: writing it leaves sp alone.
        assert_eq!(c.cmd("P12=00100020"), "OK");
        assert_eq!(c.cmd("p12"), "00100020");
        assert_eq!(c.cmd("pd"), sp);
        // Step one instruction: the pc moves.
        assert_eq!(c.cmd(&format!("z0,{main:x},2")), "OK");
        assert_eq!(c.cmd("s"), "T05");
        assert_ne!(c.cmd("pf"), hex_le(main as u64, 4));
        assert_eq!(c.cmd("qRcmd,74696d65"), "OK"); // "time"
        c.0.write_all(b"$k#6b").unwrap();
        server.join().unwrap();
    }
}
