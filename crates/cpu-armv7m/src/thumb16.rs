//! 16-bit Thumb instructions (ARMv7-M ARM A5.2).

use simucleo_core::bus::AccessSize;
use simucleo_core::cortexm::Fault;

use crate::alu::{add_with_carry, shift_c, Shift};
use crate::{ArmV7M, Ctx, Exec, Trap};

impl ArmV7M {
    pub(crate) fn exec16(&mut self, ctx: &mut Ctx, hw: u32) -> Exec {
        let op = hw >> 10;
        match op {
            0b000000..=0b001111 => self.t16_shift_add_sub_mov_cmp(hw),
            0b010000 => self.t16_data_processing(hw),
            0b010001 => self.t16_special_data_branch(hw),
            0b010010 | 0b010011 => {
                // LDR (literal)
                let rt = (hw >> 8) & 7;
                let addr = self.pc_aligned().wrapping_add((hw & 0xFF) << 2);
                let v = self.read_u32(ctx, addr)?;
                self.r[rt as usize] = v;
                Ok(())
            }
            0b010100..=0b100111 => self.t16_load_store(ctx, hw),
            0b101000 | 0b101001 => {
                // ADR
                let rd = (hw >> 8) & 7;
                self.r[rd as usize] = self.pc_aligned().wrapping_add((hw & 0xFF) << 2);
                Ok(())
            }
            0b101010 | 0b101011 => {
                // ADD Rd, SP, #imm8<<2
                let rd = (hw >> 8) & 7;
                self.r[rd as usize] = self.r[13].wrapping_add((hw & 0xFF) << 2);
                Ok(())
            }
            0b101100..=0b101111 => self.t16_misc(ctx, hw),
            0b110000 | 0b110001 => {
                // STM Rn!, {list}
                let rn = (hw >> 8) & 7;
                let list = hw & 0xFF;
                if list == 0 {
                    return Err(Trap::Unimplemented(hw));
                }
                let mut addr = self.r[rn as usize];
                self.check_aligned(addr, 4)?;
                for i in 0..8 {
                    if list & (1 << i) != 0 {
                        let v = self.r[i];
                        self.write_u32(ctx, addr, v)?;
                        addr = addr.wrapping_add(4);
                    }
                }
                self.r[rn as usize] = addr;
                Ok(())
            }
            0b110010 | 0b110011 => {
                // LDM Rn{!}, {list}
                let rn = (hw >> 8) & 7;
                let list = hw & 0xFF;
                if list == 0 {
                    return Err(Trap::Unimplemented(hw));
                }
                let mut addr = self.r[rn as usize];
                self.check_aligned(addr, 4)?;
                let mut vals = [0u32; 8];
                for (i, v) in vals.iter_mut().enumerate() {
                    if list & (1 << i) != 0 {
                        *v = self.read_u32(ctx, addr)?;
                        addr = addr.wrapping_add(4);
                    }
                }
                for (i, v) in vals.iter().enumerate() {
                    if list & (1 << i) != 0 {
                        self.r[i] = *v;
                    }
                }
                if list & (1 << rn) == 0 {
                    self.r[rn as usize] = addr;
                }
                Ok(())
            }
            0b110100..=0b110111 => {
                let cond = (hw >> 8) & 0xF;
                match cond {
                    0xE => Err(Fault::UndefInstr.into()), // UDF
                    0xF => {
                        self.svc = true;
                        Ok(())
                    }
                    _ => {
                        if self.cond_passed(cond) {
                            let imm = (((hw & 0xFF) << 24) as i32 >> 23) as u32;
                            self.branch_write_pc(self.reg(15).wrapping_add(imm));
                        }
                        Ok(())
                    }
                }
            }
            0b111000 | 0b111001 => {
                // B (unconditional)
                let imm = (((hw & 0x7FF) << 21) as i32 >> 20) as u32;
                self.branch_write_pc(self.reg(15).wrapping_add(imm));
                Ok(())
            }
            _ => Err(Trap::Unimplemented(hw)),
        }
    }

    fn t16_shift_add_sub_mov_cmp(&mut self, hw: u32) -> Exec {
        let setflags = !self.in_it_block();
        let rd = (hw & 7) as usize;
        let rm = (hw >> 3) & 7;
        let imm5 = (hw >> 6) & 0x1F;
        match (hw >> 11) & 0x1F {
            0b00000..=0b00010 => {
                // LSL/LSR/ASR (immediate); LSL #0 is MOVS Rd, Rm
                let (ty, amount) = crate::alu::decode_imm_shift((hw >> 11) & 3, imm5);
                let (res, carry) = shift_c(self.r[rm as usize], ty, amount, self.c);
                self.r[rd] = res;
                if setflags {
                    self.set_nz(res);
                    self.c = carry;
                }
            }
            0b00011 => {
                let rn = self.r[rm as usize];
                let operand = if hw & (1 << 10) != 0 {
                    (hw >> 6) & 7
                } else {
                    self.r[((hw >> 6) & 7) as usize]
                };
                let (res, c, v) = if hw & (1 << 9) == 0 {
                    add_with_carry(rn, operand, false)
                } else {
                    add_with_carry(rn, !operand, true)
                };
                self.r[rd] = res;
                if setflags {
                    self.set_nzcv(res, c, v);
                }
            }
            op => {
                let rdn = ((hw >> 8) & 7) as usize;
                let imm = hw & 0xFF;
                match op {
                    0b00100 => {
                        self.r[rdn] = imm;
                        if setflags {
                            self.set_nz(imm);
                        }
                    }
                    0b00101 => {
                        let (res, c, v) = add_with_carry(self.r[rdn], !imm, true);
                        self.set_nzcv(res, c, v);
                    }
                    0b00110 => {
                        let (res, c, v) = add_with_carry(self.r[rdn], imm, false);
                        self.r[rdn] = res;
                        if setflags {
                            self.set_nzcv(res, c, v);
                        }
                    }
                    _ => {
                        let (res, c, v) = add_with_carry(self.r[rdn], !imm, true);
                        self.r[rdn] = res;
                        if setflags {
                            self.set_nzcv(res, c, v);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn t16_data_processing(&mut self, hw: u32) -> Exec {
        let setflags = !self.in_it_block();
        let rdn = (hw & 7) as usize;
        let rm = self.r[((hw >> 3) & 7) as usize];
        let a = self.r[rdn];
        let logical = |cpu: &mut Self, res: u32, carry: bool, write: bool| {
            if write {
                cpu.r[rdn] = res;
            }
            if setflags || !write {
                cpu.set_nz(res);
                cpu.c = carry;
            }
        };
        let arith = |cpu: &mut Self, (res, c, v): (u32, bool, bool), write: bool| {
            if write {
                cpu.r[rdn] = res;
            }
            if setflags || !write {
                cpu.set_nzcv(res, c, v);
            }
        };
        match (hw >> 6) & 0xF {
            0x0 => logical(self, a & rm, self.c, true),
            0x1 => logical(self, a ^ rm, self.c, true),
            0x2 | 0x3 | 0x4 | 0x7 => {
                let ty = match (hw >> 6) & 0xF {
                    0x2 => Shift::Lsl,
                    0x3 => Shift::Lsr,
                    0x4 => Shift::Asr,
                    _ => Shift::Ror,
                };
                let (res, carry) = shift_c(a, ty, rm & 0xFF, self.c);
                logical(self, res, carry, true);
            }
            0x5 => arith(self, add_with_carry(a, rm, self.c), true),
            0x6 => arith(self, add_with_carry(a, !rm, self.c), true),
            0x8 => logical(self, a & rm, self.c, false), // TST
            0x9 => {
                // RSB Rd, Rn, #0 (NEG)
                let rd = rdn;
                let (res, c, v) = add_with_carry(!rm, 0, true);
                self.r[rd] = res;
                if setflags {
                    self.set_nzcv(res, c, v);
                }
            }
            0xA => arith(self, add_with_carry(a, !rm, true), false), // CMP
            0xB => arith(self, add_with_carry(a, rm, false), false), // CMN
            0xC => logical(self, a | rm, self.c, true),
            0xD => {
                let res = a.wrapping_mul(rm);
                self.r[rdn] = res;
                if setflags {
                    self.set_nz(res);
                }
            }
            0xE => logical(self, a & !rm, self.c, true),
            _ => logical(self, !rm, self.c, true), // MVN
        }
        Ok(())
    }

    fn t16_special_data_branch(&mut self, hw: u32) -> Exec {
        let rm = (hw >> 3) & 0xF;
        let rdn = (hw & 7) | ((hw >> 4) & 8);
        match (hw >> 8) & 3 {
            0 => {
                // ADD (register), no flags; ADD SP/PC forms included
                let res = self.reg(rdn).wrapping_add(self.reg(rm));
                self.set_reg(rdn, res);
            }
            1 => {
                let (res, c, v) = add_with_carry(self.reg(rdn), !self.reg(rm), true);
                self.set_nzcv(res, c, v);
            }
            2 => {
                let v = self.reg(rm);
                self.set_reg(rdn, v);
            }
            _ => {
                let target = self.reg(rm);
                if hw & (1 << 7) != 0 {
                    // BLX
                    self.r[14] = self.next_pc | 1;
                }
                self.bx_write_pc(target);
            }
        }
        Ok(())
    }

    fn t16_load_store(&mut self, ctx: &mut Ctx, hw: u32) -> Exec {
        let rt = (hw & 7) as usize;
        let rn = self.r[((hw >> 3) & 7) as usize];
        let op = hw >> 12;
        if op == 0b0101 {
            let addr = rn.wrapping_add(self.r[((hw >> 6) & 7) as usize]);
            return match (hw >> 9) & 7 {
                0 => {
                    let v = self.r[rt];
                    self.check_unaligned(ctx, addr, AccessSize::Word)?;
                    self.write_u32(ctx, addr, v)
                }
                1 => {
                    let v = self.r[rt];
                    self.check_unaligned(ctx, addr, AccessSize::Half)?;
                    self.write(ctx, addr, AccessSize::Half, v)
                }
                2 => {
                    let v = self.r[rt];
                    self.write(ctx, addr, AccessSize::Byte, v)
                }
                3 => {
                    self.r[rt] = self.read(ctx, addr, AccessSize::Byte)? as u8 as i8 as u32;
                    Ok(())
                }
                4 => {
                    self.check_unaligned(ctx, addr, AccessSize::Word)?;
                    self.r[rt] = self.read_u32(ctx, addr)?;
                    Ok(())
                }
                5 => {
                    self.check_unaligned(ctx, addr, AccessSize::Half)?;
                    self.r[rt] = self.read(ctx, addr, AccessSize::Half)?;
                    Ok(())
                }
                6 => {
                    self.r[rt] = self.read(ctx, addr, AccessSize::Byte)?;
                    Ok(())
                }
                _ => {
                    self.check_unaligned(ctx, addr, AccessSize::Half)?;
                    self.r[rt] = self.read(ctx, addr, AccessSize::Half)? as u16 as i16 as u32;
                    Ok(())
                }
            };
        }

        let imm5 = (hw >> 6) & 0x1F;
        let load = hw & (1 << 11) != 0;
        let (addr, size, rt) = match op {
            0b0110 => (rn.wrapping_add(imm5 << 2), AccessSize::Word, rt),
            0b0111 => (rn.wrapping_add(imm5), AccessSize::Byte, rt),
            0b1000 => (rn.wrapping_add(imm5 << 1), AccessSize::Half, rt),
            _ => {
                // SP-relative
                let rt = ((hw >> 8) & 7) as usize;
                (
                    self.r[13].wrapping_add((hw & 0xFF) << 2),
                    AccessSize::Word,
                    rt,
                )
            }
        };
        self.check_unaligned(ctx, addr, size)?;
        if load {
            self.r[rt] = self.read(ctx, addr, size)?;
            Ok(())
        } else {
            let v = self.r[rt];
            self.write(ctx, addr, size, v)
        }
    }

    fn t16_misc(&mut self, ctx: &mut Ctx, hw: u32) -> Exec {
        match (hw >> 5) & 0x7F {
            0b0000000..=0b0000011 => {
                self.r[13] = self.r[13].wrapping_add((hw & 0x7F) << 2);
                Ok(())
            }
            0b0000100..=0b0000111 => {
                self.r[13] = self.r[13].wrapping_sub((hw & 0x7F) << 2);
                Ok(())
            }
            0b0010000..=0b0010111 => {
                let rd = (hw & 7) as usize;
                let m = self.r[((hw >> 3) & 7) as usize];
                self.r[rd] = match (hw >> 6) & 3 {
                    0 => m as u16 as i16 as u32,
                    1 => m as u8 as i8 as u32,
                    2 => m & 0xFFFF,
                    _ => m & 0xFF,
                };
                Ok(())
            }
            0b0100000..=0b0101111 => {
                // PUSH {list, LR}
                let list = (hw & 0xFF) | if hw & (1 << 8) != 0 { 1 << 14 } else { 0 };
                if list == 0 {
                    return Err(Trap::Unimplemented(hw));
                }
                self.push_list(ctx, list)
            }
            0b0110011 => {
                // CPS
                if self.privileged() {
                    let disable = hw & (1 << 4) != 0;
                    if hw & 2 != 0 {
                        self.primask = disable as u32;
                    }
                    if hw & 1 != 0 && (!disable || self.ipsr != 2) {
                        self.faultmask = disable as u32;
                    }
                }
                Ok(())
            }
            0b1010000..=0b1010111 => {
                let rd = (hw & 7) as usize;
                let m = self.r[((hw >> 3) & 7) as usize];
                self.r[rd] = match (hw >> 6) & 3 {
                    0 => m.swap_bytes(),
                    1 => ((m & 0x00FF_00FF) << 8) | ((m >> 8) & 0x00FF_00FF),
                    3 => (m as u16).swap_bytes() as i16 as u32,
                    _ => return Err(Trap::Unimplemented(hw)),
                };
                Ok(())
            }
            0b1100000..=0b1101111 => {
                // POP {list, PC}
                let list = (hw & 0xFF) | if hw & (1 << 8) != 0 { 1 << 15 } else { 0 };
                if list == 0 {
                    return Err(Trap::Unimplemented(hw));
                }
                self.pop_list(ctx, list)
            }
            0b1110000..=0b1110111 => {
                // BKPT: treat as a debug halt request -> fault (no debugger attached)
                Err(Trap::Unimplemented(hw))
            }
            0b1111000..=0b1111111 => {
                let mask = hw & 0xF;
                if mask != 0 {
                    // IT
                    self.it = (hw & 0xFF) as u8;
                    self.it_written = true;
                    return Ok(());
                }
                self.hint((hw >> 4) & 0xF);
                Ok(())
            }
            _ => {
                // CBZ / CBNZ
                if hw & (1 << 8) != 0 && hw & (1 << 10) == 0 {
                    let rn = self.r[(hw & 7) as usize];
                    let nonzero = hw & (1 << 11) != 0;
                    if (rn != 0) == nonzero {
                        let imm = (((hw >> 9) & 1) << 6) | (((hw >> 3) & 0x1F) << 1);
                        self.branch_write_pc(self.reg(15).wrapping_add(imm));
                    }
                    Ok(())
                } else {
                    Err(Trap::Unimplemented(hw))
                }
            }
        }
    }

    /// NOP, YIELD, WFE, WFI, SEV.
    pub(crate) fn hint(&mut self, op: u32) {
        match op {
            2 => {
                if self.event {
                    self.event = false;
                } else {
                    self.sleeping = true;
                }
            }
            3 => self.sleeping = true,
            4 => self.event = true,
            _ => {}
        }
    }

    /// Full-descending push of registers in `list` (bit n = Rn).
    pub(crate) fn push_list(&mut self, ctx: &mut Ctx, list: u32) -> Exec {
        let count = list.count_ones();
        let start = self.r[13].wrapping_sub(4 * count);
        self.check_aligned(start, 4)?;
        let mut addr = start;
        for i in 0..15 {
            if list & (1 << i) != 0 {
                let v = self.r[i];
                self.write_u32(ctx, addr, v)?;
                addr = addr.wrapping_add(4);
            }
        }
        self.r[13] = start;
        Ok(())
    }

    pub(crate) fn pop_list(&mut self, ctx: &mut Ctx, list: u32) -> Exec {
        let mut addr = self.r[13];
        self.check_aligned(addr, 4)?;
        let mut vals = [0u32; 16];
        for (i, v) in vals.iter_mut().enumerate() {
            if list & (1 << i) != 0 {
                *v = self.read_u32(ctx, addr)?;
                addr = addr.wrapping_add(4);
            }
        }
        self.r[13] = addr;
        for (i, v) in vals.iter().enumerate().take(15) {
            if list & (1 << i) != 0 && i != 13 {
                self.r[i] = *v;
            }
        }
        if list & (1 << 15) != 0 {
            self.bx_write_pc(vals[15]);
        }
        Ok(())
    }
}
