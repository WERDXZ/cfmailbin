import { useI18n } from "./i18n.tsx";
import { useId, useRef, useState } from "preact/hooks";

export interface CreationOption {
  id: string;
  label: string;
  description?: string;
}
export interface CreationTemplate extends CreationOption {
  type?: string;
  group?: string;
  composition?: boolean;
}

/** A type creates a blank draft; the optional sidebar only selects preset values. */
export function TemplatePicker(
  { label, actionLabel, blank, types, options, disabled, create }: {
    label: string;
    actionLabel: string;
    blank: CreationOption;
    types?: CreationOption[];
    options: CreationTemplate[];
    disabled?: boolean;
    create: (id: string, type: string) => void | boolean;
  },
) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [type, setType] = useState(types?.[0]?.id ?? "");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const template = options.find((option) => option.id === templateId);
  const nodeType = types?.find((option) => option.id === type);
  const preview = template ?? nodeType ?? blank;
  const choices = options.filter((option) =>
    !option.type || option.type === type
  );
  const groups = [
    ...new Set(choices.map((option) => option.group ?? t("nodes.template"))),
  ];
  return (
    <div class="template-picker">
      <button
        type="button"
        class="text-button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-controls={id}
        onClick={() => {
          setTemplateId(null);
          setType(types?.[0]?.id ?? "");
          dialog.current?.showModal();
        }}
      >
        {label}
      </button>
      <dialog
        ref={dialog}
        id={id}
        class="creation-dialog"
        aria-labelledby={`${id}-title`}
      >
        <div class="creation-layout">
          <div class="creation-main">
            <h2 id={`${id}-title`}>{label}</h2>
            {types && !template?.composition && (
              <label>
                {t("templates.nodeType")}
                <select
                  value={type}
                  onChange={(event) => {
                    setType(event.currentTarget.value);
                    setTemplateId(null);
                  }}
                >
                  {types.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div class="creation-preview" aria-live="polite">
              <span class="muted">
                {template?.composition
                  ? t("nodes.compositeTemplate")
                  : template
                  ? t("templates.usingAPreset")
                  : t("templates.blankConfiguration")}
              </span>
              <h3>{preview.label}</h3>
              <p class="muted">
                {preview.description ??
                  t("templates.youCanEditTheConfigurationAfterCreating")}
              </p>
              {template && (
                <button
                  type="button"
                  class="text-button text-button--quiet"
                  onClick={() => setTemplateId(null)}
                >
                  {template.composition
                    ? t("templates.backToASingleNode")
                    : t("templates.clearPreset")}
                </button>
              )}
            </div>
            <div class="creation-actions">
              <button
                type="button"
                class="button button--primary"
                autoFocus={!types}
                onClick={() => {
                  if (create(template?.id ?? blank.id, type) !== false) {
                    dialog
                      .current?.close();
                  }
                }}
              >
                {template?.composition
                  ? t("templates.addCompositeNodes")
                  : actionLabel}
              </button>
              <button
                type="button"
                class="button button--quiet"
                onClick={() => dialog.current?.close()}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
          <aside
            class="template-sidebar"
            aria-label={t("templates.optionalPresets")}
          >
            {groups.length
              ? groups.map((group) => (
                <section key={group}>
                  <h3>{group}</h3>
                  <ul>
                    {choices.filter((option) =>
                      (option.group ?? t("nodes.template")) === group
                    ).map((option) => (
                      <li key={option.id}>
                        <button
                          type="button"
                          class="template-option"
                          aria-pressed={templateId === option.id}
                          onClick={() => setTemplateId(option.id)}
                        >
                          <span>{option.label}</span>
                          <span class="template-option-mark" aria-hidden="true">
                            {templateId === option.id ? "✓" : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
              : (
                <p class="muted">
                  {t("templates.noTemplatesForThisTypeYouCan")}
                </p>
              )}
          </aside>
        </div>
      </dialog>
    </div>
  );
}
