import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = new URL("../../", import.meta.url);
const dest = new URL("website/public/media/", root);
await mkdir(dest, { recursive: true });
await Promise.all(
  [
    "ssh-workspace",
    "multi-host-dashboard",
    "file-transfer-workspace",
    "settings-shortcuts",
  ].map(async (name) => {
    await sharp(fileURLToPath(new URL("screenshots/" + name + ".png", root)))
      .resize({ width: 1600, withoutEnlargement: true })
      .webp({ quality: 90 })
      .toFile(fileURLToPath(new URL(name + ".webp", dest)));
  }),
);
for (const name of ["r-shell-logo.svg", "r-shell-icon.svg"]) {
  await copyFile(new URL("src/assets/" + name, root), new URL(name, dest));
}
