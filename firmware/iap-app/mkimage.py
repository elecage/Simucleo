#!/usr/bin/env python3
"""Turn an application binary (objcopy -O binary of an iap-app ELF, linked
for slot A) into the image the bootloader accepts: pad it to a multiple of
4 bytes with 0xFF, fill in the header at offset 0x200 (see
firmware/hal-bootloader/bootmeta.h) with the image size and its CRC-32
(zlib's), computed over the whole padded image with the CRC field as 0.

    mkimage.py app.raw app.bin [header.bin]

The optional third file receives the 16 finished header bytes, for
`objcopy --update-section .image_header=header.bin` so the ELF matches.
"""
import struct
import sys
import zlib

HEADER_OFFSET = 0x200
MAGIC = 0x21474D49  # "IMG!"
SLOT_SIZE = 128 * 1024


def make_image(raw: bytes) -> bytes:
    img = bytearray(raw)
    img += b"\xff" * (-len(img) % 4)
    if len(img) < HEADER_OFFSET + 16:
        sys.exit("mkimage: image too small for a header at 0x200")
    if len(img) > SLOT_SIZE:
        sys.exit(f"mkimage: {len(img)} bytes do not fit the 128 KB slot")
    magic, version, _, _ = struct.unpack_from("<4I", img, HEADER_OFFSET)
    if magic != MAGIC:
        sys.exit(f"mkimage: no image header at 0x200 (magic 0x{magic:08X})")
    struct.pack_into("<4I", img, HEADER_OFFSET, magic, version, len(img), 0)
    crc = zlib.crc32(img) & 0xFFFFFFFF
    struct.pack_into("<I", img, HEADER_OFFSET + 12, crc)
    return bytes(img)


def main() -> None:
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    with open(sys.argv[1], "rb") as f:
        img = make_image(f.read())
    with open(sys.argv[2], "wb") as f:
        f.write(img)
    if len(sys.argv) == 4:
        with open(sys.argv[3], "wb") as f:
            f.write(img[HEADER_OFFSET:HEADER_OFFSET + 16])
    _, version, size, crc = struct.unpack_from("<4I", img, HEADER_OFFSET)
    print(f"{sys.argv[2]}: version {version}, {size} bytes, CRC32 0x{crc:08X}")


if __name__ == "__main__":
    main()
