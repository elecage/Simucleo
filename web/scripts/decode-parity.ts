// Writes crates/wasm/tests/fixtures/decode-parity.json: synthetic streams
// and what the TypeScript decoders make of them, for the Rust decoders to
// match (M26; see test/parity.ts). Run after changing a decoder:
//   node scripts/decode-parity.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parityJson } from "../test/parity.ts";

const out = fileURLToPath(new URL("../../crates/wasm/tests/fixtures/decode-parity.json", import.meta.url));
writeFileSync(out, parityJson());
console.log(`wrote ${out}`);
