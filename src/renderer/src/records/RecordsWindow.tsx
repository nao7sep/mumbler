import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { loadCatalogue } from "@shared/i18n/catalogues";
import { isLanguage, type InterfaceLanguage } from "@shared/i18n/languages";
import { RECORDS_DETAIL_MIN_WIDTH, RECORDS_GAP, RECORDS_LIST_WIDTH, RECORDS_PADDING } from "@shared/layout";
import {
  RECORD_KINDS,
  RECORD_LEVEL_FILTERS,
  type RecordDetail,
  type RecordKind,
  type RecordLevel,
  type RecordLevelFilter,
  type RecordSources,
  type RecordsQuery,
  type RecordSummary,
} from "@shared/records";

import { currentCompositeIndex, nextIndex, type NavDirection } from "../app/composite-nav";
import { PaneSplitter } from "../app/PaneSplitter";
import { reportRendererDiagnostic } from "../app/presentFailure";
import { usePaneSize } from "../app/usePaneSize";
import { I18nProvider, useI18n } from "../i18n/I18nContext";
import {
  KIND_LABELS,
  LEVEL_FILTER_LABELS,
  LEVEL_LABELS,
  LEVEL_PILLS,
  cursorAfter,
  durationSeconds,
  mergeNewestPage,
  prettyJson,
  recordKey,
  stepLabel,
} from "./record-format";

const ENGLISH: InterfaceLanguage = { language: "en", locale: "en" };

// The records window speaks the interface language from its first text, and
// follows it when Settings changes it in the main window.
export function RecordsApp(): ReactElement {
  const [language, setLanguage] = useState<InterfaceLanguage | null>(null);
  const [listWidth, setListWidth] = useState<number | null>(null);

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

  // The list pane opens at its saved width, so the first frame already has it.
  useEffect(() => {
    let cancelled = false;
    void window.mumbler.getRecordsListWidth().then(
      (width) => {
        if (!cancelled) setListWidth(width);
      },
      (error: unknown) => {
        reportRendererDiagnostic(error, "records list width read failed");
        if (!cancelled) setListWidth(RECORDS_LIST_WIDTH.default);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (language === null || listWidth === null) {
    return <main className="renderer-failure" role="status" aria-busy="true" />;
  }

  return (
    <I18nProvider language={language.language} locale={language.locale}>
      <RecordsWindow initialListWidth={listWidth} />
    </I18nProvider>
  );
}

type Filters = Omit<RecordsQuery, "after">;

const NO_FILTERS: Filters = { session: null, kind: null, level: null, cardId: null, search: "" };
const SEARCH_DELAY_MS = 300;
// New records are read at most this often while they keep arriving.
const LIVE_INTERVAL_MS = 1000;
// The detail pane's minimum plus everything beside the list pane on its row.
const LIST_SIBLING_MIN = RECORDS_PADDING * 2 + RECORDS_GAP + RECORDS_DETAIL_MIN_WIDTH;

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

// Within about one screen of the end of what is loaded.
function nearEnd(scroll: HTMLElement): boolean {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= scroll.clientHeight;
}

function atTop(scroll: HTMLElement): boolean {
  return scroll.scrollTop < 1;
}

export function RecordsWindow({ initialListWidth }: { initialListWidth: number }): ReactElement {
  const { t, locale } = useI18n();
  const [sources, setSources] = useState<RecordSources | null>(null);
  const [sourceReads, setSourceReads] = useState(0);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [searchText, setSearchText] = useState("");
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [selected, setSelected] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "none" });
  const [listWidth, setListWidth] = useState(initialListWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const listGeneration = useRef(0);
  // The busy claim for the next page (PLAYBOOK, Own the work in flight).
  const fetchingMore = useRef(false);
  // The filters the current list was read for, for the live reads below.
  const filtersRef = useRef(filters);
  // New records arrived while the list was scrolled away from the top.
  const newestPending = useRef(false);
  // A failed read is itself logged as a record, whose signal would start the
  // next read; live reads stop after a failure and resume after a read succeeds.
  const liveSuspended = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Pane sizing: window-conventions.
  const { containerRef: shellRef, displayed: shownListWidth } = usePaneSize(dragWidth ?? listWidth, false, {
    siblingMin: LIST_SIBLING_MIN,
    min: RECORDS_LIST_WIDTH.min,
    max: RECORDS_LIST_WIDTH.max,
  });

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
      (error: unknown) => {
        liveSuspended.current = true;
        reportRendererDiagnostic(error, "record sources read failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sourceReads]);

  // A page applies only while the filters it was read for are still the
  // newest ones asked for.
  useEffect(() => {
    filtersRef.current = filters;
    const generation = ++listGeneration.current;
    fetchingMore.current = false;
    newestPending.current = false;
    setList({ status: "loading" });
    void window.mumbler.readRecordsPage({ ...filters, after: null }).then(
      (page) => {
        if (generation !== listGeneration.current) return;
        liveSuspended.current = false;
        setList({ status: "ready", records: page.records, more: page.more, loadingMore: false, moreFailed: false });
      },
      (error: unknown) => {
        if (generation !== listGeneration.current) return;
        liveSuspended.current = true;
        reportRendererDiagnostic(error, "records read failed");
        setList({ status: "failed" });
      },
    );
  }, [filters]);

  // The newest page read again for new records. It joins the rows already
  // shown rather than replacing them, so the list never falls back to the
  // loading note and the pages already read stay. It reads only refs, so one
  // copy serves the live subscription below.
  const readNewest = useCallback((): void => {
    const generation = listGeneration.current;
    void window.mumbler.readRecordsPage({ ...filtersRef.current, after: null }).then(
      (page) => {
        if (generation !== listGeneration.current) return;
        liveSuspended.current = false;
        setList((current) =>
          current.status === "ready"
            ? { ...current, ...mergeNewestPage(current.records, current.more, page) }
            : { status: "ready", records: page.records, more: page.more, loadingMore: false, moreFailed: false },
        );
      },
      (error: unknown) => {
        if (generation !== listGeneration.current) return;
        liveSuspended.current = true;
        reportRendererDiagnostic(error, "records read failed");
      },
    );
  }, []);

  // A stored record reaches the list at once while it is scrolled to the top;
  // otherwise it waits until the list is back there, so the list never moves
  // under the reader.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = window.mumbler.onRecordsChanged(() => {
      if (timer !== null || liveSuspended.current) return;
      timer = setTimeout(() => {
        timer = null;
        setSourceReads((count) => count + 1);
        const scroll = scrollRef.current;
        if (scroll === null || atTop(scroll)) readNewest();
        else newestPending.current = true;
      }, LIVE_INTERVAL_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [readNewest]);

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

  // Loading more: composite-control-conventions, Integration Points. A failed
  // page is read again when the end is reached again.
  const loadMore = (): void => {
    if (list.status !== "ready" || !list.more || fetchingMore.current) return;
    fetchingMore.current = true;
    const generation = listGeneration.current;
    setList((current) => (current.status === "ready" ? { ...current, loadingMore: true, moreFailed: false } : current));
    void window.mumbler.readRecordsPage({ ...filters, after: cursorAfter(list.records) }).then(
      (page) => {
        if (generation !== listGeneration.current) return;
        fetchingMore.current = false;
        liveSuspended.current = false;
        setList((current) =>
          current.status === "ready"
            ? { ...current, records: [...current.records, ...page.records], more: page.more, loadingMore: false }
            : current,
        );
      },
      (error: unknown) => {
        if (generation !== listGeneration.current) return;
        fetchingMore.current = false;
        liveSuspended.current = true;
        reportRendererDiagnostic(error, "records read failed");
        setList((current) => (current.status === "ready" ? { ...current, loadingMore: false, moreFailed: true } : current));
      },
    );
  };

  // A page that leaves the list short of the end reads the next one; a failed
  // page waits for the reader instead.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (list.status !== "ready" || list.loadingMore || list.moreFailed || scroll === null) return;
    if (nearEnd(scroll)) loadMore();
    // Only a new list state can change what is loaded.
  }, [list]);

  const onListScroll = (): void => {
    const scroll = scrollRef.current;
    if (scroll === null) return;
    if (newestPending.current && atTop(scroll)) {
      newestPending.current = false;
      readNewest();
    }
    if (nearEnd(scroll)) loadMore();
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
    if (target === keys.length - 1 && (direction === "next" || direction === "page-next" || direction === "last")) {
      loadMore();
    }
  };

  // Drag intent: window-conventions, Content-based minimum size.
  const commitListWidth = (width: number): void => {
    setListWidth(width);
    setDragWidth(null);
    void window.mumbler.saveRecordsListWidth(width).then(setListWidth, (error: unknown) =>
      reportRendererDiagnostic(error, "records list width save failed"),
    );
  };

  const launchLabel = (session: string): string => {
    const time = timeFormat.format(new Date(session));
    return session === sources?.currentSession ? t("records.thisLaunch", { time }) : time;
  };

  return (
    <div
      ref={shellRef}
      className="records-shell"
      style={{ "--records-list-width": `${shownListWidth}px` } as CSSProperties}
    >
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
              options={RECORD_LEVEL_FILTERS.map((level) => ({ value: level, label: t(LEVEL_FILTER_LABELS[level]) }))}
              onChange={(level) => setFilters({ ...filters, level: level as RecordLevelFilter | null })}
            />
          </div>
        </div>
        <div
          ref={scrollRef}
          className="records-list-scroll"
          aria-busy={list.status === "loading"}
          onScroll={onListScroll}
        >
          {list.status === "failed" ? (
            <p className="records-note inline-error" role="alert">{t("records.loadFailed")}</p>
          ) : list.status === "loading" ? (
            <p className="records-note">{t("records.loading")}</p>
          ) : records.length === 0 ? (
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
          {list.status === "ready" && list.loadingMore ? (
            <p className="records-note">{t("records.loading")}</p>
          ) : null}
          {list.status === "ready" && list.moreFailed ? (
            <p className="records-note inline-error" role="alert">{t("records.loadFailed")}</p>
          ) : null}
        </div>
      </section>
      <PaneSplitter
        label={t("records.resizeList")}
        width={shownListWidth}
        min={RECORDS_LIST_WIDTH.min}
        max={RECORDS_LIST_WIDTH.max}
        onResize={setDragWidth}
        onCommit={commitListWidth}
        keyboardStep={16}
      />
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
