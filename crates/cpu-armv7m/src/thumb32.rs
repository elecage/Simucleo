//! 32-bit Thumb-2 instructions (ARMv7-M ARM A5.3).

use simucleo_core::bus::AccessSize;
use simucleo_core::cortexm::{control, Fault};

use crate::alu::{
    add_with_carry, decode_imm_shift, shift, shift_c, sign_extend, signed_sat_q,
    thumb_expand_imm_c, unsigned_sat_q, Shift,
};
use crate::{ArmV7M, Ctx, Exec, Trap};

#[inline]
fn bits(v: u32, hi: u32, lo: u32) -> u32 {
    (v >> lo) & ((1 << (hi - lo + 1)) - 1)
}

impl ArmV7M {
    pub(crate) fn exec32(&mut self, ctx: &mut Ctx, hw1: u32, hw2: u32) -> Exec {
        let op1 = bits(hw1, 12, 11);
        let op2 = bits(hw1, 10, 4);
        let opcode = (hw1 << 16) | hw2;
        match op1 {
            0b01 => {
                if op2 & 0b110_0100 == 0b000_0000 {
                    self.t32_ldm_stm(ctx, hw1, hw2, opcode)
                } else if op2 & 0b110_0100 == 0b000_0100 {
                    self.t32_dual_exclusive_table(ctx, hw1, hw2, opcode)
                } else if op2 & 0b110_0000 == 0b010_0000 {
                    self.t32_dp_shifted_register(hw1, hw2, opcode)
                } else {
                    self.exec_coproc(ctx, hw1, hw2)
                }
            }
            0b10 => {
                if hw2 & 0x8000 == 0 {
                    if op2 & 0b010_0000 == 0 {
                        self.t32_dp_modified_imm(hw1, hw2)
                    } else {
                        self.t32_dp_plain_imm(hw1, hw2, opcode)
                    }
                } else {
                    self.t32_branch_misc(hw1, hw2, opcode)
                }
            }
            _ => {
                if op2 & 0b111_0001 == 0b000_0000 {
                    self.t32_load_store_single(ctx, hw1, hw2, false, opcode)
                } else if op2 & 0b110_0111 == 0b000_0111 {
                    Err(Fault::UndefInstr.into())
                } else if op2 & 0b110_0001 == 0b000_0001 {
                    self.t32_load_store_single(ctx, hw1, hw2, true, opcode)
                } else if op2 & 0b111_0000 == 0b010_0000 {
                    self.t32_dp_register(hw1, hw2, opcode)
                } else if op2 & 0b111_1000 == 0b011_0000 {
                    self.t32_multiply(hw1, hw2, opcode)
                } else if op2 & 0b111_1000 == 0b011_1000 {
                    self.t32_long_multiply_divide(ctx, hw1, hw2, opcode)
                } else if op2 & 0b100_0000 != 0 {
                    self.exec_coproc(ctx, hw1, hw2)
                } else {
                    Err(Trap::Unimplemented(opcode))
                }
            }
        }
    }

    // ------------------------------------------------------ load/store multiple

    fn t32_ldm_stm(&mut self, ctx: &mut Ctx, hw1: u32, hw2: u32, opcode: u32) -> Exec {
        let op = bits(hw1, 8, 7);
        let wback = hw1 & (1 << 5) != 0;
        let load = hw1 & (1 << 4) != 0;
        let rn = hw1 & 0xF;
        let list = hw2 & if load { 0xDFFF } else { 0x5FFF };
        if list == 0 || !(op == 0b01 || op == 0b10) {
            return Err(Trap::Unimplemented(opcode));
        }
        let count = list.count_ones();
        let base = self.reg(rn);
        let (start, end) = if op == 0b01 {
            (base, base.wrapping_add(4 * count))
        } else {
            let s = base.wrapping_sub(4 * count);
            (s, s)
        };
        self.check_aligned(start, 4)?;
        let mut addr = start;
        if load {
            let mut vals = [0u32; 16];
            for (i, v) in vals.iter_mut().enumerate() {
                if list & (1 << i) != 0 {
                    *v = self.read_u32(ctx, addr)?;
                    addr = addr.wrapping_add(4);
                }
            }
            if wback && list & (1 << rn) == 0 {
                self.set_reg(rn, end);
            }
            for (i, v) in vals.iter().enumerate().take(15) {
                if list & (1 << i) != 0 {
                    self.set_reg(i as u32, *v);
                }
            }
            if list & (1 << 15) != 0 {
                self.bx_write_pc(vals[15]);
            }
        } else {
            for i in 0..15 {
                if list & (1 << i) != 0 {
                    let v = self.reg(i);
                    self.write_u32(ctx, addr, v)?;
                    addr = addr.wrapping_add(4);
                }
            }
            if wback {
                self.set_reg(rn, end);
            }
        }
        Ok(())
    }

    // ------------------------------------- load/store dual, exclusive, table branch

    fn t32_dual_exclusive_table(&mut self, ctx: &mut Ctx, hw1: u32, hw2: u32, opcode: u32) -> Exec {
        let p = hw1 & (1 << 8) != 0;
        let u = hw1 & (1 << 7) != 0;
        let w = hw1 & (1 << 5) != 0;
        let l = hw1 & (1 << 4) != 0;
        let rn = hw1 & 0xF;
        let rt = bits(hw2, 15, 12);

        if !p && !w {
            let op3 = bits(hw2, 7, 4);
            return match (u, l) {
                (false, false) => {
                    // STREX
                    let rd = bits(hw2, 11, 8);
                    let addr = self.reg(rn).wrapping_add((hw2 & 0xFF) << 2);
                    self.check_aligned(addr, 4)?;
                    self.store_exclusive(ctx, rd, addr, AccessSize::Word, self.reg(rt))
                }
                (false, true) => {
                    let addr = self.reg(rn).wrapping_add((hw2 & 0xFF) << 2);
                    self.check_aligned(addr, 4)?;
                    let v = self.read_u32(ctx, addr)?;
                    self.exclusive = Some(addr);
                    self.set_reg(rt, v);
                    Ok(())
                }
                (true, false) => {
                    let rd = hw2 & 0xF;
                    let addr = self.reg(rn);
                    let size = match op3 {
                        0b0100 => AccessSize::Byte,
                        0b0101 => AccessSize::Half,
                        _ => return Err(Trap::Unimplemented(opcode)),
                    };
                    self.check_aligned(addr, size.bytes())?;
                    self.store_exclusive(ctx, rd, addr, size, self.reg(rt))
                }
                (true, true) => {
                    let addr_base = self.reg(rn);
                    match op3 {
                        0b0000 | 0b0001 => {
                            // TBB / TBH
                            let rm = self.reg(hw2 & 0xF);
                            let half = op3 == 1;
                            let off = if half {
                                self.read(ctx, addr_base.wrapping_add(rm << 1), AccessSize::Half)?
                            } else {
                                self.read(ctx, addr_base.wrapping_add(rm), AccessSize::Byte)?
                            };
                            self.branch_write_pc(self.reg(15).wrapping_add(off << 1));
                            Ok(())
                        }
                        0b0100 | 0b0101 => {
                            let size = if op3 == 0b0100 {
                                AccessSize::Byte
                            } else {
                                AccessSize::Half
                            };
                            self.check_aligned(addr_base, size.bytes())?;
                            let v = self.read(ctx, addr_base, size)?;
                            self.exclusive = Some(addr_base);
                            self.set_reg(rt, v);
                            Ok(())
                        }
                        _ => Err(Trap::Unimplemented(opcode)),
                    }
                }
            };
        }

        // LDRD / STRD (immediate, or literal for LDRD)
        let rt2 = bits(hw2, 11, 8);
        let imm = (hw2 & 0xFF) << 2;
        let base = if rn == 15 {
            self.pc_aligned()
        } else {
            self.reg(rn)
        };
        let offset_addr = if u {
            base.wrapping_add(imm)
        } else {
            base.wrapping_sub(imm)
        };
        let addr = if p { offset_addr } else { base };
        self.check_aligned(addr, 4)?;
        if l {
            let a = self.read_u32(ctx, addr)?;
            let b = self.read_u32(ctx, addr.wrapping_add(4))?;
            if w {
                self.set_reg(rn, offset_addr);
            }
            self.set_reg(rt, a);
            self.set_reg(rt2, b);
        } else {
            let (a, b) = (self.reg(rt), self.reg(rt2));
            self.write_u32(ctx, addr, a)?;
            self.write_u32(ctx, addr.wrapping_add(4), b)?;
            if w {
                self.set_reg(rn, offset_addr);
            }
        }
        Ok(())
    }

    fn store_exclusive(
        &mut self,
        ctx: &mut Ctx,
        rd: u32,
        addr: u32,
        size: AccessSize,
        value: u32,
    ) -> Exec {
        // The Cortex-M4 local monitor does not compare addresses.
        if self.exclusive.take().is_some() {
            self.write(ctx, addr, size, value)?;
            self.set_reg(rd, 0);
        } else {
            self.set_reg(rd, 1);
        }
        Ok(())
    }

    // ------------------------------------------------------ data processing

    fn write_logical(&mut self, rd: u32, res: u32, s: bool, carry: bool) {
        self.set_reg(rd, res);
        if s {
            self.set_nz(res);
            self.c = carry;
        }
    }

    fn write_arith(&mut self, rd: u32, (res, c, v): (u32, bool, bool), s: bool) {
        self.set_reg(rd, res);
        if s {
            self.set_nzcv(res, c, v);
        }
    }

    /// Shared by the shifted-register and modified-immediate encodings.
    #[allow(clippy::too_many_arguments)]
    fn dp_op(
        &mut self,
        op: u32,
        s: bool,
        rn: u32,
        rd: u32,
        operand: u32,
        carry: bool,
        opcode: u32,
    ) -> Exec {
        let test = rd == 15 && s;
        let a = self.reg(rn);
        match op {
            0b0000 => {
                let r = a & operand;
                if test {
                    self.set_nz(r);
                    self.c = carry;
                } else {
                    self.write_logical(rd, r, s, carry);
                }
            }
            0b0001 => self.write_logical(rd, a & !operand, s, carry),
            0b0010 => {
                let r = if rn == 15 { operand } else { a | operand };
                self.write_logical(rd, r, s, carry);
            }
            0b0011 => {
                let r = if rn == 15 { !operand } else { a | !operand };
                self.write_logical(rd, r, s, carry);
            }
            0b0100 => {
                let r = a ^ operand;
                if test {
                    self.set_nz(r);
                    self.c = carry;
                } else {
                    self.write_logical(rd, r, s, carry);
                }
            }
            0b1000 => {
                let r = add_with_carry(a, operand, false);
                if test {
                    self.set_nzcv(r.0, r.1, r.2);
                } else {
                    self.write_arith(rd, r, s);
                }
            }
            0b1010 => self.write_arith(rd, add_with_carry(a, operand, self.c), s),
            0b1011 => self.write_arith(rd, add_with_carry(a, !operand, self.c), s),
            0b1101 => {
                let r = add_with_carry(a, !operand, true);
                if test {
                    self.set_nzcv(r.0, r.1, r.2);
                } else {
                    self.write_arith(rd, r, s);
                }
            }
            0b1110 => self.write_arith(rd, add_with_carry(!a, operand, true), s),
            _ => return Err(Trap::Unimplemented(opcode)),
        }
        Ok(())
    }

    fn t32_dp_shifted_register(&mut self, hw1: u32, hw2: u32, opcode: u32) -> Exec {
        let op = bits(hw1, 8, 5);
        let s = hw1 & (1 << 4) != 0;
        let rn = hw1 & 0xF;
        let rd = bits(hw2, 11, 8);
        let rm = hw2 & 0xF;
        let imm5 = (bits(hw2, 14, 12) << 2) | bits(hw2, 7, 6);
        let ty = bits(hw2, 5, 4);
        if op == 0b0110 {
            // PKHBT / PKHTB
            let tb = ty & 2 != 0;
            let (sh, n) = decode_imm_shift(ty, imm5);
            let op2 = shift(self.reg(rm), sh, n, self.c);
            let a = self.reg(rn);
            let r = if tb {
                (a & 0xFFFF_0000) | (op2 & 0xFFFF)
            } else {
                (op2 & 0xFFFF_0000) | (a & 0xFFFF)
            };
            self.set_reg(rd, r);
            return Ok(());
        }
        let (sh, n) = decode_imm_shift(ty, imm5);
        let (operand, carry) = shift_c(self.reg(rm), sh, n, self.c);
        self.dp_op(op, s, rn, rd, operand, carry, opcode)
    }

    fn t32_dp_modified_imm(&mut self, hw1: u32, hw2: u32) -> Exec {
        let op = bits(hw1, 8, 5);
        let s = hw1 & (1 << 4) != 0;
        let rn = hw1 & 0xF;
        let rd = bits(hw2, 11, 8);
        let imm12 = (bits(hw1, 10, 10) << 11) | (bits(hw2, 14, 12) << 8) | (hw2 & 0xFF);
        let (imm32, carry) = thumb_expand_imm_c(imm12, self.c);
        self.dp_op(op, s, rn, rd, imm32, carry, (hw1 << 16) | hw2)
    }

    fn t32_dp_plain_imm(&mut self, hw1: u32, hw2: u32, opcode: u32) -> Exec {
        let op = bits(hw1, 8, 4);
        let rn = hw1 & 0xF;
        let rd = bits(hw2, 11, 8);
        let i = bits(hw1, 10, 10);
        let imm3 = bits(hw2, 14, 12);
        let imm8 = hw2 & 0xFF;
        let imm12 = (i << 11) | (imm3 << 8) | imm8;
        let imm16 = (rn << 12) | imm12;
        let imm5 = (imm3 << 2) | bits(hw2, 7, 6);
        let field = hw2 & 0x1F;
        match op {
            0b00000 => {
                let base = if rn == 15 {
                    self.pc_aligned()
                } else {
                    self.reg(rn)
                };
                self.set_reg(rd, base.wrapping_add(imm12));
            }
            0b01010 => {
                let base = if rn == 15 {
                    self.pc_aligned()
                } else {
                    self.reg(rn)
                };
                self.set_reg(rd, base.wrapping_sub(imm12));
            }
            0b00100 => self.set_reg(rd, imm16),
            0b01100 => {
                let v = (self.reg(rd) & 0xFFFF) | (imm16 << 16);
                self.set_reg(rd, v);
            }
            0b10000 | 0b10010 => {
                if op == 0b10010 && imm5 == 0 {
                    // SSAT16
                    let sat = (field & 0xF) + 1;
                    let v = self.reg(rn);
                    let (lo, q1) = signed_sat_q(v as u16 as i16 as i64, sat);
                    let (hi, q2) = signed_sat_q((v >> 16) as u16 as i16 as i64, sat);
                    self.set_reg(rd, (lo as u32 & 0xFFFF) | ((hi as u32) << 16));
                    self.q |= q1 || q2;
                } else {
                    let sh = if op & 2 != 0 { Shift::Asr } else { Shift::Lsl };
                    let operand = shift(self.reg(rn), sh, imm5, self.c) as i32 as i64;
                    let (r, q) = signed_sat_q(operand, field + 1);
                    self.set_reg(rd, r as u32);
                    self.q |= q;
                }
            }
            0b11000 | 0b11010 => {
                if op == 0b11010 && imm5 == 0 {
                    // USAT16
                    let sat = field & 0xF;
                    let v = self.reg(rn);
                    let (lo, q1) = unsigned_sat_q(v as u16 as i16 as i64, sat);
                    let (hi, q2) = unsigned_sat_q((v >> 16) as u16 as i16 as i64, sat);
                    self.set_reg(rd, (lo & 0xFFFF) | (hi << 16));
                    self.q |= q1 || q2;
                } else {
                    let sh = if op & 2 != 0 { Shift::Asr } else { Shift::Lsl };
                    let operand = shift(self.reg(rn), sh, imm5, self.c) as i32 as i64;
                    let (r, q) = unsigned_sat_q(operand, field);
                    self.set_reg(rd, r);
                    self.q |= q;
                }
            }
            0b10100 | 0b11100 => {
                // SBFX / UBFX
                let lsb = imm5;
                let width = field + 1;
                if lsb + width > 32 {
                    return Err(Trap::Unimplemented(opcode));
                }
                let v = self.reg(rn) >> lsb;
                let mask = if width == 32 {
                    u32::MAX
                } else {
                    (1 << width) - 1
                };
                let r = if op == 0b10100 {
                    sign_extend(v & mask, width)
                } else {
                    v & mask
                };
                self.set_reg(rd, r);
            }
            0b10110 => {
                // BFI / BFC
                let lsb = imm5;
                let msb = field;
                if msb < lsb {
                    return Err(Trap::Unimplemented(opcode));
                }
                let width = msb - lsb + 1;
                let mask = if width == 32 {
                    u32::MAX
                } else {
                    ((1u32 << width) - 1) << lsb
                };
                let src = if rn == 15 { 0 } else { self.reg(rn) << lsb };
                let v = (self.reg(rd) & !mask) | (src & mask);
                self.set_reg(rd, v);
            }
            _ => return Err(Trap::Unimplemented(opcode)),
        }
        Ok(())
    }

    // ------------------------------------------------- branches, misc control

    fn t32_branch_misc(&mut self, hw1: u32, hw2: u32, opcode: u32) -> Exec {
        let op1 = bits(hw2, 14, 12);
        let op = bits(hw1, 10, 4);
        let s = bits(hw1, 10, 10);
        let j1 = bits(hw2, 13, 13);
        let j2 = bits(hw2, 11, 11);
        let imm11 = hw2 & 0x7FF;
        match op1 {
            0b000 | 0b010 => {
                if op & 0b011_1000 != 0b011_1000 {
                    // B<cond> (T3)
                    let cond = bits(hw1, 9, 6);
                    let imm = (s << 20)
                        | (j2 << 19)
                        | (j1 << 18)
                        | (bits(hw1, 5, 0) << 12)
                        | (imm11 << 1);
                    if self.cond_passed(cond) {
                        self.branch_write_pc(self.reg(15).wrapping_add(sign_extend(imm, 21)));
                    }
                    return Ok(());
                }
                if op1 == 0b010 && op == 0b111_1111 {
                    return Err(Fault::UndefInstr.into()); // UDF.W
                }
                match op {
                    0b011_1000 | 0b011_1001 => self.msr(hw1 & 0xF, bits(hw2, 11, 10), hw2 & 0xFF),
                    0b011_1010 => {
                        if hw2 & 0x700 == 0 && hw2 & 0xF0 == 0 {
                            self.hint(hw2 & 0xF);
                        }
                        Ok(())
                    }
                    0b011_1011 => {
                        if bits(hw2, 7, 4) == 0b0010 {
                            self.exclusive = None; // CLREX
                        }
                        // DSB / DMB / ISB: no reordering to model.
                        Ok(())
                    }
                    0b011_1110 | 0b011_1111 => {
                        let v = self.mrs(hw2 & 0xFF);
                        self.set_reg(bits(hw2, 11, 8), v);
                        Ok(())
                    }
                    _ => Err(Trap::Unimplemented(opcode)),
                }
            }
            0b001 | 0b011 | 0b101 | 0b111 => {
                let i1 = !(j1 ^ s) & 1;
                let i2 = !(j2 ^ s) & 1;
                let imm =
                    (s << 24) | (i1 << 23) | (i2 << 22) | ((hw1 & 0x3FF) << 12) | (imm11 << 1);
                let target = self.reg(15).wrapping_add(sign_extend(imm, 25));
                if op1 & 0b100 != 0 {
                    // BL
                    self.r[14] = self.next_pc | 1;
                }
                self.branch_write_pc(target);
                Ok(())
            }
            _ => Err(Fault::UndefInstr.into()),
        }
    }

    fn mrs(&self, sysm: u32) -> u32 {
        match sysm {
            0..=7 => {
                let mut v = 0;
                if sysm & 1 != 0 {
                    v |= self.ipsr as u32;
                }
                if sysm & 4 == 0 {
                    v |= self.apsr();
                }
                v
            }
            8 if self.privileged() => self.msp(),
            9 if self.privileged() => self.psp(),
            16 => self.primask,
            17 | 18 => self.basepri,
            19 => self.faultmask,
            20 => self.control,
            _ => 0,
        }
    }

    fn msr(&mut self, rn: u32, mask: u32, sysm: u32) -> Exec {
        let v = self.reg(rn);
        match sysm {
            0..=7 => {
                if sysm & 4 == 0 {
                    if mask & 2 != 0 {
                        self.n = v & (1 << 31) != 0;
                        self.z = v & (1 << 30) != 0;
                        self.c = v & (1 << 29) != 0;
                        self.v = v & (1 << 28) != 0;
                        self.q = v & (1 << 27) != 0;
                    }
                    if mask & 1 != 0 {
                        self.ge = ((v >> 16) & 0xF) as u8;
                    }
                }
            }
            _ if !self.privileged() => {}
            8 => self.set_msp(v),
            9 => self.set_psp(v),
            16 => self.primask = v & 1,
            17 => self.basepri = v & 0xF0,
            18 => {
                let nv = v & 0xF0;
                if nv != 0 && (nv < self.basepri || self.basepri == 0) {
                    self.basepri = nv;
                }
            }
            19 => {
                // FAULTMASK cannot be set from NMI or HardFault.
                if !matches!(self.ipsr, 2 | 3) || v & 1 == 0 {
                    self.faultmask = v & 1;
                }
            }
            20 => self.write_control(v & (control::NPRIV | control::SPSEL | control::FPCA)),
            _ => {}
        }
        Ok(())
    }

    // ----------------------------------------------------- load/store single

    fn t32_load_store_single(
        &mut self,
        ctx: &mut Ctx,
        hw1: u32,
        hw2: u32,
        load: bool,
        opcode: u32,
    ) -> Exec {
        let size = match bits(hw1, 6, 5) {
            0 => AccessSize::Byte,
            1 => AccessSize::Half,
            2 => AccessSize::Word,
            _ => return Err(Trap::Unimplemented(opcode)),
        };
        let signed = load && hw1 & (1 << 8) != 0;
        let rn = hw1 & 0xF;
        let rt = bits(hw2, 15, 12);

        let (addr, wback) = if rn == 15 {
            if !load {
                return Err(Fault::UndefInstr.into());
            }
            let imm = hw2 & 0xFFF;
            let base = self.pc_aligned();
            (
                if hw1 & (1 << 7) != 0 {
                    base.wrapping_add(imm)
                } else {
                    base.wrapping_sub(imm)
                },
                None,
            )
        } else if hw1 & (1 << 7) != 0 {
            (self.reg(rn).wrapping_add(hw2 & 0xFFF), None)
        } else if hw2 & (1 << 11) != 0 {
            let p = hw2 & (1 << 10) != 0;
            let u = hw2 & (1 << 9) != 0;
            let w = hw2 & (1 << 8) != 0;
            if !p && !w {
                return Err(Fault::UndefInstr.into());
            }
            let imm = hw2 & 0xFF;
            let base = self.reg(rn);
            let off = if u {
                base.wrapping_add(imm)
            } else {
                base.wrapping_sub(imm)
            };
            (if p { off } else { base }, if w { Some(off) } else { None })
        } else if bits(hw2, 11, 6) == 0 {
            let rm = self.reg(hw2 & 0xF);
            (self.reg(rn).wrapping_add(rm << bits(hw2, 5, 4)), None)
        } else {
            return Err(Trap::Unimplemented(opcode));
        };

        if load {
            if rt == 15 && size != AccessSize::Word {
                return Ok(()); // PLD / PLI
            }
            self.check_unaligned(ctx, addr, size)?;
            let raw = self.read(ctx, addr, size)?;
            let v = match (size, signed) {
                (AccessSize::Byte, true) => raw as u8 as i8 as u32,
                (AccessSize::Half, true) => raw as u16 as i16 as u32,
                _ => raw,
            };
            if let Some(wb) = wback {
                self.set_reg(rn, wb);
            }
            if rt == 15 {
                self.bx_write_pc(v);
            } else {
                self.set_reg(rt, v);
            }
        } else {
            self.check_unaligned(ctx, addr, size)?;
            let v = self.reg(rt);
            self.write(ctx, addr, size, v)?;
            if let Some(wb) = wback {
                self.set_reg(rn, wb);
            }
        }
        Ok(())
    }

    // ------------------------------------------------- data processing (reg)

    fn t32_dp_register(&mut self, hw1: u32, hw2: u32, opcode: u32) -> Exec {
        let op1 = bits(hw1, 7, 4);
        let op2 = bits(hw2, 7, 4);
        let rn = hw1 & 0xF;
        let rd = bits(hw2, 11, 8);
        let rm = hw2 & 0xF;
        if hw2 & 0xF000 != 0xF000 {
            return Err(Trap::Unimplemented(opcode));
        }
        if op1 & 0b1000 == 0 && op2 == 0 {
            // LSL/LSR/ASR/ROR (register)
            let sh = match op1 >> 1 {
                0 => Shift::Lsl,
                1 => Shift::Lsr,
                2 => Shift::Asr,
                _ => Shift::Ror,
            };
            let (r, c) = shift_c(self.reg(rn), sh, self.reg(rm) & 0xFF, self.c);
            self.write_logical(rd, r, op1 & 1 != 0, c);
            return Ok(());
        }
        if op1 & 0b1000 == 0 && op2 & 0b1000 != 0 {
            // Extend (and add)
            let rot = self.reg(rm).rotate_right(bits(hw2, 5, 4) * 8);
            let base = if rn == 15 { 0 } else { self.reg(rn) };
            let r = match op1 {
                0b0000 => base.wrapping_add(rot as u16 as i16 as u32),
                0b0001 => base.wrapping_add(rot & 0xFFFF),
                0b0010 | 0b0011 => {
                    let (lo, hi) = if op1 == 0b0010 {
                        (rot as u8 as i8 as u32, (rot >> 16) as u8 as i8 as u32)
                    } else {
                        (rot & 0xFF, (rot >> 16) & 0xFF)
                    };
                    let l = (base & 0xFFFF).wrapping_add(lo) & 0xFFFF;
                    let h = (base >> 16).wrapping_add(hi) & 0xFFFF;
                    l | (h << 16)
                }
                0b0100 => base.wrapping_add(rot as u8 as i8 as u32),
                0b0101 => base.wrapping_add(rot & 0xFF),
                _ => return Err(Trap::Unimplemented(opcode)),
            };
            self.set_reg(rd, r);
            return Ok(());
        }
        if op1 & 0b1000 != 0 && op2 & 0b1000 == 0 {
            return self.parallel_add_sub(hw1, hw2, opcode);
        }
        if op1 & 0b1100 == 0b1000 && op2 & 0b1100 == 0b1000 {
            let a = self.reg(rn);
            let m = self.reg(rm);
            let r = match (op1 & 3, op2 & 3) {
                (0, 0) => self.qadd(m, a),
                (0, 1) => {
                    let d = self.qadd(a, a);
                    self.qadd(m, d)
                }
                (0, 2) => self.qsub(m, a),
                (0, 3) => {
                    let d = self.qadd(a, a);
                    self.qsub(m, d)
                }
                (1, 0) => m.swap_bytes(),
                (1, 1) => ((m & 0x00FF_00FF) << 8) | ((m >> 8) & 0x00FF_00FF),
                (1, 2) => m.reverse_bits(),
                (1, 3) => (m as u16).swap_bytes() as i16 as u32,
                (2, 0) => self.sel(a, m),
                (3, 0) => m.leading_zeros(),
                _ => return Err(Trap::Unimplemented(opcode)),
            };
            self.set_reg(rd, r);
            return Ok(());
        }
        Err(Trap::Unimplemented(opcode))
    }

    // ------------------------------------------------------------- multiply

    fn t32_multiply(&mut self, hw1: u32, hw2: u32, opcode: u32) -> Exec {
        let op1 = bits(hw1, 6, 4);
        let op2 = bits(hw2, 5, 4);
        let rn = self.reg(hw1 & 0xF);
        let rm = self.reg(hw2 & 0xF);
        let ra_n = bits(hw2, 15, 12);
        let ra = self.reg(ra_n);
        let accumulate = ra_n != 15;
        let rd = bits(hw2, 11, 8);
        let half = |v: u32, top: bool| -> i64 {
            if top {
                (v >> 16) as u16 as i16 as i64
            } else {
                v as u16 as i16 as i64
            }
        };
        let r = match op1 {
            0 => match op2 {
                0 => {
                    let p = rn.wrapping_mul(rm);
                    if accumulate {
                        p.wrapping_add(ra)
                    } else {
                        p
                    }
                }
                1 => ra.wrapping_sub(rn.wrapping_mul(rm)),
                _ => return Err(Trap::Unimplemented(opcode)),
            },
            1 => {
                let p = half(rn, op2 & 2 != 0) * half(rm, op2 & 1 != 0);
                if accumulate {
                    self.add_q(p, ra)
                } else {
                    p as u32
                }
            }
            2 | 4 => {
                let m = if op2 & 1 != 0 {
                    rm.rotate_right(16)
                } else {
                    rm
                };
                let p1 = half(rn, false) * half(m, false);
                let p2 = half(rn, true) * half(m, true);
                let p = if op1 == 2 { p1 + p2 } else { p1 - p2 };
                if accumulate {
                    self.add_q(p, ra)
                } else {
                    self.add_q(p, 0)
                }
            }
            3 => {
                let p = (rn as i32 as i64 * half(rm, op2 & 1 != 0)) >> 16;
                if accumulate {
                    self.add_q(p, ra)
                } else {
                    p as u32
                }
            }
            5 | 6 => {
                let prod = rn as i32 as i64 * rm as i32 as i64;
                let acc = if accumulate {
                    (ra as i32 as i64) << 32
                } else {
                    0
                };
                let round = if op2 & 1 != 0 { 0x8000_0000i64 } else { 0 };
                let r = if op1 == 5 {
                    acc.wrapping_add(prod)
                } else {
                    acc.wrapping_sub(prod)
                };
                (r.wrapping_add(round) >> 32) as u32
            }
            7 if op2 == 0 => {
                let sum: u32 = (0..4)
                    .map(|i| ((rn >> (8 * i)) & 0xFF).abs_diff((rm >> (8 * i)) & 0xFF))
                    .sum();
                if accumulate {
                    sum.wrapping_add(ra)
                } else {
                    sum
                }
            }
            _ => return Err(Trap::Unimplemented(opcode)),
        };
        self.set_reg(rd, r);
        Ok(())
    }

    /// Signed add that sets Q on 32-bit overflow (SMLA*, SMLAD, …).
    fn add_q(&mut self, p: i64, ra: u32) -> u32 {
        let r = p + ra as i32 as i64;
        if r != r as i32 as i64 {
            self.q = true;
        }
        r as u32
    }

    fn t32_long_multiply_divide(&mut self, ctx: &mut Ctx, hw1: u32, hw2: u32, opcode: u32) -> Exec {
        let op1 = bits(hw1, 6, 4);
        let op2 = bits(hw2, 7, 4);
        let rn = self.reg(hw1 & 0xF);
        let rm = self.reg(hw2 & 0xF);
        let lo_n = bits(hw2, 15, 12);
        let hi_n = bits(hw2, 11, 8);
        let acc = ((self.reg(hi_n) as u64) << 32) | self.reg(lo_n) as u64;
        let half = |v: u32, top: bool| -> i64 {
            if top {
                (v >> 16) as u16 as i16 as i64
            } else {
                v as u16 as i16 as i64
            }
        };
        let result: u64 = match (op1, op2) {
            (0b000, 0) => (rn as i32 as i64 * rm as i32 as i64) as u64,
            (0b010, 0) => rn as u64 * rm as u64,
            (0b100, 0) => acc.wrapping_add((rn as i32 as i64 * rm as i32 as i64) as u64),
            (0b110, 0) => acc.wrapping_add(rn as u64 * rm as u64),
            (0b110, 0b0110) => {
                rn as u64 * rm as u64 + self.reg(hi_n) as u64 + self.reg(lo_n) as u64
            }
            (0b100, 0b1000..=0b1011) => {
                let p = half(rn, op2 & 2 != 0) * half(rm, op2 & 1 != 0);
                acc.wrapping_add(p as u64)
            }
            (0b100, 0b1100 | 0b1101) | (0b101, 0b1100 | 0b1101) => {
                let m = if op2 & 1 != 0 {
                    rm.rotate_right(16)
                } else {
                    rm
                };
                let p1 = half(rn, false) * half(m, false);
                let p2 = half(rn, true) * half(m, true);
                let p = if op1 == 0b100 { p1 + p2 } else { p1 - p2 };
                acc.wrapping_add(p as u64)
            }
            (0b001, 0xF) | (0b011, 0xF) => {
                self.cyc += 6;
                let r = if rm == 0 {
                    if ctx.sys.ccr & (1 << 4) != 0 {
                        return Err(Fault::DivByZero.into());
                    }
                    0
                } else if op1 == 0b001 {
                    (rn as i32).wrapping_div(rm as i32) as u32
                } else {
                    rn / rm
                };
                self.set_reg(hi_n, r);
                return Ok(());
            }
            _ => return Err(Trap::Unimplemented(opcode)),
        };
        self.cyc += 1;
        self.set_reg(lo_n, result as u32);
        self.set_reg(hi_n, (result >> 32) as u32);
        Ok(())
    }
}
