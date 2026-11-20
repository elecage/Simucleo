//! SWV, as STM32CubeIDE's debugger sets it up: the trace settings a student
//! picks (ITM ports, PC sampling rate, exception trace, up to four traced
//! variables) are written to the ITM and DWT like the debugger does, and the
//! packets are handed out with times, function and exception names.

use serde::{Deserialize, Serialize};

use simucleo_core::cortexm::{exc, CortexM};
use simucleo_core::trace::{
    Comparator, ExcKind, TraceEvent, DEMCR_TRCENA, DWT_CYCCNTENA, DWT_CYCTAP, DWT_EXCTRCENA,
    DWT_PCSAMPLENA, TCR_ITMENA,
};

/// How a traced variable is watched (the comparator's FUNCTION).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DataMode {
    /// Value on every write (FUNCTION 0b1101).
    #[default]
    Write,
    /// Value on every read (0b1100).
    Read,
    /// Value and PC on reads and writes (0b1111).
    Rw,
}

/// A variable for data trace: `size` bytes at `addr`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataTrace {
    pub addr: u32,
    pub size: u32,
    #[serde(default)]
    pub mode: DataMode,
}

/// The SWV settings (CubeIDE's "Serial Wire Viewer settings").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwvConfig {
    /// ITM stimulus ports let through (bit n = port n).
    pub ports: u32,
    /// PC sampling: POSTPRESET (0–15) and CYCTAP (false: every 64 cycles ×
    /// (POSTPRESET+1), true: 1024 ×); `None` for no PC sampling.
    pub pc_sampling: Option<(u32, bool)>,
    /// Exception trace.
    pub exceptions: bool,
    /// Up to four variables for data trace (comparators 0–3).
    pub data: Vec<DataTrace>,
}

impl SwvConfig {
    /// Write the settings to the ITM and DWT, as the debugger does when the
    /// trace starts.
    pub fn apply(&self, sys: &mut CortexM) {
        sys.demcr |= DEMCR_TRCENA;
        sys.trace.tcr = TCR_ITMENA | (1 << 16); // ITMENA, TraceBusID 1
        sys.trace.ter = self.ports;
        let mut ctrl = sys.dwt_ctrl & !(DWT_PCSAMPLENA | DWT_EXCTRCENA | DWT_CYCTAP | (0xF << 1));
        if let Some((preset, tap)) = self.pc_sampling {
            ctrl |= DWT_CYCCNTENA
                | DWT_PCSAMPLENA
                | (preset & 0xF) << 1
                | if tap { DWT_CYCTAP } else { 0 };
        }
        if self.exceptions {
            ctrl |= DWT_EXCTRCENA;
        }
        sys.write(0xE000_1000, simucleo_core::bus::AccessSize::Word, ctrl)
            .ok();
        for i in 0..4 {
            let c = match self.data.get(i) {
                Some(d) => Comparator {
                    comp: d.addr,
                    // The smallest aligned block that holds the variable.
                    mask: d.size.max(1).next_power_of_two().trailing_zeros(),
                    function: match d.mode {
                        DataMode::Write => 0b1101,
                        DataMode::Read => 0b1100,
                        DataMode::Rw => 0b1111,
                    } | 0x0800, // DATAVSIZE word
                },
                None => Comparator::default(),
            };
            let base = 0xE000_1020 + 16 * i as u32;
            sys.write(base, simucleo_core::bus::AccessSize::Word, c.comp)
                .ok();
            sys.write(base + 4, simucleo_core::bus::AccessSize::Word, c.mask)
                .ok();
            sys.write(base + 8, simucleo_core::bus::AccessSize::Word, c.function)
                .ok();
        }
    }

    /// Stop the trace: ports closed, no sampling, no comparators (TRCENA and
    /// CYCCNT stay as the firmware may use them).
    pub fn stop(sys: &mut CortexM) {
        SwvConfig {
            ports: 0,
            pc_sampling: None,
            exceptions: false,
            data: Vec::new(),
        }
        .apply(sys);
        sys.trace.tcr = 0;
        sys.trace.drain();
    }
}

/// What `Trace::drain` returns.
pub type Drained = (
    Vec<TraceEvent>,
    std::collections::HashMap<u32, u64>,
    u64,
    u64,
);

/// An ITM write.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ItmOut {
    /// Simulated time, ns.
    pub t: f64,
    pub port: u8,
    pub size: u8,
    pub value: u32,
}

/// A traced data access.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DataOut {
    pub t: f64,
    pub comparator: u8,
    pub addr: u32,
    pub value: u32,
    pub size: u8,
    pub write: bool,
    pub pc: u32,
}

/// An exception trace packet.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExcOut {
    pub t: f64,
    pub number: u16,
    pub name: String,
    /// `"enter"`, `"exit"` or `"return"`.
    pub kind: &'static str,
}

/// PC samples in one function.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProfileOut {
    pub function: String,
    pub samples: u64,
}

/// What the trace produced since the last call.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SwvFrame {
    pub itm: Vec<ItmOut>,
    pub data: Vec<DataOut>,
    pub exceptions: Vec<ExcOut>,
    /// PC samples by function (most first), and those taken asleep.
    pub profile: Vec<ProfileOut>,
    pub sleep_samples: u64,
    /// Packets lost because they were not collected in time.
    pub dropped: u64,
}

/// Exception names as CubeIDE's exception trace shows them: the system
/// exceptions, and the STM32F401 interrupts by their vector name (from the
/// SVD, `TIM2`, `EXTI15_10`, …).
pub fn exception_name(n: u16) -> String {
    if n == 0 {
        return "Thread".into();
    }
    if n >= exc::IRQ0 {
        let irq = (n - exc::IRQ0) as u32;
        if let Some((name, _)) = simucleo_periph_stm32f4::svd::PERIPHERALS
            .iter()
            .flat_map(|p| p.interrupts.iter())
            .find(|(_, i)| *i as u32 == irq)
        {
            return name.to_string();
        }
    }
    exc::name(n)
}

impl SwvFrame {
    /// The trace drained from a [`CortexM`] (`Trace::drain`); `ns_at` turns
    /// cycles into time and `symbol` PCs into function names.
    pub fn collect(
        drained: Drained,
        ns_at: impl Fn(u64) -> f64,
        symbol: impl Fn(u32) -> Option<String>,
    ) -> Self {
        let (events, pcs, sleep_samples, dropped) = drained;
        let mut out = SwvFrame {
            sleep_samples,
            dropped,
            ..Default::default()
        };
        for e in events {
            match e {
                TraceEvent::Itm {
                    cycle,
                    port,
                    size,
                    value,
                } => out.itm.push(ItmOut {
                    t: ns_at(cycle),
                    port,
                    size,
                    value,
                }),
                TraceEvent::Data {
                    cycle,
                    comparator,
                    addr,
                    value,
                    size,
                    write,
                    pc,
                } => out.data.push(DataOut {
                    t: ns_at(cycle),
                    comparator,
                    addr,
                    value,
                    size,
                    write,
                    pc,
                }),
                TraceEvent::Exception {
                    cycle,
                    number,
                    kind,
                } => out.exceptions.push(ExcOut {
                    t: ns_at(cycle),
                    number,
                    name: exception_name(number),
                    kind: match kind {
                        ExcKind::Enter => "enter",
                        ExcKind::Exit => "exit",
                        ExcKind::Return => "return",
                    },
                }),
            }
        }
        let mut by_fn: std::collections::BTreeMap<String, u64> = Default::default();
        for (pc, n) in pcs {
            let f = symbol(pc).unwrap_or_else(|| format!("0x{pc:08X}"));
            *by_fn.entry(f).or_default() += n;
        }
        out.profile = by_fn
            .into_iter()
            .map(|(function, samples)| ProfileOut { function, samples })
            .collect();
        out.profile
            .sort_by(|a, b| b.samples.cmp(&a.samples).then(a.function.cmp(&b.function)));
        out
    }
}
