"use client";
import { useState, useEffect, CSSProperties } from "react";
import AgentChat from "./AgentChat";

// ─── Types ─────────────────────────────────────────────────────────────────
interface TableSchema {
  pk: string;
  sk: string | null;
  gsi: string[];
}

interface DynamoItem extends Record<string, unknown> {}

interface ModalState {
  type: "add" | "edit" | "delete";
  item?: DynamoItem;
}

interface ToastState {
  msg: string;
  type: "success" | "error";
}

interface JsonViewerState {
  column: string;
  value: unknown;
}

// TableMeta holds the approximate stats returned by DescribeTable.
// NOTE: AWS updates itemCount and tableSize every ~6 hours — not real-time.
interface TableMeta {
  itemCount: number;
  sizeBytes: number;
}

type SortDir = "asc" | "desc";
type DynamoKey = Record<string, unknown>;

interface FetchItemsResult {
  items: DynamoItem[];
  lastKey: DynamoKey | null;
}

// ─── API Helpers ───────────────────────────────────────────────────────────

async function fetchTables(): Promise<string[]> {
  const res = await fetch("/api/tables");
  if (!res.ok) throw new Error("Failed to fetch tables");
  const data: { tables: string[] } = await res.json();
  return data.tables;
}

async function fetchSchema(tableName: string): Promise<TableSchema> {
  const res = await fetch(`/api/tables/${encodeURIComponent(tableName)}`);
  if (!res.ok) throw new Error(`Failed to fetch schema for ${tableName}`);
  return res.json() as Promise<TableSchema>;
}

// Fetches approximate itemCount + sizeBytes from DescribeTable.
// AWS refreshes these every ~6 hours so we display them with a "~" prefix.
async function fetchTableMeta(tableName: string): Promise<TableMeta> {
  const res = await fetch(`/api/tables/${encodeURIComponent(tableName)}/meta`);
  if (!res.ok) throw new Error(`Failed to fetch meta for ${tableName}`);
  return res.json() as Promise<TableMeta>;
}

// Supports optional ExclusiveStartKey (pagination) and a search term.
// When searchTerm is provided, the API applies a server-side FilterExpression
// scanning ALL records for any attribute containing the term.
async function fetchItems(
  tableName: string,
  exclusiveStartKey?: DynamoKey | null,
  limit: number = 25,
  searchTerm?: string,
): Promise<FetchItemsResult> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (exclusiveStartKey) {
    params.set("startKey", encodeURIComponent(JSON.stringify(exclusiveStartKey)));
  }
  if (searchTerm && searchTerm.trim()) {
    params.set("search", searchTerm.trim());
  }
  const res = await fetch(`/api/tables/${encodeURIComponent(tableName)}/items?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch items for ${tableName}`);
  const data: { items: DynamoItem[]; lastKey: DynamoKey | null } = await res.json();
  return data;
}

async function putItem(tableName: string, item: DynamoItem): Promise<void> {
  const res = await fetch(`/api/tables/${encodeURIComponent(tableName)}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item),
  });
  if (!res.ok) throw new Error("Failed to save item");
}

async function deleteItem(tableName: string, key: DynamoItem): Promise<void> {
  const res = await fetch(`/api/tables/${encodeURIComponent(tableName)}/items`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) throw new Error("Failed to delete item");
}

// ─── Icon Component ────────────────────────────────────────────────────────
interface IconProps {
  d: string;
  size?: number;
  className?: string;
}

const Icon = ({ d, size = 16, className = "" }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d={d} />
  </svg>
);

const icons: Record<string, string> = {
  table: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18",
  plus: "M12 5v14M5 12h14",
  edit: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  search: "M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z",
  refresh: "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
  close: "M18 6L6 18M6 6l12 12",
  check: "M20 6L9 17l-5-5",
  key: "M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4",
};

// ─── Helpers ───────────────────────────────────────────────────────────────

// Returns all attribute names found across the current page of items,
// with PK and SK always pinned to the first two positions.
const getColumns = (items: DynamoItem[], pk: string, sk: string | null): string[] => {
  if (!items?.length) return [];
  const all = new Set<string>();
  items.forEach((item) => Object.keys(item).forEach((k) => all.add(k)));
  all.delete(pk);
  if (sk) all.delete(sk);
  return [pk, ...(sk ? [sk] : []), ...all];
};

const OBJECT_PREVIEW_CHAR_LIMIT = 90;

const stringifyValue = (v: unknown, pretty = false): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v, null, pretty ? 2 : 0);
    } catch {
      return "[Unserializable Object]";
    }
  }
  return String(v);
};

const truncateValue = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}...` : value);

const isObjectLike = (v: unknown): boolean => typeof v === "object" && v !== null;

const formatVal = (v: unknown): React.ReactNode => {
  if (v === null || v === undefined) return <span style={{ color: "#555" }}>null</span>;
  if (isObjectLike(v)) return <span style={{ color: "#a7f3d0" }}>{truncateValue(stringifyValue(v), OBJECT_PREVIEW_CHAR_LIMIT)}</span>;
  if (typeof v === "boolean") return <span style={{ color: v ? "#4ade80" : "#f87171" }}>{String(v)}</span>;
  if (typeof v === "number") return <span style={{ color: "#67e8f9" }}>{v}</span>;
  if (typeof v === "string" && v.match(/^\d{4}-\d{2}-\d{2}/)) return <span style={{ color: "#c4b5fd" }}>{v}</span>;
  return String(v);
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// ─── Main Component ────────────────────────────────────────────────────────
export default function DynamoStudio() {
  const [tables, setTables] = useState<string[]>([]);
  const [activeTable, setActiveTable] = useState<string>("");
  const [schema, setSchema] = useState<TableSchema>({ pk: "", sk: null, gsi: [] });
  const [items, setItems] = useState<DynamoItem[]>([]);
  const [tableMeta, setTableMeta] = useState<TableMeta | null>(null);

  // searchInput  = live value being typed
  // activeSearch = committed term currently applied to the DynamoDB scan
  const [searchInput, setSearchInput] = useState<string>("");
  const [activeSearch, setActiveSearch] = useState<string>("");
  const [isSearching, setIsSearching] = useState<boolean>(false);

  const [modal, setModal] = useState<ModalState | null>(null);
  const [jsonViewer, setJsonViewer] = useState<JsonViewerState | null>(null);
  const [formData, setFormData] = useState<DynamoItem>({});
  const [toast, setToast] = useState<ToastState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [tablesLoading, setTablesLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [selectedRows, setSelectedRows] = useState<Set<unknown>>(new Set());
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [awsRegion, setAwsRegion] = useState<string>("");
  const [agentOpen, setAgentOpen] = useState<boolean>(false);

  // ── Pagination ────────────────────────────────────────────────────────────
  const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
  const [pageSize, setPageSize] = useState<number>(25);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [cursorStack, setCursorStack] = useState<(DynamoKey | null)[]>([null]);
  const [lastKey, setLastKey] = useState<DynamoKey | null>(null);

  const columns: string[] = getColumns(items, schema.pk, schema.sk);

  // Approximate total pages — only meaningful outside of an active search
  const approxTotalPages = tableMeta && !activeSearch ? Math.max(1, Math.ceil(tableMeta.itemCount / pageSize)) : null;

  const showToast = (msg: string, type: ToastState["type"] = "success"): void => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  };

  // ── On mount: load tables + region ───────────────────────────────────────
  useEffect(() => {
    const init = async (): Promise<void> => {
      try {
        const tableList = await fetchTables();
        setTables(tableList);
        if (tableList.length > 0) await switchTable(tableList[0]);
      } catch (err) {
        showToast("Failed to connect to DynamoDB", "error");
        console.error(err);
      } finally {
        setTablesLoading(false);
      }
    };
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch("/api/region")
      .then((r) => r.json())
      .then((d: { region?: string }) => setAwsRegion(d.region ?? ""))
      .catch(() => {});
  }, []);

  // ── Switch table ──────────────────────────────────────────────────────────
  const switchTable = async (t: string): Promise<void> => {
    setLoading(true);
    setActiveTable(t);
    setSearchInput("");
    setActiveSearch("");
    setSelectedRows(new Set());
    setSortCol(null);
    setCurrentPage(1);
    setCursorStack([null]);
    setLastKey(null);
    setTableMeta(null);
    try {
      const [schemaData, result, meta] = await Promise.all([fetchSchema(t), fetchItems(t, null, pageSize), fetchTableMeta(t)]);
      setSchema(schemaData);
      setItems(result.items);
      setLastKey(result.lastKey);
      setTableMeta(meta);
    } catch (err) {
      showToast(`Failed to load ${t}`, "error");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // ── Commit search — full table server-side scan with FilterExpression ─────
  const commitSearch = async (): Promise<void> => {
    const term = searchInput.trim();
    setActiveSearch(term);
    setIsSearching(true);
    setLoading(true);
    setCurrentPage(1);
    setCursorStack([null]);
    setSelectedRows(new Set());
    try {
      const result = await fetchItems(activeTable, null, pageSize, term || undefined);
      setItems(result.items);
      setLastKey(result.lastKey);
    } catch (err) {
      showToast("Search failed", "error");
      console.error(err);
    } finally {
      setLoading(false);
      setIsSearching(false);
    }
  };

  // ── Clear search ──────────────────────────────────────────────────────────
  const clearSearch = async (): Promise<void> => {
    setSearchInput("");
    setActiveSearch("");
    setLoading(true);
    setCurrentPage(1);
    setCursorStack([null]);
    setSelectedRows(new Set());
    try {
      const result = await fetchItems(activeTable, null, pageSize);
      setItems(result.items);
      setLastKey(result.lastKey);
    } catch (err) {
      showToast("Failed to reload table", "error");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") commitSearch();
  };

  // ── Next page ─────────────────────────────────────────────────────────────
  const goNextPage = async (): Promise<void> => {
    if (!lastKey) return;
    setLoading(true);
    setSelectedRows(new Set());
    try {
      const result = await fetchItems(activeTable, lastKey, pageSize, activeSearch || undefined);
      setCursorStack((prev) => [...prev, lastKey]);
      setCurrentPage((p) => p + 1);
      setItems(result.items);
      setLastKey(result.lastKey);
    } catch (err) {
      showToast("Failed to load next page", "error");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // ── Prev page ─────────────────────────────────────────────────────────────
  const goPrevPage = async (): Promise<void> => {
    if (currentPage <= 1) return;
    setLoading(true);
    setSelectedRows(new Set());
    try {
      const prevStack = cursorStack.slice(0, -1);
      const prevCursor = prevStack[prevStack.length - 1];
      const result = await fetchItems(activeTable, prevCursor, pageSize, activeSearch || undefined);
      setCursorStack(prevStack);
      setCurrentPage((p) => p - 1);
      setItems(result.items);
      setLastKey(result.lastKey);
    } catch (err) {
      showToast("Failed to load previous page", "error");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // ── Change page size ──────────────────────────────────────────────────────
  const changePageSize = async (size: number): Promise<void> => {
    setPageSize(size);
    setLoading(true);
    setCurrentPage(1);
    setCursorStack([null]);
    setSelectedRows(new Set());
    try {
      const result = await fetchItems(activeTable, null, size, activeSearch || undefined);
      setItems(result.items);
      setLastKey(result.lastKey);
    } catch (err) {
      showToast("Failed to reload table", "error");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // Client-side sort of the current page only
  const sorted: DynamoItem[] = sortCol
    ? [...items].sort((a, b) => {
        const av = a[sortCol],
          bv = b[sortCol];
        const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      })
    : items;

  const handleSort = (col: string): void => {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const rowKey = (item: DynamoItem): string => String(item[schema.pk]) + (schema.sk ? `|${item[schema.sk]}` : "");

  const openAdd = (): void => {
    const blank: DynamoItem = {};
    columns.forEach((c) => (blank[c] = ""));
    setFormData(blank);
    setModal({ type: "add" });
  };

  const openEdit = (item: DynamoItem): void => {
    setFormData({ ...item });
    setModal({ type: "edit", item });
  };

  const openDelete = (item: DynamoItem): void => setModal({ type: "delete", item });

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      await putItem(activeTable, formData);
      await switchTable(activeTable);
      showToast(modal?.type === "add" ? "Item created successfully" : "Item updated successfully");
      setModal(null);
    } catch (err) {
      showToast("Failed to save item", "error");
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!modal?.item) return;
    setSaving(true);
    try {
      const key: DynamoItem = { [schema.pk]: modal.item[schema.pk] };
      if (schema.sk) key[schema.sk] = modal.item[schema.sk];
      await deleteItem(activeTable, key);
      await switchTable(activeTable);
      showToast("Item deleted", "error");
      setModal(null);
    } catch (err) {
      showToast("Failed to delete item", "error");
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleBulkDelete = async (): Promise<void> => {
    setSaving(true);
    const count = selectedRows.size;
    try {
      const targets = sorted.filter((i) => selectedRows.has(rowKey(i)));
      await Promise.all(
        targets.map((item) => {
          const key: DynamoItem = { [schema.pk]: item[schema.pk] };
          if (schema.sk) key[schema.sk] = item[schema.sk];
          return deleteItem(activeTable, key);
        }),
      );
      setSelectedRows(new Set());
      await switchTable(activeTable);
      showToast(`${count} items deleted`, "error");
    } catch (err) {
      showToast("Failed to delete some items", "error");
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const toggleRow = (id: unknown): void => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = (): void => {
    if (selectedRows.size === sorted.length) setSelectedRows(new Set());
    else setSelectedRows(new Set(sorted.map(rowKey)));
  };

  return (
    <div style={s.root}>
      {/* ── Sidebar ── */}
      <aside style={s.sidebar}>
        <div style={s.logo}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#80FF00" strokeWidth="2">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v4c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
            <path d="M3 9v4c0 1.66 4.03 3 9 3s9-1.34 9-3V9" />
            <path d="M3 13v4c0 1.66 4.03 3 9 3s9-1.34 9-3v-4" />
          </svg>
          <span style={s.logoText}>DynamoStudio</span>
        </div>

        <div style={s.sideSection}>
          <div style={s.sideSectionLabel}>TABLES ({tables.length})</div>
          {tablesLoading ? (
            <div style={{ padding: "12px 8px", display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ ...s.spinner, width: 12, height: 12, borderWidth: 1.5 }} />
              <span style={{ fontSize: 11, color: "#444" }}>Connecting...</span>
            </div>
          ) : tables.length === 0 ? (
            <div style={{ padding: "12px 8px", fontSize: 11, color: "#444" }}>No tables found</div>
          ) : (
            tables.map((t) => (
              <button
                key={t}
                onClick={() => switchTable(t)}
                disabled={loading}
                style={{ ...s.tableBtn, ...(activeTable === t ? s.tableBtnActive : {}) }}
              >
                <Icon d={icons.table} size={14} />
                <span style={{ marginLeft: 8 }}>{t}</span>
              </button>
            ))
          )}
        </div>

        <div style={{ marginTop: "auto", padding: "16px 12px", borderTop: "1px solid #1e1e1e" }}>
          {tableMeta && (
            <div style={s.sidebarMeta}>
              <span style={s.sidebarMetaVal}>~{tableMeta.itemCount.toLocaleString()}</span>
              <span style={s.sidebarMetaLabel}>records</span>
              <span style={s.sidebarMetaDot}>·</span>
              <span style={s.sidebarMetaVal}>{formatBytes(tableMeta.sizeBytes)}</span>
            </div>
          )}
          <div style={{ ...s.connBadge, marginTop: tableMeta ? 8 : 0 }}>
            <div style={s.connDot} />
            <span style={{ fontSize: 11, color: "#666" }}>{awsRegion ? `${awsRegion} · dynamodb` : "unknown · dynamodb"}</span>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <main style={s.main}>
        {/* Header */}
        <header style={s.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 style={s.tableName}>{activeTable}</h1>
            <div style={s.schemaTag}>
              <Icon d={icons.key} size={12} />
              <span style={{ marginLeft: 4 }}>{schema.pk}</span>
              {schema.sk && (
                <>
                  <span style={{ margin: "0 4px", color: "#444" }}>/</span>
                  <span>{schema.sk}</span>
                </>
              )}
            </div>
            {schema.gsi.length > 0 && <div style={{ ...s.schemaTag, background: "#1a1a2e", color: "#818cf8" }}>GSI: {schema.gsi.join(", ")}</div>}
            {/* Approximate record count — shown with ~ and tooltip to explain */}
            {tableMeta && (
              <div style={s.recordCountBadge} title="Approximate count from DescribeTable. AWS refreshes this every ~6 hours.">
                ~{tableMeta.itemCount.toLocaleString()} records
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button style={s.btnSecondary} onClick={() => switchTable(activeTable)} disabled={loading}>
              <Icon d={icons.refresh} size={14} />
              <span style={{ marginLeft: 6 }}>Refresh</span>
            </button>
            <button style={s.btnPrimary} onClick={openAdd}>
              <Icon d={icons.plus} size={14} />
              <span style={{ marginLeft: 6 }}>Add Item</span>
            </button>
            <button
              style={{ ...s.btnSecondary, ...(agentOpen ? s.btnAgentActive : {}) }}
              onClick={() => setAgentOpen((v) => !v)}
              title="Open AI Assistant"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
              <span style={{ marginLeft: 6 }}>Ask AI</span>
            </button>
          </div>
        </header>

        {/* Toolbar */}
        <div style={s.toolbar}>
          {/* Full-table search — commits on Enter or Search button click */}
          <div style={s.searchWrap}>
            <input
              style={{ ...s.searchInput, ...(activeSearch ? s.searchInputActive : {}) }}
              placeholder={
                schema.pk ? `Search by PK (${schema.pk})${schema.sk ? ` or SK (${schema.sk})` : ""} — press Enter` : "Search by PK / SK..."
              }
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            {activeSearch && (
              <button style={s.searchClearBtn} onClick={clearSearch} title="Clear search">
                <Icon d={icons.close} size={12} />
              </button>
            )}
            <button style={{ ...s.searchBtn, ...(isSearching ? s.searchBtnActive : {}) }} onClick={commitSearch} disabled={isSearching || loading}>
              {isSearching ? <div style={{ ...s.spinner, width: 11, height: 11, borderWidth: 1.5 }} /> : <Icon d={icons.search} size={13} />}
              <span style={{ marginLeft: 5 }}>{isSearching ? "Searching..." : "Search"}</span>
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {/* "25 items on page 1 of ~12" */}
            <span style={s.countLabel}>
              {items.length} item{items.length !== 1 ? "s" : ""} on page {currentPage}
              {approxTotalPages !== null ? <span style={{ color: "#3a3a3a" }}> of ~{approxTotalPages}</span> : null}
              {activeSearch && <span style={s.searchPill}>"{activeSearch}"</span>}
            </span>
            {selectedRows.size > 0 && (
              <button style={s.btnDanger} onClick={handleBulkDelete}>
                <Icon d={icons.trash} size={13} />
                <span style={{ marginLeft: 5 }}>Delete {selectedRows.size}</span>
              </button>
            )}
          </div>
        </div>

        {/* Table */}
        <div style={s.tableWrap}>
          {loading ? (
            <div style={s.loadingState}>
              <div style={s.spinner} />
              <span style={{ color: "#555", marginTop: 12, fontSize: 13 }}>
                {isSearching ? `Searching ${activeTable}...` : `Loading ${activeTable}...`}
              </span>
            </div>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={{ ...s.th, width: 40 }}>
                    <input
                      type="checkbox"
                      style={s.checkbox}
                      checked={selectedRows.size === sorted.length && sorted.length > 0}
                      onChange={toggleAll}
                    />
                  </th>
                  {columns.map((col) => (
                    <th key={col} style={{ ...s.th, cursor: "pointer" }} onClick={() => handleSort(col)}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={col === schema.pk || col === schema.sk ? { color: "#80FF00" } : {}}>{col}</span>
                        {col === schema.pk && <span style={s.pkBadge}>PK</span>}
                        {col === schema.sk && <span style={s.skBadge}>SK</span>}
                        {sortCol === col && <span style={{ color: "#80FF00", fontSize: 10 }}>{sortDir === "asc" ? "↑" : "↓"}</span>}
                      </div>
                    </th>
                  ))}
                  <th style={{ ...s.th, width: 100, textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td colSpan={columns.length + 2} style={s.emptyCell}>
                      {activeSearch ? `No records found matching "${activeSearch}"` : "No items found"}
                    </td>
                  </tr>
                ) : (
                  sorted.map((item, idx) => {
                    const rk = rowKey(item);
                    const isSelected = selectedRows.has(rk);
                    return (
                      <tr key={rk ?? idx} style={{ ...s.tr, ...(isSelected ? s.trSelected : {}) }}>
                        <td style={s.td}>
                          <input type="checkbox" style={s.checkbox} checked={isSelected} onChange={() => toggleRow(rk)} />
                        </td>
                        {columns.map((col) => (
                          <td key={col} style={s.td}>
                            {isObjectLike(item[col]) ? (
                              <button style={s.cellJsonBtn} onClick={() => setJsonViewer({ column: col, value: item[col] })} title="View full JSON">
                                <span style={s.cellVal}>{formatVal(item[col])}</span>
                              </button>
                            ) : (
                              <span style={s.cellVal}>{formatVal(item[col])}</span>
                            )}
                          </td>
                        ))}
                        <td style={{ ...s.td, textAlign: "right" }}>
                          <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                            <button style={s.iconBtn} onClick={() => openEdit(item)} title="Edit">
                              <Icon d={icons.edit} size={13} />
                            </button>
                            <button style={{ ...s.iconBtn, ...s.iconBtnDanger }} onClick={() => openDelete(item)} title="Delete">
                              <Icon d={icons.trash} size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination Footer */}
        <div style={s.statusBar}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ color: "#444", fontSize: 11 }}>
              {activeTable} · {columns.length} attributes
              {tableMeta && <span style={{ color: "#333" }}> · ~{tableMeta.itemCount.toLocaleString()} records total</span>}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#3a3a3a", fontSize: 11 }}>Rows per page:</span>
              <select value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))} style={s.pageSizeSelect}>
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "#444", fontSize: 11 }}>
              Page {currentPage}
              {approxTotalPages !== null ? ` of ~${approxTotalPages}` : ""}
              {" · "}
              {items.length} shown
              {lastKey ? " · more available" : ""}
            </span>
            <button
              style={{ ...s.pageBtn, ...(currentPage <= 1 ? s.pageBtnDisabled : {}) }}
              onClick={goPrevPage}
              disabled={currentPage <= 1 || loading}
              title="Previous page"
            >
              ←
            </button>
            <span style={s.pageNum}>{currentPage}</span>
            <button
              style={{ ...s.pageBtn, ...(!lastKey ? s.pageBtnDisabled : {}) }}
              onClick={goNextPage}
              disabled={!lastKey || loading}
              title="Next page"
            >
              →
            </button>
          </div>
        </div>
      </main>

      {/* ── CRUD Modals ── */}
      {modal && (
        <div style={s.overlay} onClick={() => setModal(null)}>
          <div style={s.modal} onClick={(e) => e.stopPropagation()}>
            {(modal.type === "add" || modal.type === "edit") && (
              <>
                <div style={s.modalHeader}>
                  <h2 style={s.modalTitle}>{modal.type === "add" ? "Add New Item" : "Edit Item"}</h2>
                  <button style={s.modalClose} onClick={() => setModal(null)}>
                    <Icon d={icons.close} size={16} />
                  </button>
                </div>
                <div style={s.modalBody}>
                  {columns.map((col) => (
                    <div key={col} style={s.formRow}>
                      <label style={s.formLabel}>
                        {col}
                        {col === schema.pk && <span style={s.pkBadge}>PK</span>}
                        {col === schema.sk && <span style={s.skBadge}>SK</span>}
                      </label>
                      <input
                        style={s.formInput}
                        value={String(formData[col] ?? "")}
                        onChange={(e) => setFormData((prev) => ({ ...prev, [col]: e.target.value }))}
                        placeholder={`Enter ${col}...`}
                      />
                    </div>
                  ))}
                </div>
                <div style={s.modalFooter}>
                  <button style={s.btnSecondary} onClick={() => setModal(null)} disabled={saving}>
                    Cancel
                  </button>
                  <button style={s.btnPrimary} onClick={handleSave} disabled={saving}>
                    {saving ? <div style={{ ...s.spinner, width: 12, height: 12, borderWidth: 1.5 }} /> : <Icon d={icons.check} size={14} />}
                    <span style={{ marginLeft: 6 }}>{saving ? "Saving..." : modal.type === "add" ? "Create Item" : "Save Changes"}</span>
                  </button>
                </div>
              </>
            )}
            {modal.type === "delete" && modal.item && (
              <>
                <div style={s.modalHeader}>
                  <h2 style={{ ...s.modalTitle, color: "#f87171" }}>Delete Item</h2>
                  <button style={s.modalClose} onClick={() => setModal(null)}>
                    <Icon d={icons.close} size={16} />
                  </button>
                </div>
                <div style={s.modalBody}>
                  <p style={{ color: "#999", fontSize: 14, marginBottom: 16 }}>
                    This action cannot be undone. The following item will be permanently deleted:
                  </p>
                  <div style={s.deletePreview}>
                    {Object.entries(modal.item)
                      .slice(0, 5)
                      .map(([k, v]) => (
                        <div key={k} style={s.deleteRow}>
                          <span style={{ color: "#555" }}>{k}</span>
                          <span style={{ color: "#ccc" }}>{truncateValue(stringifyValue(v), 100)}</span>
                        </div>
                      ))}
                  </div>
                </div>
                <div style={s.modalFooter}>
                  <button style={s.btnSecondary} onClick={() => setModal(null)} disabled={saving}>
                    Cancel
                  </button>
                  <button style={s.btnDanger} onClick={handleDelete} disabled={saving}>
                    {saving ? <div style={{ ...s.spinner, width: 12, height: 12, borderWidth: 1.5 }} /> : <Icon d={icons.trash} size={14} />}
                    <span style={{ marginLeft: 6 }}>{saving ? "Deleting..." : "Delete Item"}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── JSON Viewer ── */}
      {jsonViewer && (
        <div style={s.overlay} onClick={() => setJsonViewer(null)}>
          <div style={{ ...s.modal, width: 700, maxWidth: "92vw" }} onClick={(e) => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <h2 style={s.modalTitle}>JSON Value: {jsonViewer.column}</h2>
              <button style={s.modalClose} onClick={() => setJsonViewer(null)}>
                <Icon d={icons.close} size={16} />
              </button>
            </div>
            <div style={s.modalBody}>
              <pre style={s.jsonViewer}>{stringifyValue(jsonViewer.value, true)}</pre>
            </div>
            <div style={s.modalFooter}>
              <button style={s.btnSecondary} onClick={() => setJsonViewer(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast ── */}
      {toast && (
        <div
          style={{
            ...s.toast,
            background: toast.type === "error" ? "#2d1515" : "#0f2d1a",
            borderColor: toast.type === "error" ? "#f87171" : "#4ade80",
          }}
        >
          <div style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: toast.type === "error" ? "#f87171" : "#4ade80" }} />
          <span style={{ color: toast.type === "error" ? "#f87171" : "#4ade80", fontSize: 13 }}>{toast.msg}</span>
        </div>
      )}

      {/* ── AI Agent Chat ── */}
      {agentOpen && <AgentChat key={activeTable || "no-table"} activeTable={activeTable} schema={schema} onClose={() => setAgentOpen(false)} />}

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #0a0a0a; }
        ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 3px; }
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&family=Syne:wght@400;500;600;700&display=swap');
        @keyframes fadeIn { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform: translateY(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideIn { from { opacity:0; transform: translateX(20px); } to { opacity:1; transform: translateX(0); } }
        tr:hover td { background: #141414 !important; }
      `}</style>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────
const s: Record<string, CSSProperties> = {
  root: { display: "flex", height: "100vh", background: "#0a0a0a", fontFamily: "'JetBrains Mono', monospace", color: "#e0e0e0", overflow: "hidden" },
  sidebar: { width: 220, background: "#0d0d0d", borderRight: "1px solid #1a1a1a", display: "flex", flexDirection: "column", flexShrink: 0 },
  logo: { display: "flex", alignItems: "center", gap: 10, padding: "18px 16px 14px", borderBottom: "1px solid #1a1a1a" },
  logoText: { fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 15, color: "#f0f0f0", letterSpacing: "-0.3px" },
  sideSection: { padding: "12px 8px", flex: 1, overflowY: "auto" },
  sideSectionLabel: { fontSize: 9, fontWeight: 600, color: "#3a3a3a", letterSpacing: "1.5px", padding: "4px 8px 8px" },
  sidebarMeta: { display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" },
  sidebarMetaVal: { fontSize: 11, color: "#666" },
  sidebarMetaLabel: { fontSize: 10, color: "#444" },
  sidebarMetaDot: { fontSize: 10, color: "#333" },
  tableBtn: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    paddingTop: 7,
    paddingBottom: 7,
    paddingLeft: 8,
    paddingRight: 8,
    borderRadius: 5,
    borderTop: "none",
    borderRight: "none",
    borderBottom: "none",
    borderLeft: "2px solid transparent",
    background: "transparent",
    color: "#666",
    cursor: "pointer",
    fontSize: 12,
    transition: "all 0.15s",
    fontFamily: "inherit",
  },
  tableBtnActive: { background: "#1a1a1a", color: "#f0f0f0", borderLeft: "2px solid #80FF00", paddingLeft: 6 },
  connBadge: { display: "flex", alignItems: "center", gap: 7 },
  connDot: { width: 7, height: 7, borderRadius: "50%", background: "#4ade80", boxShadow: "0 0 6px #4ade80" },
  recordCountBadge: {
    fontSize: 10,
    color: "#888",
    background: "#141414",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#222",
    borderRadius: 4,
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 8,
    paddingRight: 8,
    cursor: "default",
  },
  main: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 24px",
    borderBottom: "1px solid #1a1a1a",
    background: "#0d0d0d",
    flexShrink: 0,
  },
  tableName: { fontFamily: "'Syne', sans-serif", fontSize: 20, fontWeight: 700, color: "#f0f0f0", letterSpacing: "-0.5px" },
  schemaTag: {
    display: "flex",
    alignItems: "center",
    fontSize: 11,
    color: "#80FF00",
    background: "#001c0b",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#002a0a",
    padding: "2px 8px",
    borderRadius: 4,
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 24px",
    borderBottom: "1px solid #141414",
    flexShrink: 0,
    gap: 12,
  },
  searchWrap: { display: "flex", alignItems: "center", gap: 6, flex: 1, maxWidth: 520, position: "relative" },
  searchInput: {
    flex: 1,
    padding: "7px 10px",
    background: "#111",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#222",
    borderRadius: 6,
    color: "#e0e0e0",
    fontSize: 12,
    fontFamily: "inherit",
    outline: "none",
  },
  searchInputActive: { borderColor: "#80FF00", background: "#011400" },
  searchClearBtn: {
    background: "none",
    borderWidth: 0,
    color: "#80FF00",
    cursor: "pointer",
    paddingTop: 4,
    paddingBottom: 4,
    paddingLeft: 4,
    paddingRight: 4,
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
  },
  searchBtn: {
    display: "flex",
    alignItems: "center",
    paddingTop: 7,
    paddingBottom: 7,
    paddingLeft: 12,
    paddingRight: 12,
    borderRadius: 6,
    background: "#1a1a1a",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#2a2a2a",
    color: "#aaa",
    fontSize: 12,
    fontFamily: "inherit",
    cursor: "pointer",
    transition: "all 0.15s",
    flexShrink: 0,
    whiteSpace: "nowrap",
  },
  searchBtnActive: { color: "#80FF00", borderColor: "#002a0a", background: "#011400" },
  searchPill: {
    marginLeft: 6,
    fontSize: 10,
    color: "#80FF00",
    background: "#001c0b",
    borderRadius: 10,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 6,
    paddingRight: 6,
  },
  countLabel: { fontSize: 11, color: "#444", whiteSpace: "nowrap" },
  tableWrap: { flex: 1, overflow: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: {
    padding: "9px 16px",
    textAlign: "left",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.8px",
    color: "#444",
    borderBottom: "1px solid #1a1a1a",
    position: "sticky",
    top: 0,
    background: "#0d0d0d",
    userSelect: "none",
    whiteSpace: "nowrap",
  },
  tr: { borderBottom: "1px solid #111", transition: "background 0.1s" },
  trSelected: { background: "#031a00" },
  td: { padding: "8px 16px", verticalAlign: "middle" },
  cellVal: { fontFamily: "'JetBrains Mono', monospace", fontSize: 12 },
  cellJsonBtn: {
    background: "transparent",
    border: "none",
    color: "inherit",
    padding: 0,
    margin: 0,
    cursor: "pointer",
    textAlign: "left",
    maxWidth: "100%",
  },
  pkBadge: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: "0.5px",
    background: "#2d1200",
    color: "#80FF00",
    padding: "1px 5px",
    borderRadius: 3,
    marginLeft: 4,
  },
  skBadge: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: "0.5px",
    background: "#1a1a2e",
    color: "#818cf8",
    padding: "1px 5px",
    borderRadius: 3,
    marginLeft: 4,
  },
  emptyCell: { padding: "48px 16px", textAlign: "center", color: "#333" },
  checkbox: { accentColor: "#80FF00", cursor: "pointer" },
  iconBtn: {
    padding: "5px 7px",
    borderRadius: 4,
    background: "transparent",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#222",
    color: "#555",
    cursor: "pointer",
    transition: "all 0.15s",
    display: "flex",
    alignItems: "center",
  },
  iconBtnDanger: { color: "#7f1d1d" },
  btnPrimary: {
    display: "flex",
    alignItems: "center",
    padding: "7px 14px",
    borderRadius: 6,
    background: "#80FF00",
    border: "none",
    color: "#000",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "all 0.15s",
  },
  btnSecondary: {
    display: "flex",
    alignItems: "center",
    padding: "7px 14px",
    borderRadius: 6,
    background: "transparent",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#2a2a2a",
    color: "#888",
    fontSize: 12,
    fontFamily: "inherit",
    cursor: "pointer",
    transition: "all 0.15s",
  },
  btnAgentActive: { borderColor: "#80FF00", color: "#80FF00", background: "#001c0b" },
  btnDanger: {
    display: "flex",
    alignItems: "center",
    padding: "7px 14px",
    borderRadius: 6,
    background: "#2d1515",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#5a1d1d",
    color: "#f87171",
    fontSize: 12,
    fontFamily: "inherit",
    cursor: "pointer",
    transition: "all 0.15s",
  },
  statusBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "6px 24px",
    borderTop: "1px solid #141414",
    background: "#0a0a0a",
    flexShrink: 0,
    gap: 12,
  },
  pageSizeSelect: {
    background: "#111",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#222",
    borderRadius: 4,
    color: "#888",
    fontSize: 11,
    padding: "2px 4px",
    fontFamily: "'JetBrains Mono', monospace",
    cursor: "pointer",
    outline: "none",
  },
  pageBtn: {
    background: "#111",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#222",
    borderRadius: 4,
    color: "#888",
    fontSize: 13,
    width: 26,
    height: 22,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    transition: "all 0.15s",
    fontFamily: "inherit",
  },
  pageBtnDisabled: { color: "#2a2a2a", cursor: "not-allowed", borderColor: "#181818" },
  pageNum: {
    fontSize: 11,
    color: "#80FF00",
    background: "#001c0b",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#002a0a",
    borderRadius: 4,
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 8,
    paddingRight: 8,
    fontFamily: "'JetBrains Mono', monospace",
  },
  loadingState: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "300px" },
  spinner: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "#1e1e1e",
    borderTop: "2px solid #80FF00",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.7)",
    backdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
    animation: "fadeIn 0.15s ease",
  },
  modal: {
    background: "#111",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#222",
    borderRadius: 10,
    width: 440,
    maxHeight: "80vh",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 25px 60px rgba(0,0,0,0.8)",
    animation: "fadeIn 0.2s ease",
  },
  modalHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "18px 20px 14px",
    borderBottom: "1px solid #1a1a1a",
  },
  modalTitle: { fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700, color: "#f0f0f0" },
  modalClose: { background: "none", border: "none", color: "#555", cursor: "pointer", padding: 4, borderRadius: 4 },
  modalBody: { padding: "16px 20px", overflowY: "auto", flex: 1 },
  modalFooter: { display: "flex", justifyContent: "flex-end", gap: 8, padding: "14px 20px", borderTop: "1px solid #1a1a1a" },
  formRow: { marginBottom: 12 },
  formLabel: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#666", marginBottom: 5, fontWeight: 500, letterSpacing: "0.3px" },
  formInput: {
    width: "100%",
    padding: "8px 10px",
    background: "#0d0d0d",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#222",
    borderRadius: 5,
    color: "#e0e0e0",
    fontSize: 12,
    fontFamily: "inherit",
    outline: "none",
  },
  deletePreview: { background: "#0d0d0d", borderWidth: 1, borderStyle: "solid", borderColor: "#1a1a1a", borderRadius: 6, padding: "10px 14px" },
  deleteRow: { display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 11, borderBottom: "1px solid #141414" },
  jsonViewer: {
    margin: 0,
    fontSize: 12,
    lineHeight: 1.5,
    color: "#d1d5db",
    background: "#0d0d0d",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#1f2937",
    borderRadius: 6,
    padding: 12,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  toast: {
    position: "fixed",
    bottom: 24,
    right: 24,
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 16px",
    borderRadius: 7,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    zIndex: 200,
    animation: "slideIn 0.25s ease",
    fontFamily: "'JetBrains Mono', monospace",
    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
  },
};
