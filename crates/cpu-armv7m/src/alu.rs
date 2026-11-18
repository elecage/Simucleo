//! Arithmetic helpers from the ARMv7-M ARM pseudocode (A2.2, A5.3).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shift {
    Lsl,
    Lsr,
    Asr,
    Ror,
    Rrx,
}

/// `AddWithCarry(x, y, carry_in)` → (result, carry_out, overflow).
#[inline]
pub fn add_with_carry(x: u32, y: u32, carry: bool) -> (u32, bool, bool) {
    let unsigned = x as u64 + y as u64 + carry as u64;
    let signed = x as i32 as i64 + y as i32 as i64 + carry as i64;
    let result = unsigned as u32;
    (result, unsigned >> 32 != 0, result as i32 as i64 != signed)
}

/// `DecodeImmShift(type, imm5)`.
#[inline]
pub fn decode_imm_shift(ty: u32, imm5: u32) -> (Shift, u32) {
    match ty & 3 {
        0 => (Shift::Lsl, imm5),
        1 => (Shift::Lsr, if imm5 == 0 { 32 } else { imm5 }),
        2 => (Shift::Asr, if imm5 == 0 { 32 } else { imm5 }),
        _ => {
            if imm5 == 0 {
                (Shift::Rrx, 1)
            } else {
                (Shift::Ror, imm5)
            }
        }
    }
}

/// `Shift_C(value, type, amount, carry_in)` → (result, carry_out).
#[inline]
pub fn shift_c(value: u32, shift: Shift, amount: u32, carry_in: bool) -> (u32, bool) {
    if amount == 0 && shift != Shift::Rrx {
        return (value, carry_in);
    }
    match shift {
        Shift::Lsl => {
            if amount < 32 {
                (value << amount, (value >> (32 - amount)) & 1 != 0)
            } else if amount == 32 {
                (0, value & 1 != 0)
            } else {
                (0, false)
            }
        }
        Shift::Lsr => {
            if amount < 32 {
                (value >> amount, (value >> (amount - 1)) & 1 != 0)
            } else if amount == 32 {
                (0, value >> 31 != 0)
            } else {
                (0, false)
            }
        }
        Shift::Asr => {
            if amount < 32 {
                (
                    ((value as i32) >> amount) as u32,
                    ((value as i32) >> (amount - 1)) & 1 != 0,
                )
            } else {
                let r = ((value as i32) >> 31) as u32;
                (r, r & 1 != 0)
            }
        }
        Shift::Ror => {
            let a = amount % 32;
            let r = value.rotate_right(a);
            (r, r >> 31 != 0)
        }
        Shift::Rrx => ((value >> 1) | ((carry_in as u32) << 31), value & 1 != 0),
    }
}

#[inline]
pub fn shift(value: u32, shift: Shift, amount: u32, carry_in: bool) -> u32 {
    shift_c(value, shift, amount, carry_in).0
}

/// `ThumbExpandImm_C(imm12, carry_in)` → (imm32, carry_out).
#[inline]
pub fn thumb_expand_imm_c(imm12: u32, carry_in: bool) -> (u32, bool) {
    if imm12 >> 10 == 0 {
        let b = imm12 & 0xFF;
        let v = match (imm12 >> 8) & 3 {
            0 => b,
            1 => (b << 16) | b,
            2 => (b << 24) | (b << 8),
            _ => (b << 24) | (b << 16) | (b << 8) | b,
        };
        (v, carry_in)
    } else {
        let unrotated = 0x80 | (imm12 & 0x7F);
        let r = unrotated.rotate_right(imm12 >> 7);
        (r, r >> 31 != 0)
    }
}

/// Signed saturation to `bits` bits → (value, saturated).
#[inline]
pub fn signed_sat_q(v: i64, bits: u32) -> (i32, bool) {
    let max = (1i64 << (bits - 1)) - 1;
    let min = -(1i64 << (bits - 1));
    if v > max {
        (max as i32, true)
    } else if v < min {
        (min as i32, true)
    } else {
        (v as i32, false)
    }
}

/// Unsigned saturation to `bits` bits → (value, saturated).
#[inline]
pub fn unsigned_sat_q(v: i64, bits: u32) -> (u32, bool) {
    let max = if bits >= 32 {
        u32::MAX as i64
    } else {
        (1i64 << bits) - 1
    };
    if v > max {
        (max as u32, true)
    } else if v < 0 {
        (0, true)
    } else {
        (v as u32, false)
    }
}

#[inline]
pub fn sign_extend(value: u32, bits: u32) -> u32 {
    let s = 32 - bits;
    (((value << s) as i32) >> s) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_with_carry_flags() {
        assert_eq!(add_with_carry(0xFFFF_FFFF, 1, false), (0, true, false));
        assert_eq!(
            add_with_carry(0x7FFF_FFFF, 1, false),
            (0x8000_0000, false, true)
        );
        // SUB 5 - 7 = ADD 5 + !7 + 1
        assert_eq!(add_with_carry(5, !7, true), (0xFFFF_FFFE, false, false));
        assert_eq!(add_with_carry(7, !5, true), (2, true, false));
    }

    #[test]
    fn expand_imm() {
        assert_eq!(thumb_expand_imm_c(0x0AB, false).0, 0xAB);
        assert_eq!(thumb_expand_imm_c(0x1AB, false).0, 0x00AB_00AB);
        assert_eq!(thumb_expand_imm_c(0x2AB, false).0, 0xAB00_AB00);
        assert_eq!(thumb_expand_imm_c(0x3AB, false).0, 0xABAB_ABAB);
        // 0x4FF: rotate 0xFF by 9 → 0x7F80_0000, carry = bit31 = 0
        assert_eq!(thumb_expand_imm_c(0x4FF, true), (0x7F80_0000, false));
    }

    #[test]
    fn shifts() {
        assert_eq!(shift_c(0x8000_0001, Shift::Lsl, 1, false), (2, true));
        assert_eq!(
            shift_c(0x8000_0000, Shift::Asr, 32, false),
            (0xFFFF_FFFF, true)
        );
        assert_eq!(shift_c(1, Shift::Rrx, 1, true), (0x8000_0000, true));
        assert_eq!(shift_c(0x1234, Shift::Lsr, 0, true), (0x1234, true));
    }
}
