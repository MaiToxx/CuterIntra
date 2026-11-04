/**
 * "Presets & sharing" panel of the Customize tab.
 * Save the current look under a name, apply or delete saved presets, copy a
 * theme code to share it, paste a code received from someone else, or reset.
 */
import { html, render } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import {
  applyCustomization,
  decodePresetCode,
  deletePreset,
  encodePresetCode,
  listPresets,
  presetImageHost,
  resetCustomization,
  savePreset,
  snapshotCustomization,
  type CustomPreset,
} from "./presets.ts";
import { publishLookIfShared } from "./publish.ts";
import { t } from "../../core/i18n/i18n.ts";

/**
 * The hub renders each control once with the value read at open time. After
 * a preset is applied the storage is right but the inputs still show the old
 * values: push the new ones into the controls of the same hub.
 */
function syncHubControls(
  root: ParentNode,
  values: Record<string, unknown>,
): void {
  for (const [key, val] of Object.entries(values)) {
    const controls = root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      `[data-setting-key="${key}"]`,
    );
    controls.forEach((control) => {
      const input = control as HTMLInputElement;
      if (input.type === "radio") input.checked = input.value === String(val);
      else if (input.type === "checkbox") input.checked = Boolean(val);
      else control.value = String(val ?? "");
    });
  }
}

export function renderPresetsPanel() {
  const setup = (el: Element | undefined) => {
    if (!el) return;
    const container = el as HTMLElement;
    if (container.dataset.presetsReady) return;
    container.dataset.presetsReady = "1";
    const hubRoot = container.getRootNode() as ParentNode;
    const applyAndSync = async (values: Parameters<typeof applyCustomization>[0]) => {
      await applyCustomization(values);
      syncHubControls(hubRoot, values as unknown as Record<string, unknown>);
      container.dispatchEvent(
        new CustomEvent("bi-settings-synced", { bubbles: true, composed: true }),
      );
      publishLookIfShared("CUSTOM_ACCENT_COLOR");
    };

    let presets: CustomPreset[] = [];
    let status = "";
    let statusOk = true;

    const say = (msg: string, ok = true) => {
      status = msg;
      statusOk = ok;
      draw();
      setTimeout(() => {
        if (status === msg) {
          status = "";
          draw();
        }
      }, 3500);
    };

    const onSave = async () => {
      const input = container.querySelector<HTMLInputElement>("[data-preset-name]");
      const name = input?.value.trim() ?? "";
      if (!name) return say(t("Give the preset a name first."), false);
      presets = await savePreset(name, await snapshotCustomization());
      if (input) input.value = "";
      say(t('Saved "{name}".', { name }));
    };

    const onApply = async (p: CustomPreset) => {
      await applyAndSync(p.values);
      say(t('Applied "{name}".', { name: p.name }));
    };

    const onDelete = async (p: CustomPreset) => {
      presets = await deletePreset(p.name);
      say(t('Deleted "{name}".', { name: p.name }));
    };

    const onCopy = async () => {
      const code = encodePresetCode(await snapshotCustomization());
      try {
        await navigator.clipboard.writeText(code);
        say(t("Theme code copied. Send it to a friend!"));
      } catch {
        window.prompt(t("Copy your theme code:"), code);
      }
    };

    const onPaste = async () => {
      const code = window.prompt(t("Paste a Cuter Intra theme code:"));
      if (code === null) return;
      const values = decodePresetCode(code);
      if (!values) return say(t("This is not a valid theme code."), false);
      const imageHost = presetImageHost(values);
      if (
        imageHost &&
        !window.confirm(
          t(
            "This theme loads a background image from {host} on every Intra page. Apply it anyway?",
            { host: imageHost },
          ),
        )
      )
        return;
      await applyAndSync(values);
      say(t("Theme applied from code."));
    };

    const onReset = async () => {
      if (!window.confirm(t("Reset every Customize setting to the defaults?"))) return;
      await resetCustomization();
      syncHubControls(hubRoot, await snapshotCustomization());
      container.dispatchEvent(
        new CustomEvent("bi-settings-synced", { bubbles: true, composed: true }),
      );
      publishLookIfShared("CUSTOM_ACCENT_COLOR");
      say(t("Customization reset."));
    };

    const draw = () =>
      render(
        html`
          <div class="flex flex-col gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <input
                type="text"
                class="input input-accent input-sm w-48"
                placeholder="${t("Preset name")}"
                aria-label="${t("Preset name")}"
                maxlength="40"
                data-preset-name
                @keydown="${(e: KeyboardEvent) => {
                  if (e.key === "Enter") void onSave();
                }}"
              />
              <button type="button" class="btn btn-sm btn-primary" @click="${onSave}">
                ${t("Save current look")}
              </button>
              <div class="flex-1"></div>
              <button type="button" class="btn btn-sm" @click="${onCopy}">${t("Copy theme code")}</button>
              <button type="button" class="btn btn-sm" @click="${onPaste}">${t("Paste theme code")}</button>
              <button type="button" class="btn btn-sm btn-ghost" @click="${onReset}">${t("Reset")}</button>
            </div>
            ${presets.length === 0
              ? html`<p class="text-xs opacity-60">
                  ${t(
                    "No preset yet. Adjust the settings below, then save them under a name to switch looks in one click.",
                  )}
                </p>`
              : html`<ul class="flex flex-wrap gap-2">
                  ${presets.map(
                    (p) => html`<li class="join">
                      <button
                        type="button"
                        class="btn btn-sm join-item"
                        title="${t("Apply this preset")}"
                        @click="${() => onApply(p)}"
                      >
                        ${p.name}
                      </button>
                      <button
                        type="button"
                        class="btn btn-sm btn-ghost join-item px-2"
                        title="${t("Delete this preset")}"
                        aria-label="${t("Delete {name}", { name: p.name })}"
                        @click="${() => onDelete(p)}"
                      >
                        ✕
                      </button>
                    </li>`,
                  )}
                </ul>`}
            ${status
              ? html`<p class="text-xs ${statusOk ? "text-success" : "text-error"}">${status}</p>`
              : ""}
          </div>
        `,
        container,
      );

    void listPresets().then((p) => {
      presets = p;
      draw();
    });
    draw();
  };

  return html`<div ${ref(setup)} class="col-span-full"></div>`;
}
