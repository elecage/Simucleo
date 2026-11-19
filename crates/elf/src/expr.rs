//! C expressions over the program's variables, for watch expressions and
//! breakpoint conditions: names (locals of the frame, then globals),
//! literals, `.`, `->`, `[]`, unary `- ! ~ *`, and the binary arithmetic,
//! shift, bitwise, comparison and logical operators with C precedence.

use std::collections::HashMap;
use std::rc::Rc;

use gimli::{AttributeValue, UnitOffset};

use crate::debug::{DebugInfo, Frame, ReadMem, Src, Value, Write};

type Dwarf<'a> = gimli::Dwarf<gimli::EndianSlice<'a, gimli::LittleEndian>>;
type Unit<'a> = gimli::Unit<gimli::EndianSlice<'a, gimli::LittleEndian>>;
type UnitId = gimli::DebugInfoOffset<usize>;

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(i64),
    Float(f64),
    Ident(String),
    Op(&'static str),
}

const OPS: [&str; 30] = [
    "->", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "(", ")", "[", "]", ".", "+", "-", "*",
    "/", "%", "<", ">", "&", "|", "^", "!", "~", ",", "?", ":", "=",
];

fn lex(s: &str) -> Result<Vec<Tok>, String> {
    let b = s.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    while i < b.len() {
        let c = b[i] as char;
        if c.is_whitespace() {
            i += 1;
        } else if c.is_ascii_digit() {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'.') {
                i += 1;
            }
            let raw = &s[start..i];
            let hex = raw.starts_with("0x") || raw.starts_with("0X");
            let t = raw.trim_end_matches(['u', 'U', 'l', 'L']);
            // `f` is a float suffix only for decimal numbers; in hex it is a digit.
            let t = if !hex && t.contains(['.', 'e', 'E']) {
                t.trim_end_matches(['f', 'F'])
            } else {
                t
            };
            if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
                out.push(Tok::Num(
                    i64::from_str_radix(h, 16).map_err(|_| format!("bad number {t}"))?,
                ));
            } else if t.contains(['.', 'e', 'E']) {
                out.push(Tok::Float(
                    t.parse().map_err(|_| format!("bad number {t}"))?,
                ));
            } else {
                out.push(Tok::Num(t.parse().map_err(|_| format!("bad number {t}"))?));
            }
        } else if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            out.push(Tok::Ident(s[start..i].to_string()));
        } else if c == '\'' && i + 2 < b.len() && b[i + 2] == b'\'' {
            out.push(Tok::Num(b[i + 1] as i64));
            i += 3;
        } else {
            let op = OPS
                .iter()
                .find(|o| s[i..].starts_with(**o))
                .ok_or_else(|| format!("unexpected '{c}'"))?;
            out.push(Tok::Op(op));
            i += op.len();
        }
    }
    Ok(out)
}

/// A value during evaluation.
#[derive(Clone)]
enum Val {
    Int(i64),
    Float(f64),
    /// An object in the program: its type (in a unit) and where it is.
    /// `skip` dimensions of an array type have been indexed already.
    Obj {
        unit: UnitId,
        ty: Option<UnitOffset<usize>>,
        src: Src,
        skip: usize,
        /// A bit field: its first bit (counted from `src`) and width.
        bits: Option<(u32, u32)>,
    },
}

pub(crate) struct Evaluator<'a, 'r> {
    info: &'a DebugInfo,
    dwarf: Dwarf<'a>,
    units: HashMap<UnitId, Rc<Unit<'a>>>,
    frame: &'r Frame,
    read: ReadMem<'r>,
    toks: Vec<Tok>,
    pos: usize,
    /// Inside the right side of a short-circuited `&&`/`||`: parse, but
    /// read and compute nothing.
    skipping: usize,
}

impl<'a, 'r> Evaluator<'a, 'r> {
    pub(crate) fn new(
        info: &'a DebugInfo,
        dwarf: Dwarf<'a>,
        frame: &'r Frame,
        read: ReadMem<'r>,
    ) -> Self {
        Self {
            info,
            dwarf,
            units: HashMap::new(),
            frame,
            read,
            toks: Vec::new(),
            pos: 0,
            skipping: 0,
        }
    }

    fn unit(&mut self, id: UnitId) -> Result<Rc<Unit<'a>>, String> {
        if let Some(u) = self.units.get(&id) {
            return Ok(u.clone());
        }
        let header = self
            .dwarf
            .debug_info
            .header_from_offset(id)
            .map_err(|e| e.to_string())?;
        let unit = Rc::new(self.dwarf.unit(header).map_err(|e| e.to_string())?);
        self.units.insert(id, unit.clone());
        Ok(unit)
    }

    /// Evaluate and format.
    pub(crate) fn value(&mut self, expr: &str) -> Result<Value, String> {
        let v = self.parse_all(expr)?;
        Ok(match v {
            Val::Int(i) => Value {
                name: expr.to_string(),
                ty: "int".into(),
                value: i.to_string(),
                ..Default::default()
            },
            Val::Float(f) => Value {
                name: expr.to_string(),
                ty: "double".into(),
                value: f.to_string(),
                ..Default::default()
            },
            Val::Obj { bits: Some(_), .. } => {
                // A bit field: its type's name, the extracted number.
                let Val::Obj { unit, ty, .. } = v.clone() else {
                    unreachable!()
                };
                let n = self.scalar(v)?;
                let u = self.unit(unit)?;
                let mut out =
                    self.info
                        .render_value(&self.dwarf, &u, ty, Src::Bytes(vec![0; 8]), self.read);
                out.children.clear();
                out.value = match n {
                    Val::Int(i) => i.to_string(),
                    Val::Float(f) => f.to_string(),
                    Val::Obj { .. } => unreachable!(),
                };
                out.name = expr.to_string();
                out
            }
            Val::Obj {
                unit,
                ty,
                src,
                skip,
                bits: None,
            } => {
                let u = self.unit(unit)?;
                let mut out = if skip > 0 {
                    self.info
                        .render_array_tail(&self.dwarf, &u, ty, skip, src, self.read)
                } else {
                    self.info.render_value(&self.dwarf, &u, ty, src, self.read)
                };
                out.name = expr.to_string();
                out
            }
        })
    }

    /// Where `target` is in memory: its address and size in bytes.
    pub(crate) fn address(&mut self, target: &str) -> Result<(u32, u32), String> {
        let Val::Obj {
            unit,
            ty,
            src,
            skip,
            bits,
        } = self.parse_all(target)?
        else {
            return Err(format!("{target} is not a variable"));
        };
        let Src::Addr(addr) = src else {
            return Err(format!(
                "{target} is not in memory (it is in a register or computed)"
            ));
        };
        if let Some((first, width)) = bits {
            return Ok((addr, (first + width).div_ceil(8)));
        }
        let u = self.unit(unit)?;
        let (_, off) = self.resolve(unit, ty)?.ok_or("void value")?;
        let total = self.info.size_of(&u, Some(off)).ok_or("unknown size")?;
        // Indexed dimensions of a multi-dimensional array.
        let done: u32 = self.info.dims_of(&u, off).iter().take(skip).product();
        Ok((addr, total / done.max(1)))
    }

    /// What setting `target` to `value` writes.
    pub(crate) fn assign(&mut self, target: &str, value: &str) -> Result<Write, String> {
        let lhs = self.parse_all(target)?;
        let rhs = self.parse_all(value)?;
        let rhs = self.scalar(rhs)?;
        let Val::Obj {
            unit,
            ty,
            src,
            skip,
            bits,
        } = lhs
        else {
            return Err(format!("{target} is not a variable"));
        };
        let (tag, off) = self.resolve(unit, ty)?.ok_or("void value")?;
        if skip > 0
            || !matches!(
                tag,
                gimli::DW_TAG_base_type
                    | gimli::DW_TAG_enumeration_type
                    | gimli::DW_TAG_pointer_type
            )
        {
            return Err(
                "only numbers, enums and pointers can be set (pick an element or member)".into(),
            );
        }
        let u = self.unit(unit)?;
        let e = u.entry(off).map_err(|e| e.to_string())?;
        let enc = e.attr_value(gimli::DW_AT_encoding).ok().flatten();
        let float = matches!(enc, Some(AttributeValue::Encoding(gimli::DW_ATE_float)));
        let signed = matches!(
            enc,
            Some(AttributeValue::Encoding(
                gimli::DW_ATE_signed | gimli::DW_ATE_signed_char
            ))
        );
        let size = self.info.size_of(&u, Some(off)).unwrap_or(4) as usize;
        // An integer that fits in `width` bits of this type.
        let fits = |width: u32| -> Result<u64, String> {
            let n = match rhs {
                Val::Int(i) => i,
                Val::Float(f) if f == f.trunc() => f as i64,
                Val::Float(f) => return Err(format!("{f} is not a whole number")),
                Val::Obj { .. } => unreachable!(),
            };
            let ok = width >= 64
                || if signed {
                    // Signed: its range; also the bit pattern written as
                    // unsigned (0xFF for a signed char).
                    (-(1i64 << (width - 1))..(1i64 << width)).contains(&n)
                } else {
                    (0..(1i64 << width)).contains(&n) || (n < 0 && n >= -(1i64 << (width - 1)))
                };
            if ok {
                Ok(n as u64
                    & if width >= 64 {
                        u64::MAX
                    } else {
                        (1u64 << width) - 1
                    })
            } else {
                Err(format!("{n} does not fit in {width} bits"))
            }
        };
        if let Some((first, width)) = bits {
            let Src::Addr(addr) = src else {
                return Err("bit field not in memory".into());
            };
            let n = (first + width).div_ceil(8) as usize;
            let old = self.bytes(&src, n)?;
            let raw = old.iter().rev().fold(0u64, |a, &x| a << 8 | x as u64);
            let mask = ((1u64 << width) - 1) << first;
            let new = (raw & !mask) | (fits(width)? << first);
            return Ok(Write::Memory {
                addr,
                bytes: new.to_le_bytes()[..n].to_vec(),
            });
        }
        let raw = if float {
            let f = match rhs {
                Val::Int(i) => i as f64,
                Val::Float(f) => f,
                Val::Obj { .. } => unreachable!(),
            };
            if size == 4 {
                (f as f32).to_bits() as u64
            } else {
                f.to_bits()
            }
        } else {
            fits(8 * size.min(8) as u32)?
        };
        let bytes = raw.to_le_bytes()[..size.min(8)].to_vec();
        match src {
            Src::Addr(addr) => Ok(Write::Memory { addr, bytes }),
            Src::Reg(reg, _) if size <= 4 => {
                // Registers hold small integers extended to 32 bits.
                let value = if signed && !float {
                    let s = 64 - 8 * size as u32;
                    (((raw << s) as i64) >> s) as u32
                } else {
                    raw as u32
                };
                Ok(Write::Register { reg, value })
            }
            _ => Err(format!(
                "{target} has no storage here: the compiler keeps it as a constant or a computed value"
            )),
        }
    }

    /// Evaluate as a condition (non-zero = true).
    pub(crate) fn truth(&mut self, expr: &str) -> Result<bool, String> {
        let v = self.parse_all(expr)?;
        self.truthy(&v)
    }

    /// A value as a condition: true when non-zero.
    fn truthy(&mut self, v: &Val) -> Result<bool, String> {
        Ok(match self.scalar(v.clone())? {
            Val::Int(i) => i != 0,
            Val::Float(f) => f != 0.0,
            Val::Obj { .. } => unreachable!(),
        })
    }

    fn parse_all(&mut self, expr: &str) -> Result<Val, String> {
        self.toks = lex(expr)?;
        self.pos = 0;
        if self.toks.is_empty() {
            return Err("empty expression".into());
        }
        let v = self.binary(0)?;
        if self.pos != self.toks.len() {
            return Err(format!("unexpected {:?}", self.toks[self.pos]));
        }
        Ok(v)
    }

    fn peek_op(&self) -> Option<&'static str> {
        match self.toks.get(self.pos) {
            Some(Tok::Op(o)) => Some(o),
            _ => None,
        }
    }

    fn expect(&mut self, op: &str) -> Result<(), String> {
        if self.peek_op() == Some(op) {
            self.pos += 1;
            Ok(())
        } else {
            Err(format!("expected '{op}'"))
        }
    }

    /// Binary operators by precedence climbing.
    fn binary(&mut self, min: u8) -> Result<Val, String> {
        let mut lhs = self.unary()?;
        while let Some(op) = self.peek_op() {
            let prec = match op {
                "||" => 1,
                "&&" => 2,
                "|" => 3,
                "^" => 4,
                "&" => 5,
                "==" | "!=" => 6,
                "<" | "<=" | ">" | ">=" => 7,
                "<<" | ">>" => 8,
                "+" | "-" => 9,
                "*" | "/" | "%" => 10,
                _ => break,
            };
            if prec < min {
                break;
            }
            self.pos += 1;
            if self.skipping > 0 {
                self.binary(prec + 1)?;
                continue;
            }
            // `&&` and `||` short-circuit: once the left side decides, the
            // right side is only parsed (`p && p->x` with p null).
            let decided = match op {
                "&&" => (!self.truthy(&lhs).unwrap_or(true)).then_some(false),
                "||" => self.truthy(&lhs).unwrap_or(false).then_some(true),
                _ => None,
            };
            if let Some(b) = decided {
                self.skipping += 1;
                let rhs = self.binary(prec + 1);
                self.skipping -= 1;
                rhs?;
                lhs = Val::Int(b as i64);
            } else {
                let rhs = self.binary(prec + 1)?;
                lhs = self.apply(op, lhs, rhs)?;
            }
        }
        Ok(lhs)
    }

    fn apply(&mut self, op: &str, a: Val, b: Val) -> Result<Val, String> {
        let a = self.scalar(a)?;
        let b = self.scalar(b)?;
        if let (Val::Int(x), Val::Int(y)) = (&a, &b) {
            let (x, y) = (*x, *y);
            return Ok(Val::Int(match op {
                "+" => x.wrapping_add(y),
                "-" => x.wrapping_sub(y),
                "*" => x.wrapping_mul(y),
                "/" if y == 0 => return Err("division by zero".into()),
                "/" => x / y,
                "%" if y == 0 => return Err("division by zero".into()),
                "%" => x % y,
                "<<" => x.wrapping_shl(y as u32),
                ">>" => x.wrapping_shr(y as u32),
                "&" => x & y,
                "|" => x | y,
                "^" => x ^ y,
                "==" => (x == y) as i64,
                "!=" => (x != y) as i64,
                "<" => (x < y) as i64,
                "<=" => (x <= y) as i64,
                ">" => (x > y) as i64,
                ">=" => (x >= y) as i64,
                "&&" => (x != 0 && y != 0) as i64,
                "||" => (x != 0 || y != 0) as i64,
                _ => return Err(format!("operator {op}")),
            }));
        }
        let f = |v: &Val| match v {
            Val::Int(i) => *i as f64,
            Val::Float(f) => *f,
            _ => 0.0,
        };
        let (x, y) = (f(&a), f(&b));
        Ok(match op {
            "+" => Val::Float(x + y),
            "-" => Val::Float(x - y),
            "*" => Val::Float(x * y),
            "/" => Val::Float(x / y),
            "==" => Val::Int((x == y) as i64),
            "!=" => Val::Int((x != y) as i64),
            "<" => Val::Int((x < y) as i64),
            "<=" => Val::Int((x <= y) as i64),
            ">" => Val::Int((x > y) as i64),
            ">=" => Val::Int((x >= y) as i64),
            "&&" => Val::Int((x != 0.0 && y != 0.0) as i64),
            "||" => Val::Int((x != 0.0 || y != 0.0) as i64),
            _ => return Err(format!("operator {op} on floating point")),
        })
    }

    fn unary(&mut self) -> Result<Val, String> {
        match self.peek_op() {
            Some(op @ ("-" | "!" | "~" | "*" | "+")) => {
                self.pos += 1;
                let v = self.unary()?;
                if self.skipping > 0 {
                    return Ok(Val::Int(0));
                }
                if op == "*" {
                    return self.deref(v, 0);
                }
                Ok(match (op, self.scalar(v)?) {
                    ("-", Val::Int(i)) => Val::Int(i.wrapping_neg()),
                    ("-", Val::Float(f)) => Val::Float(-f),
                    ("!", Val::Int(i)) => Val::Int((i == 0) as i64),
                    ("!", Val::Float(f)) => Val::Int((f == 0.0) as i64),
                    ("~", Val::Int(i)) => Val::Int(!i),
                    (_, v) => v,
                })
            }
            _ => self.postfix(),
        }
    }

    fn postfix(&mut self) -> Result<Val, String> {
        let mut v = self.primary()?;
        loop {
            match self.peek_op() {
                Some(".") | Some("->") => {
                    let arrow = self.peek_op() == Some("->");
                    self.pos += 1;
                    let Some(Tok::Ident(name)) = self.toks.get(self.pos).cloned() else {
                        return Err("expected a member name".into());
                    };
                    self.pos += 1;
                    if self.skipping > 0 {
                        continue;
                    }
                    if arrow {
                        v = self.deref(v, 0)?;
                    }
                    v = self.member(v, &name)?;
                }
                Some("[") => {
                    self.pos += 1;
                    let idx = self.binary(0)?;
                    self.expect("]")?;
                    if self.skipping > 0 {
                        continue;
                    }
                    let i = match self.scalar(idx)? {
                        Val::Int(i) => i,
                        _ => return Err("index must be an integer".into()),
                    };
                    v = self.index(v, i)?;
                }
                _ => break,
            }
        }
        Ok(v)
    }

    fn primary(&mut self) -> Result<Val, String> {
        let t = self.toks.get(self.pos).cloned().ok_or("unexpected end")?;
        self.pos += 1;
        match t {
            Tok::Num(n) => Ok(Val::Int(n)),
            Tok::Float(f) => Ok(Val::Float(f)),
            Tok::Op("(") => {
                let v = self.binary(0)?;
                self.expect(")")?;
                Ok(v)
            }
            Tok::Ident(_) if self.skipping > 0 => Ok(Val::Int(0)),
            Tok::Ident(name) => self.lookup(&name),
            t => Err(format!("unexpected {t:?}")),
        }
    }

    /// A variable by name: a local of the frame, a global, or an
    /// enumerator constant.
    fn lookup(&mut self, name: &str) -> Result<Val, String> {
        if let Some((unit, ty, src)) =
            self.info
                .find_local(&self.dwarf, self.frame, name, self.read)
        {
            return Ok(Val::Obj {
                unit,
                ty,
                src: src.map_err(|e| format!("{name}: {e}"))?,
                skip: 0,
                bits: None,
            });
        }
        if let Some((unit, ty, addr)) = self.info.find_global(name) {
            return Ok(Val::Obj {
                unit,
                ty,
                src: Src::Addr(addr),
                skip: 0,
                bits: None,
            });
        }
        if let Some(v) = self.info.find_enumerator(&self.dwarf, name) {
            return Ok(Val::Int(v));
        }
        Err(format!("no variable named {name}"))
    }

    /// The type after stripping typedef/const/volatile: (tag, offset).
    fn resolve(
        &mut self,
        unit: UnitId,
        ty: Option<UnitOffset<usize>>,
    ) -> Result<Option<(gimli::DwTag, UnitOffset<usize>)>, String> {
        let u = self.unit(unit)?;
        let mut t = ty;
        for _ in 0..16 {
            let Some(off) = t else {
                return Ok(None);
            };
            let e = u.entry(off).map_err(|e| e.to_string())?;
            match e.tag() {
                gimli::DW_TAG_typedef | gimli::DW_TAG_const_type | gimli::DW_TAG_volatile_type => {
                    t = match e.attr_value(gimli::DW_AT_type).ok().flatten() {
                        Some(AttributeValue::UnitRef(o)) => Some(o),
                        _ => None,
                    };
                }
                tag => return Ok(Some((tag, off))),
            }
        }
        Err("type too deep".into())
    }

    fn target_of(
        &mut self,
        unit: UnitId,
        off: UnitOffset<usize>,
    ) -> Result<Option<UnitOffset<usize>>, String> {
        let u = self.unit(unit)?;
        let e = u.entry(off).map_err(|e| e.to_string())?;
        Ok(match e.attr_value(gimli::DW_AT_type).ok().flatten() {
            Some(AttributeValue::UnitRef(o)) => Some(o),
            _ => None,
        })
    }

    fn bytes(&self, src: &Src, len: usize) -> Result<Vec<u8>, String> {
        match src {
            Src::Addr(a) => (self.read)(*a, len).ok_or_else(|| format!("cannot read 0x{a:08x}")),
            Src::Bytes(b) => b
                .get(..len)
                .map(|s| s.to_vec())
                .ok_or_else(|| "value unavailable".to_string()),
            Src::Reg(_, v) => v
                .to_le_bytes()
                .get(..len)
                .map(|s| s.to_vec())
                .ok_or_else(|| "value larger than a register".to_string()),
        }
    }

    /// An object as a number (integers, enums, pointers, floats).
    fn scalar(&mut self, v: Val) -> Result<Val, String> {
        let Val::Obj {
            unit,
            ty,
            src,
            skip,
            bits,
        } = v
        else {
            return Ok(v);
        };
        let Some((tag, off)) = self.resolve(unit, ty)? else {
            return Err("void value".into());
        };
        if skip > 0 || tag == gimli::DW_TAG_array_type {
            // Arrays decay to their address.
            return match src {
                Src::Addr(a) => Ok(Val::Int(a as i64)),
                _ => Err("array without an address".into()),
            };
        }
        let u = self.unit(unit)?;
        let e = u.entry(off).map_err(|e| e.to_string())?;
        let enc = e.attr_value(gimli::DW_AT_encoding).ok().flatten();
        if let Some((first, width)) = bits {
            let b = self.bytes(&src, (first + width).div_ceil(8) as usize)?;
            let raw = b.iter().rev().fold(0u64, |a, &x| a << 8 | x as u64);
            let v = (raw >> first) & ((1u64 << width) - 1);
            let signed = matches!(
                enc,
                Some(AttributeValue::Encoding(
                    gimli::DW_ATE_signed | gimli::DW_ATE_signed_char
                ))
            );
            let s = 64 - width;
            return Ok(Val::Int(if signed {
                ((v << s) as i64) >> s
            } else {
                v as i64
            }));
        }
        let size = self.info.size_of(&u, Some(off)).unwrap_or(4) as usize;
        let b = self.bytes(&src, size)?;
        let raw = b.iter().rev().fold(0u64, |a, &x| a << 8 | x as u64);
        let shift = 64 - 8 * size.min(8) as u32;
        Ok(match (tag, enc) {
            (gimli::DW_TAG_base_type, Some(AttributeValue::Encoding(gimli::DW_ATE_float))) => {
                Val::Float(if size == 4 {
                    f32::from_bits(raw as u32) as f64
                } else {
                    f64::from_bits(raw)
                })
            }
            (gimli::DW_TAG_base_type, Some(AttributeValue::Encoding(gimli::DW_ATE_signed)))
            | (
                gimli::DW_TAG_base_type,
                Some(AttributeValue::Encoding(gimli::DW_ATE_signed_char)),
            ) => Val::Int(((raw << shift) as i64) >> shift),
            (
                gimli::DW_TAG_base_type
                | gimli::DW_TAG_enumeration_type
                | gimli::DW_TAG_pointer_type,
                _,
            ) => Val::Int(raw as i64),
            _ => return Err("not a number (a struct?)".into()),
        })
    }

    fn deref(&mut self, v: Val, index: i64) -> Result<Val, String> {
        let Val::Obj { unit, ty, .. } = &v else {
            return Err("cannot dereference a number".into());
        };
        let unit = *unit;
        let (tag, off) = self.resolve(unit, *ty)?.ok_or("void value")?;
        if tag == gimli::DW_TAG_array_type {
            return self.index(v, index);
        }
        if tag != gimli::DW_TAG_pointer_type {
            return Err("not a pointer".into());
        }
        let target = self.target_of(unit, off)?;
        let Val::Int(p) = self.scalar(v)? else {
            unreachable!()
        };
        let u = self.unit(unit)?;
        let size = self.info.size_of(&u, target).unwrap_or(1) as i64;
        Ok(Val::Obj {
            unit,
            ty: target,
            src: Src::Addr((p + index * size) as u32),
            skip: 0,
            bits: None,
        })
    }

    fn index(&mut self, v: Val, i: i64) -> Result<Val, String> {
        let Val::Obj {
            unit,
            ty,
            src,
            skip,
            ..
        } = v.clone()
        else {
            return Err("cannot index a number".into());
        };
        let (tag, off) = self.resolve(unit, ty)?.ok_or("void value")?;
        if tag == gimli::DW_TAG_pointer_type {
            return self.deref(v, i);
        }
        if tag != gimli::DW_TAG_array_type {
            return Err("not an array".into());
        }
        let u = self.unit(unit)?;
        let dims = self.info.dims_of(&u, off);
        let rest = &dims[(skip + 1).min(dims.len())..];
        if i < 0 || dims.get(skip).is_some_and(|&n| i as u32 >= n && n > 0) {
            return Err(format!("index {i} out of range"));
        }
        let elem = self.target_of(unit, off)?;
        let esize = self.info.size_of(&u, elem).unwrap_or(1) * rest.iter().product::<u32>();
        let addr = match src {
            Src::Addr(a) => a + i as u32 * esize,
            _ => return Err("array without an address".into()),
        };
        Ok(if rest.is_empty() {
            Val::Obj {
                unit,
                ty: elem,
                src: Src::Addr(addr),
                skip: 0,
                bits: None,
            }
        } else {
            // The array type itself (past typedefs and qualifiers).
            Val::Obj {
                unit,
                ty: Some(off),
                src: Src::Addr(addr),
                skip: skip + 1,
                bits: None,
            }
        })
    }

    fn member(&mut self, v: Val, name: &str) -> Result<Val, String> {
        let Val::Obj { unit, ty, src, .. } = v else {
            return Err(format!("no member {name} in a number"));
        };
        let (tag, off) = self.resolve(unit, ty)?.ok_or("void value")?;
        if !matches!(tag, gimli::DW_TAG_structure_type | gimli::DW_TAG_union_type) {
            return Err(format!("not a struct (member {name})"));
        }
        let u = self.unit(unit)?;
        let (moff, mty, bitfield) = self
            .info
            .member_of(&self.dwarf, &u, off, name)
            .ok_or_else(|| format!("no member named {name}"))?;
        // A bit field is addressed from its first whole byte.
        let (moff, bits) = match bitfield {
            Some((start, width)) => (start / 8, Some((start % 8, width))),
            None => (moff, None),
        };
        let src = match src {
            Src::Addr(a) => Src::Addr(a + moff),
            Src::Bytes(b) => Src::Bytes(b.get(moff as usize..).unwrap_or(&[]).to_vec()),
            Src::Reg(_, v) => {
                Src::Bytes(v.to_le_bytes().get(moff as usize..).unwrap_or(&[]).to_vec())
            }
        };
        Ok(Val::Obj {
            unit,
            ty: mty,
            src,
            skip: 0,
            bits,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{lex, Tok};

    #[test]
    fn numbers() {
        let n = |s: &str| lex(s).unwrap();
        assert_eq!(n("0x7F"), [Tok::Num(0x7f)]);
        assert_eq!(n("0xFFu"), [Tok::Num(0xff)]);
        assert_eq!(n("0XaBcDeFUL"), [Tok::Num(0xabcdef)]);
        assert_eq!(n("10u"), [Tok::Num(10)]);
        assert_eq!(n("1.5f"), [Tok::Float(1.5)]);
        assert_eq!(n("2e3F"), [Tok::Float(2000.0)]);
        assert_eq!(n("'A'"), [Tok::Num(65)]);
        assert!(lex("12abc").is_err());
    }

    #[test]
    fn operators() {
        assert_eq!(
            lex("p->x[1]>=2&&!q").unwrap(),
            [
                Tok::Ident("p".into()),
                Tok::Op("->"),
                Tok::Ident("x".into()),
                Tok::Op("["),
                Tok::Num(1),
                Tok::Op("]"),
                Tok::Op(">="),
                Tok::Num(2),
                Tok::Op("&&"),
                Tok::Op("!"),
                Tok::Ident("q".into()),
            ]
        );
    }
}
