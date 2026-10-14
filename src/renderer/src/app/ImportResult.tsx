import { useId, useState, type ReactElement } from "react";

import { useI18n } from "../i18n/I18nContext";
import type { ImportResultNotice } from "./useImportFlow";

// The import result strip's text: a summary that counts and names a few files,
// shortened, and, when there is more to read, every failure or warning whole
// beneath it, revealed on request in an area that scrolls instead of growing.
export function ImportResultBody({ result }: { result: ImportResultNotice }): ReactElement {
  const i18n = useI18n();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const details = result.details ?? [];

  return (
    <div className="queue-import-result__body">
      <span>{i18n.node(result.message)}</span>
      {details.length > 0 ? (
        <>
          <div>
            <button
              type="button"
              className="button button--ghost button--compact queue-import-result__toggle"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => setOpen((current) => !current)}
            >
              {open ? i18n.t("common.hideDetails") : i18n.t("common.showDetails")}
            </button>
          </div>
          <ul id={detailsId} className="queue-import-result__details" hidden={!open}>
            {details.map((detail, index) => (
              <li key={index}>{i18n.text(detail)}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
