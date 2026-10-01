import { localizedMessage } from "./messages.ts";
import { useI18n } from "./i18n.tsx";
import { useState } from "preact/hooks";
import { api } from "./api.ts";
import type { RunAction } from "./common.tsx";
import type { Alias, BootstrapResponse, CreateAliasInput } from "./types.ts";

export function AliasSettings(
  { alias, run, refresh }: {
    alias: Alias;
    run: RunAction;
    refresh: () => Promise<void>;
  },
) {
  const { t } = useI18n();
  const [description, setDescription] = useState(alias.description ?? "");
  const [days, setDays] = useState(alias.retentionDays);
  const [busy, setBusy] = useState(false);
  async function save(event: Event) {
    event.preventDefault();
    setBusy(true);
    await run(async () => {
      await api.patchAlias(alias.id, { description, retentionDays: days });
      await refresh();
    }, localizedMessage("settings.addressSettingsSavedNewMailUsesThe"));
    setBusy(false);
  }
  async function toggle() {
    setBusy(true);
    await run(
      async () => {
        await api.patchAlias(alias.id, { enabled: !alias.enabled });
        await refresh();
      },
      alias.enabled
        ? localizedMessage("settings.addressDisabledNewMailWillBeRejected")
        : localizedMessage("settings.receivingResumed"),
    );
    setBusy(false);
  }
  return (
    <details class="alias-settings">
      <summary>{t("settings.addressSettings")}</summary>
      <form class="settings-form" onSubmit={save}>
        <label>
          {t("settings.sitePurpose")}
          <input
            maxLength={120}
            value={description}
            onInput={(event) => setDescription(event.currentTarget.value)}
          />
        </label>
        <label>
          {t("settings.retentionDaysForNewMail")}
          <input
            type="number"
            min="1"
            required
            value={days}
            onInput={(event) => setDays(Number(event.currentTarget.value))}
          />
        </label>
        <p class="muted">
          {t(
            "settings.expiredMailIsDeletedTheAddressIs",
          )}
        </p>
        <div class="button-row">
          <button type="submit" class="button" disabled={busy}>
            {t("settings.saveSettings")}
          </button>
          <button
            type="button"
            class="text-button"
            disabled={busy}
            onClick={toggle}
          >
            {alias.enabled
              ? t("settings.disableReceiving")
              : t("settings.resumeReceiving")}
          </button>
        </div>
      </form>
    </details>
  );
}

export function Settings(
  { bootstrap, run, refresh, onCreated }: {
    bootstrap: BootstrapResponse;
    run: RunAction;
    refresh: () => Promise<void>;
    onCreated: (alias: Alias) => void;
  },
) {
  const { t } = useI18n();
  const [alias, setAlias] = useState<CreateAliasInput>({
    address: "",
    description: "",
    retentionDays: bootstrap.config.defaultRetentionDays,
    defaultAction: "keep",
  });
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState("");
  async function createAlias(event: Event) {
    event.preventDefault();
    setBusy(true);
    await run(async () => {
      const created = await api.createAlias({
        ...alias,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      });
      await refresh();
      onCreated(created);
      setAlias({ ...alias, address: "", description: "" });
      setTags("");
    }, localizedMessage("settings.customAddressCreated"));
    setBusy(false);
  }
  return (
    <details class="advanced-settings">
      <summary>{t("settings.registerAnAddress")}</summary>
      <p class="muted">
        {bootstrap.config.allowCatchAll
          ? t("settings.unknownAddressesAreRegisteredWhenTheWorkflow")
          : t("settings.onlyRegisteredAddressesEnterTheReceivingWorkflow")}
      </p>
      <div class="custom-alias-form">
        <section>
          <h3>{t("settings.customAddress")}</h3>
          <form class="settings-form" onSubmit={createAlias}>
            <label>
              {t("settings.fullEmailAddress")}
              <input
                type="email"
                required
                placeholder="my-account@mail.example.com"
                value={alias.address}
                onInput={(event) =>
                  setAlias({ ...alias, address: event.currentTarget.value })}
              />
            </label>
            <label>
              {t("settings.sitePurpose")}
              <input
                value={alias.description}
                onInput={(event) =>
                  setAlias({
                    ...alias,
                    description: event.currentTarget.value,
                  })}
              />
            </label>
            <label>
              {t("actions.retentionDays")}
              <input
                type="number"
                min="1"
                required
                value={alias.retentionDays}
                onInput={(event) =>
                  setAlias({
                    ...alias,
                    retentionDays: Number(event.currentTarget.value),
                  })}
              />
            </label>
            <label>
              {t("actions.tagsCommaSeparated")}
              <input
                value={tags}
                onInput={(event) => setTags(event.currentTarget.value)}
              />
            </label>
            <button type="submit" class="button" disabled={busy}>
              {t("settings.createCustomAddress")}
            </button>
          </form>
        </section>
      </div>
    </details>
  );
}
