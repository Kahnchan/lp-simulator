import { ConfigProvider, Select } from "antd";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import { Languages } from "lucide-react";
import { useI18n } from "./useI18n";
import { useEffect, useState } from "react";
import ManualLpSimulator from "../examples/lp-simulator";
import LpSimulator from "./LpSimulator";

export default function LpSimulatorProject() {
  const { t, locale, setLocale } = useI18n();
  const [toolbarRoot, setToolbarRoot] = useState<HTMLDivElement | null>(null);
  const [favoritesRoot, setFavoritesRoot] = useState<HTMLDivElement | null>(
    null,
  );
  const [mode, setMode] = useState(() => {
    try {
      return localStorage.getItem("lp-simulator:mode") === "import"
        ? "import"
        : "manual";
    } catch {
      return "manual";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("lp-simulator:mode", mode);
    } catch {
      /* Keep mode usable without storage. */
    }
  }, [mode]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title =
      locale === "zh-CN" ? "LP Simulator · LP 模拟器" : "LP Simulator";
  }, [locale]);
  return (
    <ConfigProvider locale={locale === "zh-CN" ? zhCN : enUS}>
      <nav className="lp-mode-switch" aria-label={t("模拟模式")}>
        <div className="lp-toolbar-left">
          <div className="lp-mode-tabs" role="group" aria-label={t("模拟模式")}>
            {[
              { label: t("手动模拟"), value: "manual" },
              { label: t("导入 NFT 仓位"), value: "import" },
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
          <div className="lp-favorites-toolbar" ref={setFavoritesRoot} />
        </div>
        <div className="lp-toolbar-right">
          <div className="lp-network-toolbar" ref={setToolbarRoot} />
          <Select
            className="lp-language-select"
            aria-label={t("语言")}
            prefix={<Languages size={16} aria-hidden="true" />}
            value={locale}
            onChange={setLocale}
            options={[
              { value: "zh-CN", label: "中文" },
              { value: "en-US", label: "English" },
            ]}
          />
        </div>
      </nav>
      <div hidden={mode !== "manual"}>
        <ManualLpSimulator />
      </div>
      <div hidden={mode !== "import"}>
        <LpSimulator
          toolbarRoot={toolbarRoot}
          favoritesRoot={favoritesRoot}
          active={mode === "import"}
        />
      </div>
    </ConfigProvider>
  );
}
