import { convertFileSrc } from "@tauri-apps/api/core";
import { backend, type S3Settings } from "../../api";
import { h } from "../../dom";
import type { MarkdPlugin, PluginApp } from "../api";
import { IMAGE_STORES, type ImageStore } from "./images";

// Stores images in an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, Aliyun OSS, ...) that is
// publicly readable, directly or through a CDN. Uploads are signed by the backend, which keeps the
// secret key in the OS keychain. Images under the public URL display through a local cache, so
// they still show offline once seen.

function settingsForm(el: HTMLElement, app: PluginApp, reload: () => Promise<void>) {
  const { workspace } = app;
  const text = (placeholder: string) =>
    h("input", { type: "text", placeholder, spellcheck: false, autocomplete: "off", autocapitalize: "off" });
  const inputs = {
    endpoint: text("https://s3.us-east-1.amazonaws.com"),
    region: text("us-east-1"),
    bucket: text("my-images"),
    prefix: text("images/"),
    publicUrl: text("https://img.example.com"),
    accessKeyId: text(""),
  } satisfies Record<keyof Omit<S3Settings, "pathStyle">, HTMLInputElement>;
  const pathStyle = h("input", { type: "checkbox" });
  const secret = h("input", { type: "password", autocomplete: "off" });
  const result = h("p", { class: "settings-result" });
  const save = h("button", { type: "button" }, "Save");
  const test = h("button", { type: "button" }, "Save and test");

  const field = (label: string, input: HTMLElement, hint = "") =>
    h("label", { class: "settings-field" }, h("span", {}, label), input, ...(hint ? [h("small", {}, hint)] : []));

  el.append(
    field("Endpoint", inputs.endpoint, "Leave empty for AWS. R2: https://<account>.r2.cloudflarestorage.com · MinIO: http://localhost:9000"),
    field("Region", inputs.region, "Empty means us-east-1. R2 uses auto."),
    field("Bucket", inputs.bucket),
    field("Path prefix", inputs.prefix, "Prepended to uploaded file names."),
    field("Public URL", inputs.publicUrl, "Where the bucket is publicly readable, e.g. a CDN. Empty links to the bucket itself."),
    h("label", { class: "settings-choice" }, pathStyle, "Path-style URLs (endpoint/bucket/key; MinIO and some providers need this)"),
    field("Access key ID", inputs.accessKeyId),
    field("Secret access key", secret, "Stored in the system keychain, never in a file."),
    h("div", { class: "settings-actions" }, save, test),
    result,
  );

  const show = (message: string, kind: "ok" | "error") => {
    result.textContent = message;
    result.dataset.kind = kind;
  };

  const fill = async () => {
    const settings = await backend.getSettings();
    for (const [key, input] of Object.entries(inputs)) input.value = settings.images.s3[key as keyof typeof inputs];
    pathStyle.checked = settings.images.s3.pathStyle;
    secret.value = "";
    secret.placeholder = settings.hasS3Secret ? "Saved in the system keychain" : "";
  };

  const store = async () => {
    const settings = await backend.getSettings();
    const s3 = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()]));
    await backend.setSettings(
      { images: { ...settings.images, s3: { ...(s3 as Omit<S3Settings, "pathStyle">), pathStyle: pathStyle.checked } } },
      secret.value || null,
    );
    await fill();
    await reload();
  };

  const busy = async (task: () => Promise<string>) => {
    save.disabled = test.disabled = true;
    show("Working…", "ok");
    try {
      show(await task(), "ok");
    } catch (e) {
      show(String(e), "error");
    } finally {
      save.disabled = test.disabled = false;
    }
  };

  save.addEventListener("click", () => void busy(async () => (await store(), "Saved.")));
  test.addEventListener("click", () => void busy(async () => (await store(), await backend.s3Test())));
  workspace.run(fill);
}

export const s3: MarkdPlugin = {
  id: "markd.s3",
  name: "S3 image storage",

  activate(app) {
    let publicBase: string | null = null;
    const reload = async () => {
      publicBase = (await backend.getSettings()).s3PublicBase;
      app.render.refresh();
    };

    const store: ImageStore = {
      id: "s3",
      name: "S3",
      savePasted: (bytes, name) => backend.s3UploadImage(bytes, name),
      importDropped: () => backend.s3UploadDropped(),
      // Load our own images through the local cache (markd-cache://) so they work offline.
      displayUrl: (src) => (publicBase && src.startsWith(`${publicBase}/`) ? convertFileSrc(src, "markd-cache") : null),
    };
    app.extensionPoint<ImageStore>(IMAGE_STORES).add(store);
    app.settings.addSection({ id: "s3", title: "S3 image storage", render: (el) => settingsForm(el, app, reload) });
    app.workspace.run(reload);
  },
};
