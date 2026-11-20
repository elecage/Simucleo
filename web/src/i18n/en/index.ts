// Every English dictionary (M34), merged. A key may appear in more than one
// group only with the same English (test/i18n.test.ts checks).
import { APP } from "./app.ts";
import { CODE } from "./code.ts";
import { CUBE } from "./cube.ts";
import { DATA } from "./data.ts";
import { LESSONS } from "./lessons.ts";
import { PARTS } from "./parts.ts";
import { RFID } from "./rfid.ts";
import { RUN } from "./run.ts";
import { TFT } from "./tft.ts";
import { THERMOCOUPLE } from "./thermocouple.ts";

export const GROUPS: Record<string, Record<string, string>> = { APP, CODE, CUBE, DATA, LESSONS, PARTS, RFID, RUN, TFT, THERMOCOUPLE };
export const EN: Record<string, string> = Object.assign({}, ...Object.values(GROUPS));
