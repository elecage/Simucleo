// Configurations of the M36 tests: one per peripheral (plus the board
// defaults), for the code generation snapshots (m36.test.ts) and the builds
// with gcc and the in-browser toolchain (m36-toolchain.test.ts).
import { assignPin, nucleoDefaults, type CubeConfig } from "../src/cube/config.ts";

/** Configurations for the snapshots, one per peripheral (plus the board defaults). */
export function snapshotConfigs(): Record<string, CubeConfig> {
  const out: Record<string, CubeConfig> = {};
  out.nucleo = nucleoDefaults("nucleo");
  let c = nucleoDefaults("uart");
  c = assignPin(c, "PA9", "USART1_TX");
  c = assignPin(c, "PA10", "USART1_RX");
  c.usart.USART1 = { baud: 9600, wordLength: 9, parity: "even", stopBits: 2, direction: "tx_rx" };
  c = assignPin(c, "PC6", "USART6_TX");
  c = assignPin(c, "PC7", "USART6_RX");
  c.usart.USART6!.direction = "tx";
  c.nvic.USART1 = { enabled: true, preempt: 2, sub: 0 };
  c.nvic.USART2 = { enabled: true, preempt: 0, sub: 0 };
  out.uart = c;
  c = nucleoDefaults("i2c");
  c = assignPin(c, "PB8", "I2C1_SCL");
  c = assignPin(c, "PB9", "I2C1_SDA");
  c.i2c.I2C1 = { speed: 400000, duty: "16_9", ownAddress: 0 };
  c = assignPin(c, "PA8", "I2C3_SCL");
  c = assignPin(c, "PC9", "I2C3_SDA");
  c.nvic.I2C1_EV = { enabled: true, preempt: 1, sub: 0 };
  c.nvic.I2C1_ER = { enabled: true, preempt: 1, sub: 0 };
  out.i2c = c;
  c = nucleoDefaults("spi");
  c = assignPin(c, "PA5", "SPI1_SCK");
  c = assignPin(c, "PA6", "SPI1_MISO");
  c = assignPin(c, "PA7", "SPI1_MOSI");
  c.spi.SPI1 = { mode: "master", direction: "2lines", dataSize: 8, prescaler: 32, cpol: 1, cpha: 1, firstBit: "msb" };
  c = assignPin(c, "PB13", "SPI2_SCK");
  c = assignPin(c, "PB15", "SPI2_MOSI");
  c.spi.SPI2!.direction = "tx_only";
  c.spi.SPI2!.dataSize = 16;
  c = assignPin(c, "PB6", "GPIO_Output", "CS");
  c.pins.PB6.high = true;
  c.nvic.SPI1 = { enabled: true, preempt: 0, sub: 0 };
  out.spi = c;
  c = nucleoDefaults("tim");
  c = assignPin(c, "PA5", "TIM2_CH1", "LD2");
  c = assignPin(c, "PB3", "TIM2_CH2");
  c.tim.TIM2 = { ...c.tim.TIM2!, prescaler: 83, period: 999 };
  c.tim.TIM2.channels[0]!.pulse = 250;
  c.tim.TIM2.channels[1] = { mode: "pwm", pulse: 750, pwmMode: 2, polarity: "low" };
  c = assignPin(c, "PA8", "TIM1_CH1");
  c.tim.TIM1!.prescaler = 167;
  c.tim.TIM1!.period = 19999;
  c.tim.TIM1!.channels[0]!.pulse = 1500;
  c = assignPin(c, "PB8", "TIM10_CH1");
  c.tim.TIM10!.period = 4199;
  c.tim.TIM5 = { prescaler: 8399, period: 9999, counterMode: "up", autoReloadPreload: true, channels: [null, null, null, null] };
  c.tim.TIM3 = { prescaler: 0, period: 65535, counterMode: "center1", autoReloadPreload: false, channels: [null, null, null, null] };
  c.nvic.TIM5 = { enabled: true, preempt: 3, sub: 0 };
  c.nvic.TIM1_UP_TIM10 = { enabled: true, preempt: 2, sub: 0 };
  out.tim = c;
  c = nucleoDefaults("adc");
  c = assignPin(c, "PA0", "ADC1_IN0");
  c = assignPin(c, "PA1", "ADC1_IN1", "POT");
  c = assignPin(c, "PC0", "ADC1_IN10");
  c.adc.ADC1 = { resolution: 10, scan: true, continuous: true, ranks: [{ channel: 10, sampling: 480 }, { channel: 0, sampling: 84 }, { channel: 1, sampling: 84 }], eocEachConversion: false };
  c.nvic.ADC = { enabled: true, preempt: 0, sub: 0 };
  out.adc = c;
  c = nucleoDefaults("gpio");
  c = assignPin(c, "PB0", "GPIO_Output", "RELAY");
  c.pins.PB0.openDrain = true;
  c.pins.PB0.high = true;
  c = assignPin(c, "PB1", "GPIO_Output");
  c = assignPin(c, "PB2", "GPIO_Output");
  c.pins.PB2.speed = "high";
  c = assignPin(c, "PB5", "GPIO_Input", "KEY");
  c.pins.PB5.pull = "up";
  c = assignPin(c, "PA10", "GPXTI10", "D2_BTN");
  c.pins.PA10.edge = "both";
  c.pins.PA10.pull = "down";
  c = assignPin(c, "PB4", "GPXTI4");
  c = assignPin(c, "PC1", "GPIO_Analog");
  c.nvic.EXTI4 = { enabled: true, preempt: 4, sub: 0 };
  out.gpio = c;
  c = nucleoDefaults("clock");
  c.clock = { ...c.clock, pllSource: "HSE", pllM: 8, pllN: 336, pllP: 4, pllQ: 7, ahbDiv: 2, apb1Div: 1, apb2Div: 1, latency: 3 };
  out.clock = c;
  return out;
}

