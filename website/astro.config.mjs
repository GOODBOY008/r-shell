import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const site = readFileSync(
  new URL("./origin.txt", import.meta.url),
  "utf8",
).trim();
const chapters = [
  "installation",
  "ssh",
  "terminal",
  "transfers",
  "remote-desktop",
  "monitoring",
  "cloud-sync",
  "shortcuts",
  "troubleshooting",
];
export default defineConfig({
  site,
  integrations: [
    starlight({
      title: "R-Shell",
      favicon: "/media/r-shell-icon.svg",
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        zh: { label: "简体中文", lang: "zh-CN" },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/GOODBOY008/r-shell",
        },
      ],
      sidebar: [
        {
          label: "Handbook",
          translations: { "zh-CN": "用户手册" },
          items: ["docs", ...chapters.map((c) => "docs/" + c)],
        },
      ],
      customCss: ["./src/styles/docs.css"],
    }),
  ],
});
