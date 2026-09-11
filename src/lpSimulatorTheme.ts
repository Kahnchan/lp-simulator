import "./lpSimulatorTokens.css";
import { theme, type ThemeConfig } from "antd";

export const lpSimulatorTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: "#fc72ff",
    colorInfo: "#6b8cff",
    colorBgBase: "#131313",
    colorBgContainer: "#202020",
    colorBgElevated: "#272727",
    colorBorder: "#343434",
    colorText: "#f5f5f5",
    colorTextSecondary: "#9b9b9b",
    borderRadius: 12,
    borderRadiusLG: 12,
    borderRadiusSM: 6,
    borderRadiusXS: 6,
    controlHeight: 44,
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
  },
  components: {
    Button: {
      primaryShadow: "none",
      defaultShadow: "none",
      defaultBg: "#242424",
      defaultBorderColor: "#343434",
    },
    Segmented: {
      trackBg: "#1b1b1b",
      itemSelectedBg: "#333333",
      itemSelectedColor: "#ffffff",
      trackPadding: 4,
    },
    Slider: {
      trackBg: "#587bdb",
      trackHoverBg: "#7697ff",
      handleColor: "#7697ff",
      handleActiveColor: "#7697ff",
      railBg: "#303030",
    },
    Table: {
      headerBg: "#191919",
      rowHoverBg: "#222222",
      borderColor: "#292929",
    },
  },
};
