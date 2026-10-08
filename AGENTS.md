# qt-uniappx Local Rules

This directory is a UniAppX music application only.

## Framework and runtime

- Use Vue 3 Composition API, `.uvue` pages/components, UTS services, and Vapor mode.
- Do not add Vue 2, nvue, Vuex, `plus.*`, or legacy native plugin code.
- Use Pinia for global player/business state. Keep network access behind `services/http.ts`.
- Every request to the astral backend must carry the unified client system headers
  (`X-App-Ut` / `X-App-Version` / `X-Device` / `X-OS`), built once in `services/client-info.ts`.
  `services/http.ts` injects them for astral URLs only; raw `uni.request` call sites
  (`source-update.uts`, `uni_modules/qt-stat` reporters) must call `mergeClientHeaders()` /
  `applyClientHeaders()` themselves. Never add these headers to third-party or pre-signed
  upload requests — custom headers break signature/form validation and leak host info.
  Contract owner: astral `astral-common` → `com.astral.common.util.ClientHeaders`
  (documented in astral `COMPONENTS_GUIDE.md`).
- Put Android, iOS, and Harmony native behavior in UTS services with `#ifdef` comments where platform branches are required.
- Do not edit sibling projects while working in this directory.

## Qt UI module architecture

- `uni_modules/qt-ui` is the single UI library for the entire app. New UI components must be added there; do not create new app UI components under a root-level `components/` directory.
- UI components live under `uni_modules/qt-ui/components/<component-name>/<component-name>.uvue`.
- Shared UI behavior belongs in `uni_modules/qt-ui/composables/`; runtime theme/skin state belongs in `uni_modules/qt-ui/stores/`; UI-only services such as icon definitions belong in `uni_modules/qt-ui/services/`.
- Pages must import Qt UI components from `@/uni_modules/qt-ui/...`, not from old `@/components/...` paths.
- Keep generic UI components separate from app-specific business adapters. A component may use app services only when it is intentionally a business UI component such as the player, notice, upgrade, or song-row components.
- The UI module uses `dcloudext.type: "component"` because `.uvue` files are component resources. If native platform capability is needed, add an optional `uni_modules/qt-ui/utssdk/` implementation; do not treat `.uvue` files as pure UTS native entry points.
- Design tokens: `uni.scss` SCSS variables resolve **only inside `uni.scss` itself**. Verified by a real HBuilderX build — the same `$var` written in a page/component `<style>` fails with ``[plugin:uni:app-uvue-css] ERROR: property value `$x` is not valid for `color` `` and that property is silently dropped (a non-existent variable produces the identical error, i.e. it is treated as a literal). So page/component styles must use literal values; `uni_modules/qt-ui/stores/theme.ts` is the place for runtime skins, wallpaper, and light/dark state.
- All responsive UI components must use the shared layout helper at `uni_modules/qt-ui/composables/use-qt-layout.ts`. Components must handle compact and wide layouts internally, not only at the page level.
- All pages must use `qt-page-frame` from `uni_modules/qt-ui/components/qt-page-frame/qt-page-frame.uvue`; immersive media pages may pass `:full-width="true"`.
- Default wide-screen breakpoint is `720px`. Use runtime-calculated pixel widths for max-width behavior.

## Vapor / UVue CSS restrictions

- Avoid descendant, child, sibling, and complex combined selectors. Do not write selectors such as `.parent .child`, `.parent > .child`, or `.item:last-child`.
- Bind state classes directly to the target node, for example `qt-button-label-sm`, `footer-button-left`, or `as-sheet-wide`.
- Do not use `max-width: 100%`; calculate the final width in script and bind `width: Npx` through an inline style.
- Prefer one flat class per rule. Split grouped selectors when Vapor CSS parsing is uncertain.
- Verified unavailable in Vapor: `aria-label` / `aria-role` are rejected on built-in elements — `warn: Property 'aria-label' is not supported on '<view>'` and the same for `<text>`; the attribute is dropped. Custom components (e.g. `QtIcon`) do not warn because they simply receive unknown props, but that produces no real accessibility semantics. Do not add `aria-*` expecting screen-reader support; there is currently no accessibility-label API in this mode.
- Do not add `linear-gradient`, `backdrop-filter`, CSS variables, or other Web-only CSS unless it has been verified in the uni-app x CSS documentation and in a real HBuilderX build.
- **Text styles do not inherit**: app-uvue isolates parent and child component properties, so `font-size` / `color` / `font-weight` written on a `<view>` never reach a child `<text>` — the text silently falls back to the css reset (`font-size: 16px`, `color: #000000`). Put every text property on the `<text>` node itself (inline style or its own class). This bit the karaoke lyric line: `karaokeWrapStyle()` set `font-size` on the `.lrc-karaoke` `<view>`, so each word `<text>` rendered at the 16px default and looked smaller than ordinary lyric lines. The official wording is 「样式不继承」 in <https://doc.dcloud.net.cn/uni-app-x/css/>; `inherit` / `unset` are also unsupported.
- Use `rpx` for component dimensions and calculated `px` for window-dependent widths.
- Use `<image>` plus a separate overlay `<view>` for wallpapers instead of CSS `background-image` when cross-platform behavior matters.

## Validation

- Run `npm run check` after adding or moving `.uvue` components.
- Run a real HBuilderX Android or iOS build before considering a UI/CSS change complete; the static checker does not replace Vapor CSS compilation.
- Check both a compact viewport and a wide viewport, including the wide behavior of sheets/drawers, sidebars, player controls, list rows, home cards, search rows, settings cells, and content containers.
- After changing page orientation or wide-screen layout, rebuild/reinstall the custom base or app package before judging the emulator result; a hot reload may preserve the previous orientation and layout cache.
- Keep `uni_modules/qt-ui/docs/design.md` and `uni_modules/qt-ui/readme.md` updated when changing the UI module structure or public component API.
