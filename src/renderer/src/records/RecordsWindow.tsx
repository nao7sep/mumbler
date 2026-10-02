import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";

import { loadCatalogue } from "@shared/i18n/catalogues";
import { isLanguage, type InterfaceLanguage } from "@shared/i18n/languages";
import {
  RECORD_KINDS,
  RECORD_LEVELS,
  type RecordDetail,
  type RecordKind,
  type RecordLevel,
  type RecordSources,
  type RecordsQuery,
  type RecordSummary,
} from "@shared/records";

import { currentCompositeIndex, nextIndex, type NavDirection } from "../app/composite-nav";
import { reportRendererDiagnostic } from "../app/presentFailure";
import { I18nProvider, useI18n } from "../i18n/I18nContext";
import {
  KIND_LABELS,
  LEVEL_LABELS,
  LEVEL_PILLS,
  cursorAfter,
  durationSeconds,
  prettyJson,
  recordKey,
  stepLabel,
} from "./record-format";

const ENGLISH: InterfaceLanguage = { language: "en", locale: "en" };

// The records window speaks the interface language from its first text, and
// follows it when Settings changes it in the main window.
export function RecordsApp(): ReactElement {
  const [language, setLanguage] = useState<InterfaceLanguage | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void window.mumbler
        .getInterfaceLanguage()
        .then(async (resolved) => {
          const next = isLanguage(resolved?.language) ? resolved : ENGLISH;
          await loadCatalogue(next.language);
          if (!cancelled) setLanguage(next);
        })
        .catch((error: unknown) => {
          reportRendererDiagnostic(error, "records window language load failed");
          if (!cancelled) setLanguage((current) => current ?? ENGLISH);
        });
    };
    read();
    const unsubscribe = window.mumbler.onInterfaceLanguageChanged(read);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (language === null) {
    return <main className="renderer-failure" role="status" aria-busy="true" />;
  }

  return (
    <I18nProvider language={language.language} locale={language.locale}>
      <RecordsWindow />
    </I18nProvider>
  );
}

type Filters = Omit<RecordsQuery, "after">;

const NO_FILTERS: Filters = { session: null, kind: null, level: null, cardId: null, search: "" };
const SEARCH_DELAY_MS = 300;

type ListState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; records: RecordSummary[]; more: boolean; loadingMore: boolean; moreFailed: boolean };

type DetailState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; record: RecordDetail };

type Selection = { kind: RecordKind; id: number };

export function RecordsWindow(): ReactElement {
  const { t, locale } = useI18n();
  const [sources, setSources] = useState<RecordSources | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [searchText, setSearchText] = useState("");
  const [reloads, setReloads] = useState(0);
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [selected, setSelected] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "none" });
  const listGeneration = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const timeFormat = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }), [locale]);

  useEffect(() => {
    document.title = t("records.title");
  }, [t]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((current) => (current.search === searchText ? current : { ...current, search: searchText }));
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    let cancelled = false;
    void window.mumbler.readRecordSources().then(
      (next) => {
        if (!cancelled) setSources(next);
      },
      (error: unknown) => reportRendererDiagnostic(error, "record sources read failed"),
    );
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  // A page applies only while the filters it was read for are still the
  // newest ones asked for.
  useEffect(() => {
    const generation = ++listGeneration.current;
    setList({ status: "loading" });
    void window.mumbler.readRecordsPage({ ...filters, after: null }).then(
      (page) => {
        if (generation !== listGeneration.current) return;
        setList({ status: "ready", records: page.records, more: page.more, loadingMore: false, moreFailed: false });
      },
      (error: unknown) => {
        if (generation !== listGeneration.current) return;
        reportRendererDiagnostic(error, "records read failed");
        setList({ status: "failed" });
      },
    );
  }, [filters, reloads]);

  const selectedKey = selected === null ? null : recordKey(selected);

  useEffect(() => {
    if (selected === null) {
      setDetail({ status: "none" });
      return;
    }
    let cancelled = false;
    setDetail({ status: "loading" });
    void window.mumbler.readRecordDetail(selected.kind, selected.id).then(
      (record) => {
        if (!cancelled) setDetail(record === null ? { status: "failed" } : { status: "ready", record });
      },
      (error: unknown) => {
        if (cancelled) return;
        reportRendererDiagnostic(error, "record read failed");
        setDetail({ status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
    // The selection is compared by its key, not by the object holding it.
  }, [selectedKey]);

  const showMore = (): void => {
    if (list.status !== "ready" || list.loadingMore) return;
    const generation = listGeneration.current;
    setList({ ...list, loadingMore: true, moreFailed: false });
    void window.mumbler.readRecordsPage({ ...filters, after: cursorAfter(list.records) }).then(
      (page) => {
        if (generation !== listGeneration.current) return;
        setList((current) =>
          current.status === "ready"
            ? { ...current, records: [...current.records, ...page.records], more: page.more, loadingMore: false }
            : current,
        );
      },
      (error: unknown) => {
        if (generation !== listGeneration.current) return;
        reportRendererDiagnostic(error, "records read failed");
        setList((current) => (current.status === "ready" ? { ...current, loadingMore: false, moreFailed: true } : current));
      },
    );
  };

  const records = list.status === "ready" ? list.records : [];
  const keys = records.map(recordKey);
  const tabStopKey = selectedKey !== null && keys.includes(selectedKey) ? selectedKey : (keys[0] ?? null);

  const select = (record: RecordSummary): void => {
    if (recordKey(record) !== selectedKey) setSelected({ kind: record.kind, id: record.id });
  };

  // The list is one listbox (composite-control-conventions, Listbox); the
  // selection follows focus.
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const directions: Record<string, NavDirection> = {
      ArrowDown: "next",
      ArrowUp: "prev",
      PageDown: "page-next",
      PageUp: "page-prev",
      Home: "first",
      End: "last",
    };
    const direction = directions[event.key];
    if (direction === undefined) return;
    event.preventDefault();
    const container = listRef.current;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.recordKey : undefined;
    const current = currentCompositeIndex({ ids: keys, focusedId: focused, selectedId: selectedKey });
    const firstOption = container?.querySelector<HTMLElement>("[data-record-key]");
    const pageStep = container && firstOption?.offsetHeight ? Math.floor(container.clientHeight / firstOption.offsetHeight) : 8;
    const target = nextIndex(direction, current, keys.length, pageStep);
    if (target < 0) return;
    const option = container?.querySelector<HTMLElement>(`[data-record-key="${CSS.escape(keys[target]!)}"]`);
    option?.focus();
    option?.scrollIntoView?.({ block: "nearest" });
  };

  const launchLabel = (session: string): string => {
    const time = timeFormat.format(new Date(session));
    return session === sources?.currentSession ? t("records.thisLaunch", { time }) : time;
  };

  return (
    <div className="records-shell">
      <section className="panel records-list-pane" aria-label={t("records.title")}>
        <div className="records-filters">
          <div className="field">
            <input
              type="search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={t("records.search")}
              aria-label={t("records.search")}
            />
          </div>
          <div className="records-filters__row">
            <FilterSelect
              label={t("records.launch")}
              value={filters.session}
              allLabel={t("records.allLaunches")}
              options={(sources?.sessions ?? []).map((session) => ({ value: session, label: launchLabel(session) }))}
              onChange={(session) => setFilters({ ...filters, session })}
            />
            <FilterSelect
              label={t("records.recording")}
              value={filters.cardId}
              allLabel={t("records.allRecordings")}
              options={(sources?.cards ?? []).map((card) => ({ value: card.cardId, label: card.name ?? card.cardId }))}
              onChange={(cardId) => setFilters({ ...filters, cardId })}
            />
          </div>
          <div className="records-filters__row">
            <FilterSelect
              label={t("records.kind")}
              value={filters.kind}
              allLabel={t("records.allKinds")}
              options={RECORD_KINDS.map((kind) => ({ value: kind, label: t(KIND_LABELS[kind]) }))}
              onChange={(kind) => setFilters({ ...filters, kind: kind as RecordKind | null })}
            />
            <FilterSelect
              label={t("records.level")}
              value={filters.level}
              allLabel={t("records.allLevels")}
              options={RECORD_LEVELS.map((level) => ({ value: level, label: t(LEVEL_LABELS[level]) }))}
              onChange={(level) => setFilters({ ...filters, level: level as RecordLevel | null })}
            />
            <button type="button" className="button" onClick={() => setReloads((count) => count + 1)}>
              {t("records.refresh")}
            </button>
          </div>
        </div>
        <div className="records-list-scroll" aria-busy={list.status === "loading"}>
          {list.status === "failed" ? (
            <p className="records-note inline-error" role="alert">{t("records.loadFailed")}</p>
          ) : list.status === "ready" && records.length === 0 ? (
            <p className="records-note">{t("records.empty")}</p>
          ) : (
            <div
              ref={listRef}
              role="listbox"
              aria-label={t("records.title")}
              className="records-list"
              onKeyDown={onListKeyDown}
            >
              {records.map((record) => {
                const key = recordKey(record);
                return (
                  <div
                    key={key}
                    role="option"
                    aria-selected={key === selectedKey}
                    tabIndex={key === tabStopKey ? 0 : -1}
                    data-record-key={key}
                    className={`records-row${key === selectedKey ? " records-row--selected" : ""}`}
                    onClick={() => select(record)}
                    onFocus={() => select(record)}
                  >
                    <div className="records-row__meta">
                      <span>{timeFormat.format(new Date(record.time))}</span>
                      <span className={LEVEL_PILLS[record.level]}>{t(LEVEL_LABELS[record.level])}</span>
                      {record.kind === "provider-call" ? <span className="pill">{t(KIND_LABELS[record.kind])}</span> : null}
                    </div>
                    <div className="records-row__title">{record.title}</div>
                    {record.text ? <div className="records-row__text">{record.text}</div> : null}
                  </div>
                );
              })}
            </div>
          )}
          {list.status === "ready" && list.moreFailed ? (
            <p className="records-note inline-error" role="alert">{t("records.loadFailed")}</p>
          ) : null}
          {list.status === "ready" && list.more ? (
            <div className="records-more">
              <button type="button" className="button" onClick={showMore} disabled={list.loadingMore}>
                {t("records.showMore")}
              </button>
            </div>
          ) : null}
        </div>
      </section>
      <section className="panel records-detail-pane" aria-busy={detail.status === "loading"}>
        {detail.status === "ready" ? (
          <RecordDetailView record={detail.record} cards={sources?.cards ?? []} launchLabel={launchLabel} />
        ) : (
          <p className={`records-note${detail.status === "failed" ? " inline-error" : ""}`}>
            {detail.status === "failed" ? t("records.detailFailed") : detail.status === "none" ? t("records.noSelection") : null}
          </p>
        )}
      </section>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  allLabel,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  allLabel: string;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
}): ReactElement {
  // A chosen value the sources no longer list stays selectable until changed.
  const shown = value === null || options.some((option) => option.value === value)
    ? options
    : [{ value, label: value }, ...options];
  return (
    <div className="field">
      <select
        aria-label={label}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      >
        <option value="">{allLabel}</option>
        {shown.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}

function RecordDetailView({
  record,
  cards,
  launchLabel,
}: {
  record: RecordDetail;
  cards: RecordSources["cards"];
  launchLabel: (session: string) => string;
}): ReactElement {
  const { t, seconds, number, locale } = useI18n();
  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
      }),
    [locale],
  );
  const time = (value: string): string => timeFormat.format(new Date(value));
  const cardName = record.cardId === null ? null : (cards.find((card) => card.cardId === record.cardId)?.name ?? null);
  const level: RecordLevel = record.kind === "log" ? record.level : record.error === null ? "info" : "error";

  const fields: { label: string; value: ReactNode }[] = [];
  const add = (label: string, value: ReactNode | null): void => {
    if (value !== null) fields.push({ label, value });
  };
  if (record.kind === "log") {
    add(t("records.time"), time(record.time));
    add(t("records.operation"), <code>{record.op}</code>);
  } else {
    add(t("records.started"), time(record.startedAt));
    add(t("records.finished"), time(record.finishedAt));
    add(t("records.duration"), seconds(durationSeconds(record.startedAt, record.finishedAt), { fractionDigits: 3 }));
    add(t("records.provider"), <code>{record.provider}</code>);
    add(t("records.operation"), <code>{record.operation}</code>);
    add(t("records.model"), record.model === null ? null : <code>{record.model}</code>);
    add(t("records.endpoint"), record.endpoint === null ? null : <code>{record.endpoint}</code>);
    if (record.step !== null) {
      const key = stepLabel(record.step);
      add(t("records.step"), key === null ? <code>{record.step}</code> : t(key));
    }
    add(t("records.attempt"), record.attempt === null ? null : number(record.attempt));
  }
  add(
    t("records.recording"),
    record.cardId === null ? null : (
      <>
        {cardName === null ? null : <span className="records-meta__name">{cardName}</span>}
        <code>{record.cardId}</code>
      </>
    ),
  );
  add(t("records.launch"), launchLabel(record.session));

  const blocks: { label: string; text: string }[] = [];
  if (record.kind === "log") {
    if (record.details !== null) blocks.push({ label: t("records.details"), text: prettyJson(record.details) });
    if (record.error !== null) blocks.push({ label: t("records.error"), text: prettyJson(record.error) });
  } else {
    blocks.push({ label: t("records.request"), text: prettyJson(record.request) });
    if (record.response !== null) blocks.push({ label: t("records.response"), text: prettyJson(record.response) });
    if (record.error !== null) blocks.push({ label: t("records.error"), text: prettyJson(record.error) });
  }

  return (
    <>
      <div className="panel__header records-detail__header">
        <h2 className="records-detail__title">
          {record.kind === "log" ? record.message : `${record.provider} ${record.operation}`}
        </h2>
        <div className="records-detail__pills">
          <span className={LEVEL_PILLS[level]}>{t(LEVEL_LABELS[level])}</span>
          <span className="pill pill--quiet">{t(KIND_LABELS[record.kind])}</span>
        </div>
      </div>
      <div className="records-detail__body" role="region" tabIndex={0} aria-label={t("records.details")}>
        <dl className="meta-list records-meta">
          {fields.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
        {blocks.map((block) => (
          <section key={block.label} className="records-block">
            <h3 className="records-block__label">{block.label}</h3>
            <pre className="records-block__text">{block.text}</pre>
          </section>
        ))}
      </div>
    </>
  );
}
