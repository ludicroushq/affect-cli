import { effectNative, recommended, strict } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, vitest, antiSlop, recommended, effectNative, strict],
  options: {
    denyWarnings: true,
    reportUnusedDisableDirectives: "error",
    respectEslintDisableDirectives: false,
    typeAware: true,
  },
  overrides: [
    {
      files: ["tests/**/*.ts"],
      // Black-box tests use native process/filesystem APIs to verify the shipped executable.
      rules: {
        "effecttsgo/async-function": "off",
        "effecttsgo/node-builtin-import": "off",
        "effecttsgo/prefer-effect-array": "off",
        "effecttsgo/prefer-effect-record": "off",
        "effecttsgo/process-env": "off",
      },
    },
  ],
});
