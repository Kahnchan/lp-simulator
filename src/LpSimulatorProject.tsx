import { useState } from "react";
import ManualLpSimulator from "../examples/lp-simulator";
import LpSimulator from "./LpSimulator";

export default function LpSimulatorProject() {
  const [toolbarRoot, setToolbarRoot] = useState<HTMLDivElement | null>(null);
  const [mode, setMode] = useState("manual");
  return (
    <>
      <nav className="lp-mode-switch" aria-label="模拟模式">
        <div className="lp-mode-tabs" role="group" aria-label="模拟模式">
          {[
            { label: "手动模拟", value: "manual" },
            { label: "导入 NFT 仓位", value: "import" },
          ].map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={mode === item.value}
              onClick={() => setMode(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="lp-network-toolbar" ref={setToolbarRoot} />
      </nav>
      <div hidden={mode !== "manual"}>
        <ManualLpSimulator />
      </div>
      <div hidden={mode !== "import"}>
        <LpSimulator toolbarRoot={toolbarRoot} active={mode === "import"} />
      </div>
    </>
  );
}
