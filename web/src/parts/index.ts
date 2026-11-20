import { breadboardHalf } from "./breadboard";
import { buzzerActive, buzzerPassive, led5mm, resistor, rgbLed, tactSwitch } from "./basic";
import { nucleoF401re, nucleoSignal } from "./nucleo";
import { dcMotor, ldr, potentiometer, servo, tempSensor } from "./analog";
import { aht20, oledI2c, oledSpi, rtc, sdCard } from "./bus";
import { dht, neopixelMatrix, neopixelRing, neopixelStrip } from "./timing";
import { ds18b20, keypad, lcdI2c, rotaryEncoder, sevenSegment, sevenSegment4, stepper, thermistor, ultrasonic } from "./more";
import { irReceiver, max7219, mpu6050 } from "./tier6";
import { hc05, relay } from "./tier7";
import { bmp280, hc595, joystick, pir, tm1637 } from "./tier8";
import { rfidRc522 } from "./rfid";
import { canMcp2515 } from "./can";
import { a4988, battery, bldcHall, bldcSensorless, bridge3ph, escBldc, l298n, stepperNema17 } from "./tier9";
import { tftIli9341, tftSt7735 } from "./tft";
import { max31855, max6675 } from "./thermocouple";
import type { PartDef } from "./types";

export const PARTS: PartDef[] = [nucleoF401re, breadboardHalf, led5mm, rgbLed, resistor, tactSwitch, buzzerActive, buzzerPassive,
  potentiometer, ldr, tempSensor, servo, dcMotor, oledI2c, oledSpi, rtc, aht20, sdCard, neopixelStrip, neopixelRing, neopixelMatrix, dht,
  sevenSegment, sevenSegment4, lcdI2c, keypad, rotaryEncoder, thermistor, ultrasonic, ds18b20, stepper,
  mpu6050, max7219, irReceiver, hc05, relay, hc595, tm1637, joystick, pir, bmp280,
  battery, stepperNema17, a4988, l298n, escBldc, bldcHall, bldcSensorless, bridge3ph, rfidRc522,
  tftSt7735, tftIli9341, max6675, max31855, canMcp2515];

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
