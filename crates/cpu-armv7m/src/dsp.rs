//! DSP extension: SIMD add/subtract, saturating arithmetic, SEL.

use crate::alu::{signed_sat_q, unsigned_sat_q};
use crate::{ArmV7M, Exec, Trap};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Variant {
    Plain,
    Saturating,
    Halving,
}

impl ArmV7M {
    pub(crate) fn qadd(&mut self, a: u32, b: u32) -> u32 {
        let (r, q) = signed_sat_q(a as i32 as i64 + b as i32 as i64, 32);
        self.q |= q;
        r as u32
    }

    pub(crate) fn qsub(&mut self, a: u32, b: u32) -> u32 {
        let (r, q) = signed_sat_q(a as i32 as i64 - b as i32 as i64, 32);
        self.q |= q;
        r as u32
    }

    /// SEL: pick bytes from `a` where GE[i] is set, otherwise from `b`.
    pub(crate) fn sel(&self, a: u32, b: u32) -> u32 {
        (0..4).fold(0, |acc, i| {
            let src = if self.ge & (1 << i) != 0 { a } else { b };
            acc | (src & (0xFF << (8 * i)))
        })
    }

    /// SADD16, UQSUB8, SHASX, … (ARMv7-M ARM A5.3.13 / A5.3.14).
    pub(crate) fn parallel_add_sub(&mut self, hw1: u32, hw2: u32, opcode: u32) -> Exec {
        let op1 = (hw1 >> 4) & 7;
        let unsigned = hw2 & (1 << 6) != 0;
        let variant = match (hw2 >> 4) & 3 {
            0 => Variant::Plain,
            1 => Variant::Saturating,
            2 => Variant::Halving,
            _ => return Err(Trap::Unimplemented(opcode)),
        };
        let a = self.reg(hw1 & 0xF);
        let b = self.reg(hw2 & 0xF);
        let rd = (hw2 >> 8) & 0xF;

        // Lane width, and per-lane operation: (+1 add, -1 sub) with the
        // operand lane index used from `b` (ASX/SAX cross the halves).
        let (width, ops): (u32, &[(i64, usize)]) = match op1 {
            0b001 => (16, &[(1, 0), (1, 1)]),
            0b010 => (16, &[(-1, 1), (1, 0)]), // ASX: lo = a.lo - b.hi, hi = a.hi + b.lo
            0b110 => (16, &[(1, 1), (-1, 0)]), // SAX: lo = a.lo + b.hi, hi = a.hi - b.lo
            0b101 => (16, &[(-1, 0), (-1, 1)]),
            0b000 => (8, &[(1, 0), (1, 1), (1, 2), (1, 3)]),
            0b100 => (8, &[(-1, 0), (-1, 1), (-1, 2), (-1, 3)]),
            _ => return Err(Trap::Unimplemented(opcode)),
        };
        let mask = (1u64 << width) - 1;
        let lane = |v: u32, i: usize| -> i64 {
            let raw = ((v as u64 >> (width as usize * i)) & mask) as i64;
            if unsigned {
                raw
            } else {
                // sign-extend
                (raw << (64 - width)) >> (64 - width)
            }
        };

        let mut result = 0u32;
        let mut ge = 0u8;
        for (i, (sign, bi)) in ops.iter().enumerate() {
            let sum = lane(a, i) + sign * lane(b, *bi);
            let out = match variant {
                Variant::Plain => {
                    let set = if unsigned {
                        if *sign > 0 {
                            sum >= (1 << width)
                        } else {
                            sum >= 0
                        }
                    } else {
                        sum >= 0
                    };
                    if set {
                        // GE bits: one per byte; 16-bit lanes set two.
                        let per = width / 8;
                        ge |= (((1u32 << per) - 1) << (i as u32 * per)) as u8;
                    }
                    sum as u64 & mask
                }
                Variant::Saturating => {
                    if unsigned {
                        unsigned_sat_q(sum, width).0 as u64
                    } else {
                        signed_sat_q(sum, width).0 as u64 & mask
                    }
                }
                Variant::Halving => (sum >> 1) as u64 & mask,
            };
            result |= (out << (width as usize * i)) as u32;
        }
        if variant == Variant::Plain {
            self.ge = ge;
        }
        self.set_reg(rd, result);
        Ok(())
    }
}
