//! FPv4-SP single-precision floating point (ARMv7-M ARM A6, A7.7).
//!
//! Arithmetic is computed in `f64` and rounded once to `f32` in the FPSCR
//! rounding mode. For +, −, ×, ÷ and √ this is correctly rounded because
//! binary64 has more than 2·24+2 significand bits. NaN handling, default NaN,
//! flush-to-zero and the cumulative exception flags follow the ARM rules
//! (which differ from the host's).

use simucleo_core::bus::AccessSize;
use simucleo_core::cortexm::{control, Fault};

use crate::{ArmV7M, Ctx, Exec, Trap};

const DEFAULT_NAN: u32 = 0x7FC0_0000;

// FPSCR bits
const IOC: u32 = 1 << 0;
const DZC: u32 = 1 << 1;
const OFC: u32 = 1 << 2;
const UFC: u32 = 1 << 3;
const IXC: u32 = 1 << 4;
const IDC: u32 = 1 << 7;
const FZ: u32 = 1 << 24;
const DN: u32 = 1 << 25;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Round {
    Nearest,
    PlusInf,
    MinusInf,
    Zero,
}

#[derive(Clone, Copy)]
enum Op {
    Add,
    Sub,
    Mul,
    Div,
}

fn is_nan(x: u32) -> bool {
    x & 0x7F80_0000 == 0x7F80_0000 && x & 0x007F_FFFF != 0
}

fn is_snan(x: u32) -> bool {
    is_nan(x) && x & 0x0040_0000 == 0
}

fn is_denormal(x: u32) -> bool {
    x & 0x7F80_0000 == 0 && x & 0x007F_FFFF != 0
}

fn next_toward(x: f32, up: bool) -> f32 {
    if x.is_nan() {
        return x;
    }
    if x == 0.0 {
        let tiny = f32::from_bits(1);
        return if up { tiny } else { -tiny };
    }
    let b = x.to_bits();
    let away_from_zero = (x > 0.0) == up;
    f32::from_bits(if away_from_zero { b + 1 } else { b - 1 })
}

/// Round an `f64` to `f32` in the given mode → (value, inexact).
fn round_f32(x: f64, mode: Round) -> (f32, bool) {
    let rn = x as f32;
    if rn as f64 == x || x.is_nan() {
        return (rn, false);
    }
    let r = match mode {
        Round::Nearest => rn,
        Round::PlusInf => {
            if (rn as f64) < x {
                next_toward(rn, true)
            } else {
                rn
            }
        }
        Round::MinusInf => {
            if (rn as f64) > x {
                next_toward(rn, false)
            } else {
                rn
            }
        }
        Round::Zero => {
            if (rn as f64).abs() > x.abs() {
                next_toward(rn, x < 0.0)
            } else {
                rn
            }
        }
    };
    (r, true)
}

/// Round to an integer in the given mode.
fn round_int(x: f64, mode: Round) -> f64 {
    match mode {
        Round::Nearest => x.round_ties_even(),
        Round::PlusInf => x.ceil(),
        Round::MinusInf => x.floor(),
        Round::Zero => x.trunc(),
    }
}

/// Single → IEEE half precision (round to nearest even) → (half, FPSCR flags).
fn f32_to_f16(x: u32) -> (u16, u32) {
    let sign = ((x >> 16) & 0x8000) as u16;
    let exp = (x >> 23) & 0xFF;
    let man = x & 0x7F_FFFF;
    if exp == 0xFF {
        if man == 0 {
            return (sign | 0x7C00, 0);
        }
        let flags = if is_snan(x) { IOC } else { 0 };
        return (sign | 0x7E00 | (man >> 13) as u16, flags);
    }
    let f = f32::from_bits(x & 0x7FFF_FFFF) as f64;
    if f == 0.0 {
        return (sign, 0);
    }
    if f >= 65520.0 {
        return (sign | 0x7C00, OFC | IXC);
    }
    let (bits, exact) = if f < 6.103_515_625e-5 {
        // Subnormal half: units of 2^-24.
        let scaled = f * 16_777_216.0;
        let q = scaled.round_ties_even();
        (q as u16, q == scaled)
    } else {
        let e = f.log2().floor() as i32;
        let scaled = f / 2f64.powi(e) * 1024.0;
        let mut m = scaled.round_ties_even() as u32;
        let mut e = e;
        if m >= 2048 {
            m >>= 1;
            e += 1;
        }
        if e > 15 {
            return (sign | 0x7C00, OFC | IXC);
        }
        (
            (((e + 15) as u16) << 10) | (m as u16 & 0x3FF),
            m as f64 == scaled,
        )
    };
    let mut flags = 0;
    if !exact {
        flags |= IXC;
        if bits & 0x7C00 == 0 {
            flags |= UFC;
        }
    }
    (sign | bits, flags)
}

fn f16_to_f32(h: u16) -> u32 {
    let sign = ((h & 0x8000) as u32) << 16;
    let exp = ((h >> 10) & 0x1F) as i32;
    let man = (h & 0x3FF) as u32;
    match exp {
        0 => {
            let v = man as f32 * 2f32.powi(-24);
            sign | v.to_bits()
        }
        0x1F => sign | 0x7F80_0000 | (man << 13),
        _ => sign | (((exp - 15 + 127) as u32) << 23) | (man << 13),
    }
}

/// `VFPExpandImm` for single precision.
fn vfp_expand_imm(imm8: u32) -> u32 {
    let sign = (imm8 >> 7) & 1;
    let b6 = (imm8 >> 6) & 1;
    let exp = ((b6 ^ 1) << 7) | if b6 != 0 { 0b11111 << 2 } else { 0 } | ((imm8 >> 4) & 3);
    (sign << 31) | (exp << 23) | ((imm8 & 0xF) << 19)
}

impl ArmV7M {
    fn rmode(&self) -> Round {
        match (self.fpscr >> 22) & 3 {
            0 => Round::Nearest,
            1 => Round::PlusInf,
            2 => Round::MinusInf,
            _ => Round::Zero,
        }
    }

    fn flush_in(&mut self, x: u32) -> u32 {
        if self.fpscr & FZ != 0 && is_denormal(x) {
            self.fpscr |= IDC;
            x & 0x8000_0000
        } else {
            x
        }
    }

    /// ARM NaN propagation: first signalling NaN (quietened), else first
    /// quiet NaN; DN replaces it with the default NaN.
    fn process_nans(&mut self, ops: &[u32]) -> Option<u32> {
        let pick = ops.iter().find(|x| is_snan(**x)).map(|x| {
            self.fpscr |= IOC;
            x | 0x0040_0000
        });
        let pick = pick.or_else(|| ops.iter().copied().find(|x| is_nan(*x)))?;
        Some(if self.fpscr & DN != 0 {
            DEFAULT_NAN
        } else {
            pick
        })
    }

    /// Round an exact (or correctly-rounded-to-f64) result and set flags.
    fn fp_result(&mut self, exact: f64) -> u32 {
        if exact.is_nan() {
            self.fpscr |= IOC;
            return DEFAULT_NAN;
        }
        let mode = self.rmode();
        let (mut r, inexact) = round_f32(exact, mode);
        if r.is_infinite() && exact.is_finite() {
            self.fpscr |= OFC | IXC;
            return r.to_bits();
        }
        let tiny = r != 0.0 && r.abs() < f32::MIN_POSITIVE || (r == 0.0 && exact != 0.0);
        if tiny && self.fpscr & FZ != 0 {
            // Flush-to-zero: underflow, but not inexact.
            self.fpscr |= UFC;
            r = if exact < 0.0 { -0.0 } else { 0.0 };
            return r.to_bits();
        }
        if inexact {
            self.fpscr |= IXC;
            if tiny {
                self.fpscr |= UFC;
            }
        }
        r.to_bits()
    }

    fn fp_binop(&mut self, a: u32, b: u32, op: Op) -> u32 {
        let a = self.flush_in(a);
        let b = self.flush_in(b);
        if let Some(n) = self.process_nans(&[a, b]) {
            return n;
        }
        let (fa, fb) = (f32::from_bits(a) as f64, f32::from_bits(b) as f64);
        if let Op::Div = op {
            if fb == 0.0 && fa != 0.0 && fa.is_finite() {
                self.fpscr |= DZC;
                let neg = (a ^ b) & 0x8000_0000 != 0;
                return if neg { 0xFF80_0000 } else { 0x7F80_0000 };
            }
        }
        let exact = match op {
            Op::Add => fa + fb,
            Op::Sub => fa - fb,
            Op::Mul => fa * fb,
            Op::Div => fa / fb,
        };
        // Exact zero sums are +0 except in round-toward-minus mode.
        if exact == 0.0 && matches!(op, Op::Add | Op::Sub) && fa != 0.0 {
            return if self.rmode() == Round::MinusInf {
                0x8000_0000
            } else {
                0
            };
        }
        self.fp_result(exact)
    }

    /// Fused multiply-add `addend + n*m` with optional negations.
    fn fp_fma(&mut self, addend: u32, n: u32, m: u32) -> u32 {
        let (addend, n, m) = (self.flush_in(addend), self.flush_in(n), self.flush_in(m));
        if let Some(x) = self.process_nans(&[addend, n, m]) {
            return x;
        }
        let (a, fn_, fm) = (
            f32::from_bits(addend) as f64,
            f32::from_bits(n) as f64,
            f32::from_bits(m) as f64,
        );
        // The product is exact in f64; one more rounding to f64 for the sum
        // may differ from true fusion only in rare double-rounding cases.
        let exact = fn_.mul_add(fm, a);
        self.fp_result(exact)
    }

    fn fp_neg(x: u32) -> u32 {
        x ^ 0x8000_0000
    }

    fn fp_compare(&mut self, a: u32, b: u32, quiet_nan_signals: bool) {
        let a = self.flush_in(a);
        let b = self.flush_in(b);
        let nzcv = if is_nan(a) || is_nan(b) {
            if is_snan(a) || is_snan(b) || quiet_nan_signals {
                self.fpscr |= IOC;
            }
            0b0011
        } else {
            let (fa, fb) = (f32::from_bits(a), f32::from_bits(b));
            if fa == fb {
                0b0110
            } else if fa < fb {
                0b1000
            } else {
                0b0010
            }
        };
        self.fpscr = (self.fpscr & 0x0FFF_FFFF) | (nzcv << 28);
    }

    fn fp_to_int(&mut self, x: u32, signed: bool, mode: Round) -> u32 {
        let x = self.flush_in(x);
        if is_nan(x) {
            self.fpscr |= IOC;
            return 0;
        }
        let f = f32::from_bits(x) as f64;
        let r = round_int(f, mode);
        let (lo, hi) = if signed {
            (i32::MIN as f64, i32::MAX as f64)
        } else {
            (0.0, u32::MAX as f64)
        };
        if r < lo || r > hi {
            self.fpscr |= IOC;
            let v = if r < lo { lo } else { hi };
            return if signed { v as i32 as u32 } else { v as u32 };
        }
        if r != f {
            self.fpscr |= IXC;
        }
        if signed {
            r as i32 as u32
        } else {
            r as u32
        }
    }

    fn sreg_index(v: u32, low_bit: u32) -> usize {
        ((v << 1) | low_bit) as usize
    }

    // --------------------------------------------------------------- decode

    pub(crate) fn exec_coproc(&mut self, ctx: &mut Ctx, hw1: u32, hw2: u32) -> Exec {
        let opcode = (hw1 << 16) | hw2;
        let coproc = (hw2 >> 8) & 0xF;
        if hw1 & (1 << 12) != 0 || coproc & 0b1110 != 0b1010 {
            return Err(Fault::NoCoprocessor.into());
        }
        if !ctx.sys.fpu_access() {
            return Err(Fault::NoCoprocessor.into());
        }
        if ctx.sys.fpccr & (1 << 31) != 0 {
            self.control |= control::FPCA;
        }
        let op1 = (hw1 >> 4) & 0x3F;
        if op1 & 0b11_1110 == 0b00_0000 || op1 & 0b11_0000 == 0b11_0000 {
            return Err(Fault::UndefInstr.into());
        }
        if op1 & 0b11_1110 == 0b00_0100 {
            return self.vmov_64(hw1, hw2);
        }
        if op1 & 0b10_0000 == 0 {
            return self.ext_load_store(ctx, hw1, hw2, opcode);
        }
        if hw2 & (1 << 4) == 0 {
            self.fp_data_processing(hw1, hw2, opcode)
        } else {
            self.fp_transfer(hw1, hw2, opcode)
        }
    }

    fn vmov_64(&mut self, hw1: u32, hw2: u32) -> Exec {
        let to_arm = hw1 & (1 << 4) != 0;
        let rt2 = hw1 & 0xF;
        let rt = (hw2 >> 12) & 0xF;
        let vm = hw2 & 0xF;
        let m = (hw2 >> 5) & 1;
        let first = if hw2 & (1 << 8) != 0 {
            ((m << 4) | vm) as usize * 2
        } else {
            Self::sreg_index(vm, m)
        };
        if first > 30 {
            return Err(Fault::UndefInstr.into());
        }
        if to_arm {
            let (a, b) = (self.s[first], self.s[first + 1]);
            self.set_reg(rt, a);
            self.set_reg(rt2, b);
        } else {
            self.s[first] = self.reg(rt);
            self.s[first + 1] = self.reg(rt2);
        }
        Ok(())
    }

    fn ext_load_store(&mut self, ctx: &mut Ctx, hw1: u32, hw2: u32, opcode: u32) -> Exec {
        let p = hw1 & (1 << 8) != 0;
        let u = hw1 & (1 << 7) != 0;
        let d = (hw1 >> 6) & 1;
        let w = hw1 & (1 << 5) != 0;
        let load = hw1 & (1 << 4) != 0;
        let rn = hw1 & 0xF;
        let vd = (hw2 >> 12) & 0xF;
        let double = hw2 & (1 << 8) != 0;
        let imm8 = hw2 & 0xFF;
        let first = if double {
            ((d << 4) | vd) as usize * 2
        } else {
            Self::sreg_index(vd, d)
        };
        let base = if rn == 15 {
            self.pc_aligned()
        } else {
            self.reg(rn)
        };

        let (addr, words, wback) = match (p, u, w) {
            (true, _, false) => {
                // VLDR / VSTR
                let off = imm8 << 2;
                (
                    if u {
                        base.wrapping_add(off)
                    } else {
                        base.wrapping_sub(off)
                    },
                    if double { 2 } else { 1 },
                    None,
                )
            }
            (false, true, _) => (
                base,
                imm8,
                if w {
                    Some(base.wrapping_add(imm8 << 2))
                } else {
                    None
                },
            ),
            (true, false, true) => {
                let start = base.wrapping_sub(imm8 << 2);
                (start, imm8, Some(start))
            }
            _ => return Err(Trap::Unimplemented(opcode)),
        };
        if words == 0 || first + words as usize > 32 {
            return Err(Trap::Unimplemented(opcode));
        }
        self.check_aligned(addr, 4)?;
        for i in 0..words {
            let a = addr.wrapping_add(4 * i);
            let reg = first + i as usize;
            if load {
                self.s[reg] = self.read(ctx, a, AccessSize::Word)?;
            } else {
                let v = self.s[reg];
                self.write(ctx, a, AccessSize::Word, v)?;
            }
        }
        if let Some(wb) = wback {
            self.set_reg(rn, wb);
        }
        Ok(())
    }

    fn fp_transfer(&mut self, hw1: u32, hw2: u32, opcode: u32) -> Exec {
        let a = (hw1 >> 5) & 7;
        let to_arm = hw1 & (1 << 4) != 0;
        let c = hw2 & (1 << 8) != 0;
        let rt = (hw2 >> 12) & 0xF;
        if c {
            return Err(Trap::Unimplemented(opcode)); // VMOV scalar
        }
        match a {
            0b000 => {
                let sn = Self::sreg_index(hw1 & 0xF, (hw2 >> 7) & 1);
                if to_arm {
                    let v = self.s[sn];
                    self.set_reg(rt, v);
                } else {
                    self.s[sn] = self.reg(rt);
                }
                Ok(())
            }
            0b111 if hw1 & 0xF == 0b0001 => {
                if to_arm {
                    if rt == 15 {
                        let flags = self.fpscr >> 28;
                        self.n = flags & 8 != 0;
                        self.z = flags & 4 != 0;
                        self.c = flags & 2 != 0;
                        self.v = flags & 1 != 0;
                    } else {
                        let v = self.fpscr;
                        self.set_reg(rt, v);
                    }
                } else {
                    self.fpscr = self.reg(rt) & 0xF7C0_009F;
                }
                Ok(())
            }
            _ => Err(Trap::Unimplemented(opcode)),
        }
    }

    fn fp_data_processing(&mut self, hw1: u32, hw2: u32, opcode: u32) -> Exec {
        if hw2 & (1 << 8) != 0 {
            // Double precision is not implemented by FPv4-SP.
            return Err(Fault::UndefInstr.into());
        }
        let opc1 = (((hw1 >> 7) & 1) << 2) | ((hw1 >> 4) & 3);
        let op = (hw2 >> 6) & 1;
        let sd = Self::sreg_index((hw2 >> 12) & 0xF, (hw1 >> 6) & 1);
        let sn = Self::sreg_index(hw1 & 0xF, (hw2 >> 7) & 1);
        let sm = Self::sreg_index(hw2 & 0xF, (hw2 >> 5) & 1);
        let (d, n, m) = (self.s[sd], self.s[sn], self.s[sm]);

        let r = match opc1 {
            0b000 => {
                // VMLA / VMLS (not fused)
                let mut p = self.fp_binop(n, m, Op::Mul);
                if op == 1 {
                    p = Self::fp_neg(p);
                }
                self.fp_binop(d, p, Op::Add)
            }
            0b001 => {
                // VNMLS (op=0): -d + n*m ; VNMLA (op=1): -d - n*m
                let mut p = self.fp_binop(n, m, Op::Mul);
                if op == 1 {
                    p = Self::fp_neg(p);
                }
                self.fp_binop(Self::fp_neg(d), p, Op::Add)
            }
            0b010 => {
                let p = self.fp_binop(n, m, Op::Mul);
                if op == 1 {
                    Self::fp_neg(p)
                } else {
                    p
                }
            }
            0b011 => self.fp_binop(n, m, if op == 0 { Op::Add } else { Op::Sub }),
            0b100 if op == 0 => {
                self.cyc += 13;
                self.fp_binop(n, m, Op::Div)
            }
            0b101 => {
                // VFNMS (op=0): -d + n*m ; VFNMA (op=1): -d - n*m
                let n2 = if op == 1 { Self::fp_neg(n) } else { n };
                self.fp_fma(Self::fp_neg(d), n2, m)
            }
            0b110 => {
                // VFMA (op=0): d + n*m ; VFMS (op=1): d - n*m
                let n2 = if op == 1 { Self::fp_neg(n) } else { n };
                self.fp_fma(d, n2, m)
            }
            0b111 => return self.fp_other(hw1, hw2, sd, sm, opcode),
            _ => return Err(Trap::Unimplemented(opcode)),
        };
        self.s[sd] = r;
        Ok(())
    }

    fn fp_other(&mut self, hw1: u32, hw2: u32, sd: usize, sm: usize, opcode: u32) -> Exec {
        if hw2 & (1 << 6) == 0 {
            // VMOV (immediate)
            self.s[sd] = vfp_expand_imm(((hw1 & 0xF) << 4) | (hw2 & 0xF));
            return Ok(());
        }
        let opc2 = hw1 & 0xF;
        let bit7 = hw2 & (1 << 7) != 0;
        let m = self.s[sm];
        let r = match opc2 {
            0b0000 => {
                if bit7 {
                    m & 0x7FFF_FFFF
                } else {
                    m
                }
            }
            0b0001 => {
                if bit7 {
                    self.cyc += 13;
                    let x = self.flush_in(m);
                    if let Some(nan) = self.process_nans(&[x]) {
                        nan
                    } else if x == 0x8000_0000 {
                        x
                    } else if x & 0x8000_0000 != 0 {
                        self.fpscr |= IOC;
                        DEFAULT_NAN
                    } else {
                        self.fp_result((f32::from_bits(x) as f64).sqrt())
                    }
                } else {
                    Self::fp_neg(m)
                }
            }
            0b0010 | 0b0011 => {
                // VCVTB / VCVTT
                let top = bit7;
                if opc2 & 1 == 0 {
                    let h = if top { (m >> 16) as u16 } else { m as u16 };
                    f16_to_f32(h)
                } else {
                    let m = self.flush_in(m);
                    let (h, flags) = f32_to_f16(m);
                    self.fpscr |= flags;
                    let h = h as u32;
                    let old = self.s[sd];
                    if top {
                        (old & 0xFFFF) | (h << 16)
                    } else {
                        (old & 0xFFFF_0000) | h
                    }
                }
            }
            0b0100 | 0b0101 => {
                let other = if opc2 & 1 != 0 { 0 } else { m };
                let d = self.s[sd];
                self.fp_compare(d, other, bit7);
                return Ok(());
            }
            0b1000 => {
                let v = if bit7 { m as i32 as f64 } else { m as f64 };
                self.fp_result(v)
            }
            0b1100 | 0b1101 => {
                let mode = if bit7 { Round::Zero } else { self.rmode() };
                self.fp_to_int(m, opc2 & 1 != 0, mode)
            }
            0b1010 | 0b1011 | 0b1110 | 0b1111 => {
                // VCVT between floating point and fixed point
                let to_fixed = opc2 & 0b0100 != 0;
                let unsigned = opc2 & 1 != 0;
                let size = if bit7 { 32 } else { 16 };
                let imm = ((hw2 & 0xF) << 1) | ((hw2 >> 5) & 1);
                let frac = size - imm as i32;
                let d = self.s[sd];
                if to_fixed {
                    let x = self.flush_in(d);
                    if is_nan(x) {
                        self.fpscr |= IOC;
                        0
                    } else {
                        let f = f32::from_bits(x) as f64 * 2f64.powi(frac);
                        let r = round_int(f, Round::Zero);
                        let (lo, hi) = if unsigned {
                            (0.0, (2f64.powi(size) - 1.0))
                        } else {
                            (-(2f64.powi(size - 1)), 2f64.powi(size - 1) - 1.0)
                        };
                        let c = r.clamp(lo, hi);
                        if c != r {
                            self.fpscr |= IOC;
                        } else if r != f {
                            self.fpscr |= IXC;
                        }
                        let v = c as i64 as u32;
                        if size == 16 {
                            if unsigned {
                                v & 0xFFFF
                            } else {
                                v as u16 as i16 as u32
                            }
                        } else {
                            v
                        }
                    }
                } else {
                    let raw = if size == 16 {
                        if unsigned {
                            (d & 0xFFFF) as f64
                        } else {
                            d as u16 as i16 as f64
                        }
                    } else if unsigned {
                        d as f64
                    } else {
                        d as i32 as f64
                    };
                    self.fp_result(raw / 2f64.powi(frac))
                }
            }
            _ => return Err(Trap::Unimplemented(opcode)),
        };
        self.s[sd] = r;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_imm() {
        assert_eq!(f32::from_bits(vfp_expand_imm(0x70)), 1.0);
        assert_eq!(f32::from_bits(vfp_expand_imm(0x00)), 2.0);
        assert_eq!(f32::from_bits(vfp_expand_imm(0xE0)), -0.5);
        assert_eq!(f32::from_bits(vfp_expand_imm(0x24)), 10.0);
    }

    #[test]
    fn directed_rounding() {
        let x = 1.0f64 + 2f64.powi(-30);
        assert_eq!(round_f32(x, Round::Nearest), (1.0, true));
        assert_eq!(round_f32(x, Round::PlusInf).0, next_toward(1.0, true));
        assert_eq!(round_f32(-x, Round::Zero).0, -1.0);
        assert_eq!(round_f32(1e300, Round::Zero).0, f32::MAX);
    }

    #[test]
    fn half_precision_roundtrip() {
        for v in [0.0f32, 1.0, -2.5, 65504.0, 6.1035156e-5, 5.9604645e-8] {
            assert_eq!(
                f32::from_bits(f16_to_f32(f32_to_f16(v.to_bits()).0)),
                v,
                "{v}"
            );
        }
        assert_eq!(f32_to_f16(1.0f32.to_bits()), (0x3C00, 0));
        assert_eq!(f32_to_f16(1e6f32.to_bits()), (0x7C00, OFC | IXC));
    }
}
