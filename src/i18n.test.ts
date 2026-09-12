import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import english from "./locales/en.json";
import { resolveLocale, translate } from "./i18n";

test("saved language takes precedence, invalid preferences fall back to browser language", () => {
  assert.equal(resolveLocale("en-US", ["zh-CN"]), "en-US");
  assert.equal(resolveLocale("zh-CN", ["en-US"]), "zh-CN");
  assert.equal(resolveLocale("invalid", ["zh-TW"]), "zh-CN");
  assert.equal(resolveLocale(null, ["fr-FR"]), "en-US");
});

test("dynamic labels and stored chain errors translate without changing prices or IDs", () => {
  assert.equal(
    translate("en-US", "实际投入本金（可选，{0}）", "USDC"),
    "Invested capital (optional, USDC)",
  );
  assert.equal(
    translate(
      "zh-CN",
      "入场价值：{0} {1}（{2}）",
      "299.39",
      "USDC",
      "采用填写的投入本金",
    ),
    "入场价值：299.39 USDC（采用填写的投入本金）",
  );
  const error = "RPC 网络不匹配：选择的是 8453，节点返回 1。";
  assert.equal(
    translate("en-US", error),
    "RPC network mismatch: selected 8453, endpoint returned 1.",
  );
  assert.equal(translate("zh-CN", error), error);
  assert.equal(
    translate(
      "en-US",
      "历史读取失败：RPC 节点响应超时，请稍后重试或更换节点。",
    ),
    "Could not load history: RPC timed out. Try again later or use another endpoint.",
  );
});

test("all UI translation keys have English copy and matching placeholders", () => {
  const files = [
    "src/LpSimulatorProject.tsx",
    "src/LpSimulator.tsx",
    "src/LpPriceSlider.tsx",
    "src/LpValueChart.tsx",
    "src/LpUsdcPanel.tsx",
    "examples/lp-simulator.jsx",
  ];
  for (const file of files) {
    const ast = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === "t" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const key = node.arguments[0].text;
        assert.ok(
          Object.hasOwn(english, key),
          `${file}: Missing English translation for ${key}`,
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  for (const [key, value] of Object.entries(english)) {
    assert.ok(
      !/[\u4e00-\u9fff]/.test(value),
      `Untranslated English message: ${key}`,
    );
    assert.deepEqual(
      key.match(/\{\d+\}/g)?.sort() ?? [],
      value.match(/\{\d+\}/g)?.sort() ?? [],
      `Placeholder mismatch: ${key}`,
    );
  }
});
