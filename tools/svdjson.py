#!/usr/bin/env python3
"""Generate the SFR view's register description from ST's CMSIS-SVD file.

    python3 tools/svdjson.py crates/periph-stm32f4/svd/STM32F401.svd \
        > web/public/sfr/STM32F401.json

Unlike tools/svdgen.py (the compact table compiled into the simulator),
this keeps the descriptions: the web page loads the file only when the
SFR tab opens. Peripherals derived from another (`derivedFrom`) share its
register set. Short keys keep the file small:

    { "device": "STM32F401",
      "p": [ { "n": name, "b": base, "g": group, "d": description,
               "i": [[interrupt, irq], ...], "r": index into "s" } ],
      "s": [ [ { "n": name, "o": offset, "z": size in bits (omitted: 32),
                 "a": "rw" | "r" | "w", "r": reset, "d": description,
                 "f": [ { "n": name, "l": lsb, "w": width,
                          "a": access (omitted: the register's),
                          "m": "w0c" | "w1c" (omitted: plain),
                          "d": description,
                          "e": [[value, name, description], ...] } ] } ] ] }

ST's SVD has neither `modifiedWriteValues` nor enumerated values, so two
hand-made tables below add them (from RM0368):

* `WRITE_EFFECTS`: fields written to clear or act — "w0c" (rc_w0: 0
  clears, 1 changes nothing: TIMx_SR, USART_SR …) and "w1c" (rc_w1 or a
  write-1 action bit: EXTI_PR, FLASH_SR, RCC_CIR's …C bits …). The view's
  read-modify-write of one field leaves these alone (see web/src/run/sfr.ts).
* `ENUMS`: names of field values a student meets first (GPIO mode, output
  type, speed and pull; timer direction; USART word length …).

Every rule must match at least one field, or the script fails.
"""

import json
import re
import sys
import xml.etree.ElementTree as ET

# (peripheral, register, field) regexes, full match → write effect.
WRITE_EFFECTS = [
    (r"TIM\d+", r"SR", r".*", "w0c"),
    (r"USART\d", r"SR", r"CTS|LBD|TC|RXNE", "w0c"),
    (r"I2C\d", r"SR1", r"SMBALERT|TIMEOUT|PECERR|OVR|AF|ARLO|BERR", "w0c"),
    (r"SPI\d|I2S\dext", r"SR", r"CRCERR", "w0c"),
    (r"ADC1", r"SR", r".*", "w0c"),
    (r"RTC", r"ISR", r"RSF|ALRAF|ALRBF|WUTF|TSF|TSOVF|TAMP1F|TAMP2F", "w0c"),
    (r"WWDG", r"SR", r"EWIF", "w0c"),
    (r"EXTI", r"PR", r".*", "w1c"),
    (r"FLASH", r"SR", r"EOP|OPERR|WRPERR|PGAERR|PGPERR|PGSERR", "w1c"),
    (r"RCC", r"CIR", r".*RDYC|CSSC", "w1c"),
    (r"RCC", r"CSR", r"RMVF", "w1c"),
    (r"PWR", r"CR", r"CWUF|CSBF", "w1c"),
    (r"SDIO", r"ICR", r".*", "w1c"),
    (r"DMA\d", r"[LH]IFCR", r".*", "w1c"),
    (
        r"OTG_FS_GLOBAL",
        r"FS_GINTSTS",
        r"MMIS|SOF|ESUSP|USBSUSP|USBRST|ENUMDNE|ISOODRP|EOPF|IISOIXFR|IPXFR_INCOMPISOOUT|CIDSCHG|DISCINT|SRQINT|WKUPINT",
        "w1c",
    ),
    (r"OTG_FS_GLOBAL", r"FS_GOTGINT", r".*", "w1c"),
    (r"OTG_FS_DEVICE", r"D[IO]EPINT\d", r".*", "w1c"),
    (r"OTG_FS_HOST", r"FS_HCINT\d", r".*", "w1c"),
    (r"OTG_FS_HOST", r"FS_HPRT", r"PCDET|PENA|PENCHNG|POCCHNG", "w1c"),
]

# (peripheral, register, field) regexes → [(value, name, description)].
ENUMS = [
    (r"GPIO\w", r"MODER", r"MODER\d+", [(0, "Input", "Input mode (reset state)"), (1, "Output", "General purpose output mode"), (2, "Alternate", "Alternate function mode"), (3, "Analog", "Analog mode")]),
    (r"GPIO\w", r"OTYPER", r"OT\d+", [(0, "PushPull", "Output push-pull (reset state)"), (1, "OpenDrain", "Output open-drain")]),
    (r"GPIO\w", r"OSPEEDR", r"OSPEEDR\d+", [(0, "Low", "Low speed"), (1, "Medium", "Medium speed"), (2, "High", "High speed"), (3, "VeryHigh", "Very high speed")]),
    (r"GPIO\w", r"PUPDR", r"PUPDR\d+", [(0, "None", "No pull-up, pull-down"), (1, "PullUp", "Pull-up"), (2, "PullDown", "Pull-down"), (3, "Reserved", "Reserved")]),
    (r"TIM\d+", r"CR1", r"DIR", [(0, "Up", "Counter used as upcounter"), (1, "Down", "Counter used as downcounter")]),
    (r"TIM\d+", r"CR1", r"CMS", [(0, "Edge", "Edge-aligned mode"), (1, "Center1", "Center-aligned mode 1"), (2, "Center2", "Center-aligned mode 2"), (3, "Center3", "Center-aligned mode 3")]),
    (r"USART\d", r"CR1", r"M", [(0, "Bits8", "1 start bit, 8 data bits, n stop bits"), (1, "Bits9", "1 start bit, 9 data bits, n stop bits")]),
    (r"USART\d", r"CR2", r"STOP", [(0, "Stop1", "1 stop bit"), (1, "Stop0_5", "0.5 stop bit"), (2, "Stop2", "2 stop bits"), (3, "Stop1_5", "1.5 stop bits")]),
    (r"ADC1", r"CR1", r"RES", [(0, "Bits12", "12-bit (15 ADCCLK cycles)"), (1, "Bits10", "10-bit (13 ADCCLK cycles)"), (2, "Bits8", "8-bit (11 ADCCLK cycles)"), (3, "Bits6", "6-bit (9 ADCCLK cycles)")]),
]

ACCESS = {"read-write": "rw", "read-only": "r", "write-only": "w", "writeOnce": "w", "read-writeOnce": "rw"}


def num(text, default=None):
    if text is None:
        return default
    t = text.strip().lower()
    if t.startswith("0x"):
        return int(t, 16)
    if t.startswith("#"):
        return int(t[1:].replace("x", "0"), 2)
    return int(t, 10)


def text(el, tag):
    """An element's text with the SVD's line breaks and indentation folded."""
    t = el.findtext(tag)
    return " ".join(t.split()) if t else ""


def rule_match(rules, used, p, r, f):
    for i, rule in enumerate(rules):
        if re.fullmatch(rule[0], p) and re.fullmatch(rule[1], r) and re.fullmatch(rule[2], f):
            used.add(i)
            return rule[3]
    return None


def main(path):
    root = ET.parse(path).getroot()
    dev_reset = num(root.findtext("resetValue"), 0)
    dev_access = root.findtext("access", "read-write")
    dev_size = num(root.findtext("size"), 32)

    raw = {p.findtext("name"): p for p in root.find("peripherals").findall("peripheral")}

    def source(p):
        while p.find("registers") is None and p.get("derivedFrom"):
            p = raw[p.get("derivedFrom")]
        return p

    def inherited(p, tag):
        """A peripheral's own `tag`, else the one it derives from."""
        while True:
            v = text(p, tag)
            if v or not p.get("derivedFrom"):
                return v
            p = raw[p.get("derivedFrom")]

    used_effects, used_enums = set(), set()
    sets, set_index, periphs = [], {}, []
    for name, p in raw.items():
        src = source(p)
        src_name = src.findtext("name")
        if src_name not in set_index:
            p_reset = num(src.findtext("resetValue"), dev_reset)
            p_access = src.findtext("access", dev_access)
            p_size = num(src.findtext("size"), dev_size)
            regs = []
            for r in src.find("registers").findall("register"):
                rname = r.findtext("name")
                racc = ACCESS[r.findtext("access", p_access)]
                fields = []
                fs = r.find("fields")
                for f in fs.findall("field") if fs is not None else []:
                    if f.find("bitOffset") is not None:
                        lsb, width = num(f.findtext("bitOffset")), num(f.findtext("bitWidth"))
                    else:
                        msb, lsb = (int(x) for x in f.findtext("bitRange").strip("[]").split(":"))
                        width = msb - lsb + 1
                    fname = f.findtext("name")
                    fd = {"n": fname, "l": lsb, "w": width}
                    facc = ACCESS[f.findtext("access")] if f.find("access") is not None else racc
                    if facc != racc:
                        fd["a"] = facc
                    m = rule_match(WRITE_EFFECTS, used_effects, src_name, rname, fname)
                    if m:
                        fd["m"] = m
                    d = text(f, "description")
                    if d and d != fname:
                        fd["d"] = d
                    e = rule_match(ENUMS, used_enums, src_name, rname, fname)
                    if e:
                        assert all(v < 1 << width for v, _, _ in e), (src_name, rname, fname)
                        fd["e"] = [list(x) for x in e]
                    fields.append(fd)
                fields.sort(key=lambda x: x["l"])
                rd = {"n": rname, "o": num(r.findtext("addressOffset")), "a": racc, "r": num(r.findtext("resetValue"), p_reset)}
                size = num(r.findtext("size"), p_size)
                if size != 32:
                    rd["z"] = size
                d = text(r, "description")
                if d:
                    rd["d"] = d
                rd["f"] = fields
                regs.append(rd)
            regs.sort(key=lambda x: x["o"])
            set_index[src_name] = len(sets)
            sets.append(regs)
        irqs = sorted({(i.findtext("name"), num(i.findtext("value"))) for i in p.findall("interrupt")}, key=lambda x: x[1])
        pd = {"n": name, "b": num(p.findtext("baseAddress")), "g": inherited(p, "groupName"), "d": inherited(p, "description")}
        if irqs:
            pd["i"] = [list(x) for x in irqs]
        pd["r"] = set_index[src_name]
        periphs.append(pd)

    for rules, used, what in ((WRITE_EFFECTS, used_effects, "WRITE_EFFECTS"), (ENUMS, used_enums, "ENUMS")):
        unused = [rules[i][:3] for i in range(len(rules)) if i not in used]
        if unused:
            sys.exit(f"{what}: rules that match no field: {unused}")

    periphs.sort(key=lambda x: x["b"])
    out = {
        "device": root.findtext("name"),
        "source": "svd/STM32F401.svd, Copyright STMicroelectronics, Apache-2.0; generated by tools/svdjson.py",
        "p": periphs,
        "s": sets,
    }
    sys.stdout.write(json.dumps(out, separators=(",", ":"), ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
