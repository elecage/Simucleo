//! Lock-step differential testing of the Rust Cortex-M4 core against
//! Unicorn (QEMU's ARM translator).
//!
//! Both emulators run the same ELF from its entry point. Before every
//! instruction Unicorn executes, the Rust core is advanced to the same PC
//! and all architectural registers are compared: R0–R15, APSR (NZCVQ, GE),
//! S0–S31 and FPSCR. At the end SRAM is compared too.
//!
//! Unicorn has no NVIC/SCB, so test programs must not touch system
//! registers or take exceptions. Unicorn is GPLv2: this crate is a test
//! tool only and the dependency sits behind the `unicorn` feature
//! (see `docs/adr/0002-cpu-backends.md`).

#![cfg(feature = "unicorn")]

use std::fmt::Write as _;

use simucleo_core::cpu::{Registers, StopReason};
use simucleo_elf::FirmwareImage;
use simucleo_nucleo::Nucleo;
use unicorn_engine::{Arch, ArmCpuModel, Mode, Prot, RegisterARM, Unicorn};

const FLASH: u64 = 0x0800_0000;
const FLASH_SIZE: u64 = 512 * 1024;
const SRAM: u64 = 0x2000_0000;
const SRAM_SIZE: u64 = 96 * 1024;
/// APSR bits compared: N Z C V Q and GE[3:0].
const APSR_MASK: u32 = 0xF80F_0000;

#[derive(Debug, Default, Clone)]
pub struct Report {
    pub instructions: u64,
    pub mismatch: Option<String>,
}

struct State {
    board: Nucleo,
    steps: u64,
    last_pcs: Vec<u32>,
    mismatch: Option<String>,
    max_steps: u64,
}

fn uc_regs(uc: &Unicorn<'_, State>) -> Registers {
    let mut r = Registers::default();
    const CORE: [RegisterARM; 16] = [
        RegisterARM::R0,
        RegisterARM::R1,
        RegisterARM::R2,
        RegisterARM::R3,
        RegisterARM::R4,
        RegisterARM::R5,
        RegisterARM::R6,
        RegisterARM::R7,
        RegisterARM::R8,
        RegisterARM::R9,
        RegisterARM::R10,
        RegisterARM::R11,
        RegisterARM::R12,
        RegisterARM::SP,
        RegisterARM::LR,
        RegisterARM::PC,
    ];
    for (i, reg) in CORE.iter().enumerate() {
        r.r[i] = uc.reg_read(*reg).unwrap() as u32;
    }
    r.xpsr = uc.reg_read(RegisterARM::XPSR).unwrap() as u32;
    for (i, s) in r.s.iter_mut().enumerate() {
        *s = uc.reg_read(RegisterARM::S0 as i32 + i as i32).unwrap() as u32;
    }
    r.fpscr = uc.reg_read(RegisterARM::FPSCR).unwrap() as u32;
    r
}

fn diff(ours: &Registers, theirs: &Registers) -> Option<String> {
    let mut out = String::new();
    for i in 0..16 {
        if ours.r[i] != theirs.r[i] {
            let _ = write!(
                out,
                " r{i}: rust={:#010x} unicorn={:#010x};",
                ours.r[i], theirs.r[i]
            );
        }
    }
    if ours.xpsr & APSR_MASK != theirs.xpsr & APSR_MASK {
        let _ = write!(
            out,
            " APSR: rust={:#010x} unicorn={:#010x};",
            ours.xpsr & APSR_MASK,
            theirs.xpsr & APSR_MASK
        );
    }
    for i in 0..32 {
        if ours.s[i] != theirs.s[i] {
            let _ = write!(
                out,
                " s{i}: rust={:#010x} unicorn={:#010x};",
                ours.s[i], theirs.s[i]
            );
        }
    }
    if ours.fpscr != theirs.fpscr {
        let _ = write!(
            out,
            " FPSCR: rust={:#010x} unicorn={:#010x};",
            ours.fpscr, theirs.fpscr
        );
    }
    (!out.is_empty()).then_some(out)
}

/// Run `elf` in both emulators until the `done` symbol (or `max_steps`).
pub fn run_lockstep(elf: &[u8], max_steps: u64) -> Report {
    let fw = FirmwareImage::parse(elf).expect("valid ELF");
    let done = fw.symbol("done").expect("test ELF defines `done`");
    let entry = fw.entry & !1;

    let mut board = Nucleo::new();
    board.load_elf(elf).expect("load");
    board.sys.cpacr = 0xF << 20; // Unicorn's M4 has the FPU enabled from reset
    let mut regs = board.cpu.registers();
    regs.r[13] = (SRAM + SRAM_SIZE) as u32;
    regs.msp = regs.r[13];
    regs.r[14] = 0xFFFF_FFFF;
    regs.r[15] = entry;
    regs.xpsr = 1 << 24;
    board.cpu.set_registers(&regs);

    let state = State {
        board,
        steps: 0,
        last_pcs: Vec::new(),
        mismatch: None,
        max_steps,
    };
    let mut uc =
        Unicorn::new_with_data(Arch::ARM, Mode::THUMB | Mode::MCLASS, state).expect("unicorn");
    uc.ctl_set_cpu_model(ArmCpuModel::CORTEX_M4 as i32).unwrap();
    uc.mem_map(FLASH, FLASH_SIZE, Prot::ALL).unwrap();
    uc.mem_map(SRAM, SRAM_SIZE, Prot::ALL).unwrap();
    for seg in &fw.segments {
        uc.mem_write(seg.addr as u64, &seg.data).unwrap();
    }
    uc.reg_write(RegisterARM::SP, SRAM + SRAM_SIZE).unwrap();
    uc.reg_write(RegisterARM::LR, 0xFFFF_FFFF).unwrap();
    uc.reg_write(RegisterARM::XPSR, 1 << 24).unwrap();

    uc.add_code_hook(1, 0, |uc, addr, _size| {
        let theirs = uc_regs(uc);
        let st = uc.get_data_mut();
        if st.mismatch.is_some() {
            return;
        }
        // Execute the instruction Unicorn just finished (none before the
        // first hook). Unicorn does not call the hook for instructions whose
        // IT condition fails, so inside an IT block we may step a few more.
        let mut steps_needed = if st.steps == 0 { 0 } else { 1 };
        loop {
            let regs = st.board.cpu.registers();
            let pc = regs.pc();
            if steps_needed == 0 {
                if pc == addr as u32 {
                    break;
                }
                let in_it = simucleo_core::cortexm::psr::it(regs.xpsr) & 0xF != 0;
                if !in_it || st.last_pcs.len() > 1_000_000 {
                    st.mismatch = Some(format!(
                        "control flow diverged: rust pc {pc:#010x}, unicorn pc {addr:#010x}"
                    ));
                    break;
                }
            } else {
                steps_needed -= 1;
            }
            let r = st.board.run(1);
            st.last_pcs.push(pc);
            if !matches!(r.stop, StopReason::BudgetExhausted) {
                st.mismatch = Some(format!("rust core stopped at {pc:#010x}: {:?}", r.stop));
                break;
            }
        }
        if st.mismatch.is_none() {
            if let Some(d) = diff(&st.board.cpu.registers(), &theirs) {
                let prev = st.last_pcs.last().copied().unwrap_or(0);
                let sym = st.board.symbol_at(prev).unwrap_or("?").to_string();
                let trail: Vec<String> = st
                    .last_pcs
                    .iter()
                    .rev()
                    .take(8)
                    .map(|p| format!("{p:#x}"))
                    .collect();
                st.mismatch = Some(format!(
                    "after instruction at {prev:#010x} <{sym}> (step {}):{d} [recent rust pcs: {}]",
                    st.steps,
                    trail.join(" ")
                ));
            }
        }
        st.steps += 1;
        if st.steps > 64 {
            st.last_pcs.drain(..st.last_pcs.len().saturating_sub(16));
        }
        if st.mismatch.is_some() || st.steps >= st.max_steps {
            uc.emu_stop().unwrap();
        }
    })
    .unwrap();

    let started = uc.emu_start(entry as u64 | 1, done as u64, 0, 0);
    let st = uc.get_data();
    let mut report = Report {
        instructions: st.steps,
        mismatch: st.mismatch.clone(),
    };
    if let Err(e) = started {
        report
            .mismatch
            .get_or_insert(format!("unicorn stopped with {e:?}"));
    }
    if report.mismatch.is_none() && st.steps < max_steps {
        // Final state and memory.
        let ours = uc.get_data().board.cpu.registers();
        let mut theirs = uc_regs(&uc);
        theirs.r[15] = done;
        let mut board_pc = ours.clone();
        if board_pc.pc() != done {
            // The Rust core may still have to execute the final branch.
            let st = uc.get_data_mut();
            st.board.run(4);
            board_pc = st.board.cpu.registers();
        }
        if let Some(d) = diff(&board_pc, &theirs) {
            report.mismatch = Some(format!("final state:{d}"));
        }
        let sram = uc.mem_read_as_vec(SRAM, SRAM_SIZE as usize).unwrap();
        let st = uc.get_data();
        let ours_sram = &st.board.bus.sram;
        for (i, b) in sram.iter().enumerate() {
            let a = SRAM as u32 + i as u32;
            let o = ours_sram
                .read(a, simucleo_core::bus::AccessSize::Byte)
                .unwrap() as u8;
            if o != *b {
                report.mismatch = Some(format!(
                    "SRAM differs at {a:#010x}: rust={o:#04x} unicorn={b:#04x}"
                ));
                break;
            }
        }
    }
    report
}
