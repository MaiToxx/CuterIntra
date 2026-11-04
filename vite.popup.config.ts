import { defineConfig } from "vite";
import { collapseLitTemplatesPlugin } from "./scripts/collapse-lit-templates.ts";
import { frCatalogPlugin } from "./scripts/i18n-catalog.ts";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import fs from "fs";
import pkg from "./package.json" with { type: "json" };
import { cp } from "fs/promises";
import { readRepoInfo, readWorkerUrl, readAuthMode } from "./scripts/repo-info.js";
import { splitDaisyThemesPlugin } from "./vite.config.ts";

const target = (process.env.TARGET || "firefox") as "firefox" | "chrome";
const outDir = process.env.BUILD_OUT_DIR || "dist";

/** Same asset as the content script's; see src/core/styles/shared-styles.ts. */
const SHARED_CSS_FILE = "shared-styles.css";
const repo = readRepoInfo();
const workerUrl = readWorkerUrl();
const authMode = readAuthMode();
// See vite.config.ts.
const storeBuild = process.env.CHROME_STORE === "1";

export default defineConfig({
  plugins: [
    collapseLitTemplatesPlugin(),
    frCatalogPlugin(),
    tailwindcss(),
    // This build writes shared-styles.css into the same folder as the content
    // build: it has to cut the same themes out, or it would put them back.
    splitDaisyThemesPlugin(),
    {
      name: "write-popup-html",
      closeBundle() {
        const popupHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cuter Intra</title>
  <!-- The Tailwind/daisyUI sheet as a file: a render-blocking <link> here is
       ~300 KB the popup bundle no longer has to carry and re-parse. -->
  <link rel="stylesheet" href="${SHARED_CSS_FILE}" />
  <style>
    html, body { margin: 0; padding: 0; width: 420px; min-height: 320px; }
    #popup-root { width: 100%; min-height: 320px; background: var(--color-base-100, white); color: var(--color-base-content, inherit); }
  </style>
</head>
<body>
  <div id="popup-root" data-theme="light">
    <div id="account-root" class="p-4"></div>
  </div>
  <script src="popup.js"></script>
</body>
</html>`;
        fs.writeFileSync(
          resolve(import.meta.dirname, outDir, "popup.html"),
          popupHtml,
          "utf-8",
        );
        console.log(`popup.html written`);
        // Copy icons
        const iconsSrc = resolve(import.meta.dirname, "public/icons");
        const iconsDst = resolve(import.meta.dirname, `${outDir}/icons`);
        if (fs.existsSync(iconsSrc)) {
          fs.mkdirSync(iconsDst, { recursive: true });
          for (const file of fs.readdirSync(iconsSrc)) {
            fs.cpSync(resolve(iconsSrc, file), resolve(iconsDst, file));
          }
          console.log(`icons copied to ${iconsDst}`);
        }
      },
    },
  ],
  build: {
    outDir: outDir,
    emptyOutDir: false,
    minify: true,
    // See vite.config.ts: keeps the compiled sheet out of popup.js and on disk.
    cssCodeSplit: false,
    rollupOptions: {
      input: { popup: resolve(import.meta.dirname, "src/popup/popup.ts") },
      output: {
        format: "iife",
        entryFileNames: "[name].js",
        assetFileNames: (asset: { names?: string[]; name?: string }) => {
          const name = asset.names?.[0] ?? asset.name ?? "";
          return name.endsWith(".css") ? SHARED_CSS_FILE : "[name].[ext]";
        },
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __REPO_URL__: JSON.stringify(repo.url),
    __REPO_RELEASES_API__: JSON.stringify(repo.releasesApi),
    __WORKER_URL__: JSON.stringify(workerUrl),
    __AUTH_MODE__: JSON.stringify(authMode),
    __STORE_BUILD__: JSON.stringify(storeBuild),
    __TS_VERSION__: JSON.stringify(pkg.devDependencies.typescript),
    __VITE_VERSION__: JSON.stringify(pkg.devDependencies.vite),
    __LIT_VERSION__: JSON.stringify(pkg.dependencies["lit-html"]),
    __TW_VERSION__: JSON.stringify(pkg.dependencies["@tailwindcss/vite"]),
    __DAISY_VERSION__: JSON.stringify(pkg.devDependencies.daisyui),
    __WEB_EXT_VERSION__: JSON.stringify(pkg.devDependencies["web-ext"]),
    "import.meta": "{}",
  },
});
