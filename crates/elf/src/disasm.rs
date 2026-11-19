//! Thumb-2 disassembly for the debugger's machine-code view, with branch
//! targets as absolute addresses and symbol names.

use serde::Serialize;
use yaxpeax_arch::{Decoder, LengthedInstruction, U8Reader};
use yaxpeax_arm::armv7::InstDecoder;

/// One decoded instruction.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Insn {
    pub addr: u32,
    /// The instruction's bytes in hex, as halfwords (`f000 f999`).
    pub bytes: String,
    pub text: String,
}

/// Turn the decoder's `$±0x…` (relative to the instruction + 4) into
/// absolute addresses, and name PC-relative literals and branch targets.
fn annotate(text: &str, addr: u32, symbol: &dyn Fn(u32) -> Option<String>) -> String {
    let mut out = text.to_string();
    if let Some(i) = out.find('$') {
        let rest = &out[i + 1..];
        let (sign, num) = rest.split_at(1);
        let end = num
            .find(|c: char| !c.is_ascii_alphanumeric())
            .unwrap_or(num.len());
        if let Ok(off) = i64::from_str_radix(num[..end].trim_start_matches("0x"), 16) {
            let off = if sign == "-" { -off } else { off };
            let target = (addr as i64 + 4 + off) as u32;
            let name = symbol(target)
                .map(|n| format!(" <{n}>"))
                .unwrap_or_default();
            out = format!("{}0x{target:08x}{name}{}", &out[..i], &num[end..]);
        }
    }
    if let Some(i) = out.find("[pc, ") {
        let rest = &out[i + 5..];
        let end = rest.find(']').unwrap_or(rest.len());
        let v = rest[..end].trim_start_matches('#');
        let off = v.strip_prefix("0x").map_or_else(
            || v.parse::<i64>().ok(),
            |h| i64::from_str_radix(h, 16).ok(),
        );
        if let Some(off) = off {
            let lit = ((addr + 4) & !3) as i64 + off;
            out.push_str(&format!("    ; 0x{lit:08x}"));
        }
    }
    out
}

/// Decode `count` instructions from `addr` (Thumb). Bytes that do not
/// decode (data in literal pools) show as `.short`.
pub fn disassemble(
    read: &dyn Fn(u32, usize) -> Option<Vec<u8>>,
    addr: u32,
    count: usize,
    symbol: &dyn Fn(u32) -> Option<String>,
) -> Vec<Insn> {
    let decoder = InstDecoder::default_thumb();
    let mut out = Vec::with_capacity(count);
    let mut pc = addr & !1;
    for _ in 0..count {
        let Some(bytes) = read(pc, 4).or_else(|| read(pc, 2)) else {
            break;
        };
        let mut reader = U8Reader::new(&bytes);
        let (len, text) = match decoder.decode(&mut reader) {
            Ok(i) => (i.len().to_const(), annotate(&i.to_string(), pc, symbol)),
            Err(_) => (
                2,
                format!(".short 0x{:04x}", u16::from_le_bytes([bytes[0], bytes[1]])),
            ),
        };
        let halves: Vec<String> = bytes[..len as usize]
            .chunks(2)
            .map(|h| format!("{:04x}", u16::from_le_bytes([h[0], h[1]])))
            .collect();
        out.push(Insn {
            addr: pc,
            bytes: halves.join(" "),
            text,
        });
        pc += len;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branches_and_literals_get_absolute_addresses() {
        // push {r4, lr}; bl +0x10; ldr r0, [pc, #8]; bx lr
        let code: Vec<u8> = vec![0x10, 0xb5, 0x00, 0xf0, 0x08, 0xf8, 0x02, 0x48, 0x70, 0x47];
        let base = 0x0800_0100;
        let read = |a: u32, n: usize| {
            let o = (a - base) as usize;
            (o + n <= code.len() + 2).then(|| {
                let mut v = code.get(o..).unwrap_or(&[]).to_vec();
                v.resize(n, 0);
                v
            })
        };
        let sym = |a: u32| (a == 0x0800_0116).then(|| "target".to_string());
        let insns = disassemble(&read, base, 4, &sym);
        assert_eq!(insns[0].text, "push {r4, lr}");
        assert_eq!(insns[1].bytes, "f000 f808");
        assert!(
            insns[1].text.contains("0x08000116 <target>"),
            "{}",
            insns[1].text
        );
        assert!(insns[2].text.contains("; 0x08000110"), "{}", insns[2].text);
        assert_eq!(insns[3].text, "bx lr");
    }
}
