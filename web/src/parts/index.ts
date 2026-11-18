import { breadboardHalf } from "./breadboard";
import { buzzerActive, buzzerPassive, led5mm, resistor, rgbLed, tactSwitch } from "./basic";
import { nucleoF401re, nucleoSignal } from "./nucleo";
import { dcMotor, ldr, potentiometer, servo, tempSensor } from "./analog";
import { aht20, oledI2c, oledSpi, rtc, sdCard } from "./bus";
import { dht, neopixelMatrix, neopixelRing, neopixelStrip } from "./timing";
import { ds18b20, keypad, lcdI2c, rotaryEncoder, sevenSegment, sevenSegment4, stepper, thermistor, ultrasonic } from "./more";
import type { PartDef } from "./types";

export const PARTS: PartDef[] = [nucleoF401re, breadboardHalf, led5mm, rgbLed, resistor, tactSwitch, buzzerActive, buzzerPassive,
  potentiometer, ldr, tempSensor, servo, dcMotor, oledI2c, oledSpi, rtc, aht20, sdCard, neopixelStrip, neopixelRing, neopixelMatrix, dht,
  sevenSegment, sevenSegment4, lcdI2c, keypad, rotaryEncoder, thermistor, ultrasonic, ds18b20, stepper];

export const PART_BY_KIND: Record<string, PartDef> = Object.fromEntries(PARTS.map((p) => [p.kind, p]));

/** Internal buses of every part kind, in the shape the Rust core expects. */
export function busCatalog(): Record<string, string[][]> {
  return Object.fromEntries(PARTS.filter((p) => p.buses).map((p) => [p.kind, p.buses!]));
}

/** Board pin id → MCU/board signal (`D13` → `PA5`), for the simulator. */
export function boardSignals(): Record<string, string> {
  // NC pins stay separate (each keeps its own id).
  return Object.fromEntries(
    nucleoF401re.pins.map((p) => [p.id, nucleoSignal(p.id)!] as const).filter(([, s]) => s !== "NC"),
  );
}
