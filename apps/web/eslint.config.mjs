import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // UI primitives come from shadcn (src/components/ui); add missing ones with `pnpm dlx shadcn@latest add <name>`.
  {
    files: ["src/**/*.tsx"],
    ignores: ["src/components/ui/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...["button", "input", "select", "textarea", "label"].map((tag) => ({
          selector: `JSXOpeningElement[name.name='${tag}']`,
          message: `Use the shadcn <${tag[0].toUpperCase()}${tag.slice(1)}> from @/components/ui instead of a raw <${tag}>.`,
        })),
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-voice/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
