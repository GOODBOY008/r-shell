# R-Shell logo

The large white `>_` prompt is the focal point of the mark, with a smaller Rust-orange R in the upper-right as the signature. Jade, teal, and cyan diagonal fields frame the graphite tile and connect the icon to R-Shell's teal interface. The direction keeps IntelliJ IDEA's bold frame and inset-tile style with R-Shell's own palette and the terminal prompt as its main symbol. All artwork is SVG geometry with no embedded image or font dependency.

## Assets and placement

| Asset | Use |
| --- | --- |
| [`r-shell-logo.svg`](../src/assets/r-shell-logo.svg) | Primary mark, at 48 px and larger. README and About dialog. |
| [`r-shell-icon.svg`](../src/assets/r-shell-icon.svg) | Compact mark, from 16 px. Favicon, app header, welcome header, and operating-system icons. A larger interior tile, heavier R, and thicker prompt preserve the same identity at small sizes. |
| [`r-shell-logo-monochrome.svg`](../src/assets/r-shell-logo-monochrome.svg) | Single-ink reproduction, at 48 px and larger. Uses transparent cutouts and `currentColor` when inlined. An external `<img>` defaults to black; use an SVG mask or set the source color for a white version. |

Keep the square aspect ratio and the transparent padding built into the SVG. Leave at least one eighth of the displayed mark's width clear around it when placing unrelated content nearby. Keep the frame, tile, and glyphs together; do not stretch, rotate, recolor individual elements, or add effects. Use the monochrome asset when only one ink is available; its transparent outlines and glyph cutouts preserve the design in either dark or white ink.

## Palette

| Role | Color |
| --- | --- |
| R signature | `#D34516` |
| Jade field | `#91D8A0` → `#22A885` |
| Cyan field | `#43C6DE` → `#217F9E` |
| Lower teal field | `#167967` |
| Central tile | `#121820` |
| Terminal prompt | `#F4F7FA` |

The R keeps the orange from the [Rust Foundation palette](https://rustfoundation.org/brand-guide/). [JetBrains' brand assets](https://www.jetbrains.com/company/brand/) provided the visual reference for the new direction. The simplified shapes and small-size variant follow [Fluent's icon guidance](https://fluent2.microsoft.design/iconography) and Microsoft's guidance on [simple metaphors, silhouette, contrast, and high-contrast reproduction](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-design).

## Export checks

Generate desktop icons with `pnpm tauri icon src/assets/r-shell-icon.svg --output <temporary-directory>`. Copy the existing desktop filenames into `src-tauri/icons/`, mirror `icon.png` to `r-shell.png`, and leave mobile exports out of this desktop asset set.

After changing the mark, inspect 16, 24, and 32 px compact exports and larger primary exports on light and dark surfaces. Check the monochrome cutouts in both dark and white ink. Regenerate every desktop icon together, and run `pnpm build` to verify the imported SVGs and favicon.
