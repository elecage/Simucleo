// M35: what the simulator says about a CAN module (`Mcp2515::display`).

/** "normal 125 kbit/s error-active TEC 0 REC 0 TX 3 RX 2" → its parts. */
export function parseCanStatus(text: string | undefined) {
  const m = /^(\S+) (.+?) (error-active|error-passive|bus-off) TEC (\d+) REC (\d+) TX (\d+) RX (\d+)$/.exec(text ?? "");
  if (!m) return null;
  return { mode: m[1], rate: m[2], state: m[3], tec: Number(m[4]), rec: Number(m[5]), tx: Number(m[6]), rx: Number(m[7]) };
}
