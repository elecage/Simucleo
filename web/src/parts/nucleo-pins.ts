// The Nucleo-64 (MB1136) headers, from UM1724: which MCU pin is on which
// Morpho (CN7, CN10) and Arduino (CN5/CN6/CN8/CN9) pin. Pure data, shared by
// the board part (nucleo.tsx) and the configuration tool (M36), which shows
// the header names next to the MCU pins.

// CN7: [odd, even] for pins 1/2 … 37/38.
export const CN7: [string, string][] = [
  ["PC10", "PC11"], ["PC12", "PD2"], ["VDD", "E5V"], ["BOOT0", "GND"], ["NC", "NC"],
  ["NC", "IOREF"], ["PA13", "RESET"], ["PA14", "3V3"], ["PA15", "5V"], ["GND", "GND"],
  ["PB7", "GND"], ["PC13", "VIN"], ["PC14", "NC"], ["PC15", "PA0"], ["PH0", "PA1"],
  ["PH1", "PA4"], ["VBAT", "PB0"], ["PC2", "PC1"], ["PC3", "PC0"],
];

// CN10: [odd, even]. CN10-18 is PB11 on other Nucleo-64 boards, but the
// STM32F401RE LQFP64 has VCAP1 there, so it is not connected.
export const CN10: [string, string][] = [
  ["PC9", "PC8"], ["PB8", "PC6"], ["PB9", "PC5"], ["AVDD", "U5V"], ["GND", "NC"],
  ["PA5", "PA12"], ["PA6", "PA11"], ["PA7", "PB12"], ["PB6", "NC"], ["PC7", "GND"],
  ["PA9", "PB2"], ["PA8", "PB1"], ["PB10", "PB15"], ["PB4", "PB14"], ["PB5", "PB13"],
  ["PB3", "AGND"], ["PA10", "PC4"], ["PA2", "NC"], ["PA3", "NC"],
];

// Arduino Uno R3 headers: [id, signal, extra label]. Position = column (1–19)
// shared with the Morpho header next to it.
export const ARDUINO_TOP: [string, string, string, number][] = [
  ["D15", "PB8", "SCL", 2], ["D14", "PB9", "SDA", 3], ["AREF", "AVDD", "", 4], ["GND_D", "GND", "", 5],
  ["D13", "PA5", "SCK", 6], ["D12", "PA6", "MISO", 7], ["D11", "PA7", "MOSI / PWM", 8],
  ["D10", "PB6", "CS / PWM", 9], ["D9", "PC7", "PWM", 10], ["D8", "PA9", "", 11],
  ["D7", "PA8", "", 12], ["D6", "PB10", "PWM", 13], ["D5", "PB4", "PWM", 14], ["D4", "PB5", "", 15],
  ["D3", "PB3", "PWM", 16], ["D2", "PA10", "", 17], ["D1", "PA2", "TX", 18], ["D0", "PA3", "RX", 19],
];
export const ARDUINO_BOTTOM: [string, string, string, number][] = [
  ["NC_A", "NC", "", 5], ["IOREF", "IOREF", "", 6], ["RESET", "RESET", "", 7], ["3V3", "3V3", "", 8],
  ["5V", "5V", "", 9], ["GND_P1", "GND", "", 10], ["GND_P2", "GND", "", 11], ["VIN", "VIN", "", 12],
  ["A0", "PA0", "", 14], ["A1", "PA1", "", 15], ["A2", "PA4", "", 16],
  ["A3", "PB0", "", 17], ["A4", "PC1", "", 18], ["A5", "PC0", "", 19],
];

/** Where an MCU pin (`PA5`) is on the board: `["D13", "CN10-11"]`. */
export function nucleoHeaders(mcuPin: string): string[] {
  const out: string[] = [];
  for (const [id, signal] of [...ARDUINO_TOP, ...ARDUINO_BOTTOM]) if (signal === mcuPin) out.push(id.replace(/_.*/, ""));
  for (const [name, rows] of [["CN7", CN7], ["CN10", CN10]] as const) {
    rows.forEach(([o, e], i) => {
      if (o === mcuPin) out.push(`${name}-${2 * i + 1}`);
      if (e === mcuPin) out.push(`${name}-${2 * i + 2}`);
    });
  }
  return out;
}
