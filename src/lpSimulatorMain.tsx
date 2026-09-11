import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider } from "antd";
import { lpSimulatorTheme } from "./lpSimulatorTheme";
import LpSimulatorProject from "./LpSimulatorProject";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider theme={lpSimulatorTheme}>
      <LpSimulatorProject />
    </ConfigProvider>
  </StrictMode>,
);
