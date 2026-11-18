//! Types of the generated register table (`svd.rs`).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    ReadWrite,
    ReadOnly,
    WriteOnly,
}

#[derive(Debug)]
pub struct Field {
    pub name: &'static str,
    pub lsb: u8,
    pub width: u8,
}

#[derive(Debug)]
pub struct Register {
    pub name: &'static str,
    pub offset: u16,
    pub reset: u32,
    pub access: Access,
    pub fields: &'static [Field],
}

#[derive(Debug)]
pub struct Peripheral {
    pub name: &'static str,
    pub base: u32,
    pub registers: &'static [Register],
    /// (name, IRQ number)
    pub interrupts: &'static [(&'static str, u16)],
}
