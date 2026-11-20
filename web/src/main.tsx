import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startPwa } from "./PwaUi";
import "./styles.css";
import "./lessons/classroom.css";
import "./share/share.css";
import { lang } from "./i18n";

document.documentElement.lang = lang();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

startPwa();
