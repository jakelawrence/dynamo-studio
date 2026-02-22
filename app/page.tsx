"use client";
import { useState, useEffect, CSSProperties } from "react";
import {
  Bot,
  Check,
  Database,
  Key,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import AgentChat from "../components/AgentChat";
import TableVisualizer from "../components/TableVisualizer";

// DynamoStudio main page:
// - Fetches table metadata/items from API routes
// - Provides item browsing/editing/deleting flows
// - Orchestrates auxiliary overlays (AI assistant + visualizer)

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
  const response = await fetch("/api/tables");
  if (!response.ok) throw new Error("Failed to fetch tables");
  const responseData: { tables: string[] } = await response.json();
  return responseData.tables;
}

async function fetchSchema(tableName: string): Promise<TableSchema> {
  const response = await fetch(`/api/tables/${encodeURIComponent(tableName)}`);
  if (!response.ok) throw new Error(`Failed to fetch schema for ${tableName}`);
  return response.json() as Promise<TableSchema>;
}

// Fetches approximate itemCount + sizeBytes from DescribeTable.
// AWS refreshes these every ~6 hours so we display them with a "~" prefix.
async function fetchTableMeta(tableName: string): Promise<TableMeta> {
  const response = await fetch(`/api/tables/${encodeURIComponent(tableName)}/meta`);
  if (!response.ok) throw new Error(`Failed to fetch meta for ${tableName}`);
  return response.json() as Promise<TableMeta>;
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
  const response = await fetch(`/api/tables/${encodeURIComponent(tableName)}/items?${params}`);
  if (!response.ok) throw new Error(`Failed to fetch items for ${tableName}`);
  const responseData: { items: DynamoItem[]; lastKey: DynamoKey | null } = await response.json();
  return responseData;
}

async function putItem(tableName: string, item: DynamoItem): Promise<void> {
  const response = await fetch(`/api/tables/${encodeURIComponent(tableName)}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item),
  });
  if (!response.ok) throw new Error("Failed to save item");
}

async function deleteItem(tableName: string, key: DynamoItem): Promise<void> {
  const response = await fetch(`/api/tables/${encodeURIComponent(tableName)}/items`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!response.ok) throw new Error("Failed to delete item");
}

// ─── Helpers ───────────────────────────────────────────────────────────────

// Returns all attribute names found across the current page of items,
// with PK and SK always pinned to the first two positions.
const getColumns = (items: DynamoItem[], pk: string, sk: string | null): string[] => {
  if (!items?.length) return [];
  const all = new Set<string>();
  items.forEach((item) => Object.keys(item).forEach((attributeName) => all.add(attributeName)));
  all.delete(pk);
  if (sk) all.delete(sk);
  return [pk, ...(sk ? [sk] : []), ...all];
};

const OBJECT_PREVIEW_CHAR_LIMIT = 90;

const stringifyValue = (value: unknown, pretty = false): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, pretty ? 2 : 0);
    } catch {
      return "[Unserializable Object]";
    }
  }
  return String(value);
};

const truncateValue = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}...` : value);

const isObjectLike = (value: unknown): boolean => typeof value === "object" && value !== null;

const formatVal = (value: unknown): React.ReactNode => {
  if (value === null || value === undefined) return <span style={{ color: "#555" }}>null</span>;
  if (isObjectLike(value)) return <span style={{ color: "#a7f3d0" }}>{truncateValue(stringifyValue(value), OBJECT_PREVIEW_CHAR_LIMIT)}</span>;
  if (typeof value === "boolean") return <span style={{ color: value ? "#4ade80" : "#f87171" }}>{String(value)}</span>;
  if (typeof value === "number") return <span style={{ color: "#67e8f9" }}>{value}</span>;
  if (typeof value === "string" && value.match(/^\d{4}-\d{2}-\d{2}/)) return <span style={{ color: "#c4b5fd" }}>{value}</span>;
  return String(value);
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// ─── Main Component ────────────────────────────────────────────────────────
export default function DynamoStudio() {
  // Data state for the currently selected table and its rows.
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

  // UI interaction state (dialogs, toasts, sorting, selection, overlays).
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
  const [visualizerOpen, setVisualizerOpen] = useState<boolean>(false);
  const [queuedAgentPrompt, setQueuedAgentPrompt] = useState<{ id: string; text: string } | null>(null);

  // ── Pagination ────────────────────────────────────────────────────────────
  const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
  const [pageSize, setPageSize] = useState<number>(25);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [cursorStack, setCursorStack] = useState<(DynamoKey | null)[]>([null]);
  const [lastKey, setLastKey] = useState<DynamoKey | null>(null);

  const columns: string[] = getColumns(items, schema.pk, schema.sk);

  // Approximate total pages — only meaningful outside of an active search
  const approxTotalPages = tableMeta && !activeSearch ? Math.max(1, Math.ceil(tableMeta.itemCount / pageSize)) : null;

  const showToast = (message: string, type: ToastState["type"] = "success"): void => {
    setToast({ msg: message, type });
    setTimeout(() => setToast(null), 2800);
  };

  const askAgentFromVisualizer = (prompt: string): void => {
    setVisualizerOpen(false);
    setAgentOpen(true);
    setQueuedAgentPrompt({ id: `visualizer-${Date.now()}`, text: prompt });
  };

  // ── On mount: load tables + region ───────────────────────────────────────
  useEffect(() => {
    const init = async (): Promise<void> => {
      try {
        const tableList = await fetchTables();
        setTables(tableList);
        if (tableList.length > 0) await switchTable(tableList[0]);
      } catch (error) {
        showToast("Failed to connect to DynamoDB", "error");
        console.error(error);
      } finally {
        setTablesLoading(false);
      }
    };
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch("/api/region")
      .then((regionResponse) => regionResponse.json())
      .then((regionData: { region?: string }) => setAwsRegion(regionData.region ?? ""))
      .catch(() => {});
  }, []);

  // ── Switch table ──────────────────────────────────────────────────────────
  const switchTable = async (tableName: string): Promise<void> => {
    setLoading(true);
    setActiveTable(tableName);
    setSearchInput("");
    setActiveSearch("");
    setSelectedRows(new Set());
    setSortCol(null);
    setCurrentPage(1);
    setCursorStack([null]);
    setLastKey(null);
    setTableMeta(null);
    try {
      const [schemaData, itemsResult, metadata] = await Promise.all([
        fetchSchema(tableName),
        fetchItems(tableName, null, pageSize),
        fetchTableMeta(tableName),
      ]);
      setSchema(schemaData);
      setItems(itemsResult.items);
      setLastKey(itemsResult.lastKey);
      setTableMeta(metadata);
    } catch (error) {
      showToast(`Failed to load ${tableName}`, "error");
      console.error(error);
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
      const itemsResult = await fetchItems(activeTable, null, pageSize, term || undefined);
      setItems(itemsResult.items);
      setLastKey(itemsResult.lastKey);
    } catch (error) {
      showToast("Search failed", "error");
      console.error(error);
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
      const itemsResult = await fetchItems(activeTable, null, pageSize);
      setItems(itemsResult.items);
      setLastKey(itemsResult.lastKey);
    } catch (error) {
      showToast("Failed to reload table", "error");
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleSearchKeyDown = (keyboardEvent: React.KeyboardEvent<HTMLInputElement>): void => {
    if (keyboardEvent.key === "Enter") commitSearch();
  };

  // ── Next page ─────────────────────────────────────────────────────────────
  const goNextPage = async (): Promise<void> => {
    if (!lastKey) return;
    setLoading(true);
    setSelectedRows(new Set());
    try {
      const itemsResult = await fetchItems(activeTable, lastKey, pageSize, activeSearch || undefined);
      setCursorStack((previousCursors) => [...previousCursors, lastKey]);
      setCurrentPage((previousPage) => previousPage + 1);
      setItems(itemsResult.items);
      setLastKey(itemsResult.lastKey);
    } catch (error) {
      showToast("Failed to load next page", "error");
      console.error(error);
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
      const itemsResult = await fetchItems(activeTable, prevCursor, pageSize, activeSearch || undefined);
      setCursorStack(prevStack);
      setCurrentPage((previousPage) => previousPage - 1);
      setItems(itemsResult.items);
      setLastKey(itemsResult.lastKey);
    } catch (error) {
      showToast("Failed to load previous page", "error");
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  // ── Change page size ──────────────────────────────────────────────────────
  const changePageSize = async (nextPageSize: number): Promise<void> => {
    setPageSize(nextPageSize);
    setLoading(true);
    setCurrentPage(1);
    setCursorStack([null]);
    setSelectedRows(new Set());
    try {
      const itemsResult = await fetchItems(activeTable, null, nextPageSize, activeSearch || undefined);
      setItems(itemsResult.items);
      setLastKey(itemsResult.lastKey);
    } catch (error) {
      showToast("Failed to reload table", "error");
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  // Client-side sort of the current page only
  const sorted: DynamoItem[] = sortCol
    ? [...items].sort((leftItem, rightItem) => {
        const leftValue = leftItem[sortCol];
        const rightValue = rightItem[sortCol];
        const comparison =
          typeof leftValue === "number" && typeof rightValue === "number"
            ? leftValue - rightValue
            : String(leftValue).localeCompare(String(rightValue));
        return sortDir === "asc" ? comparison : -comparison;
      })
    : items;

  const handleSort = (columnName: string): void => {
    if (sortCol === columnName) setSortDir((currentDirection) => (currentDirection === "asc" ? "desc" : "asc"));
    else {
      setSortCol(columnName);
      setSortDir("asc");
    }
  };

  // Stable identity per row based on key attributes so selection/edit actions remain deterministic.
  const rowKey = (item: DynamoItem): string => String(item[schema.pk]) + (schema.sk ? `|${item[schema.sk]}` : "");

  const openAdd = (): void => {
    const blank: DynamoItem = {};
    columns.forEach((columnName) => (blank[columnName] = ""));
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
    } catch (error) {
      showToast("Failed to save item", "error");
      console.error(error);
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
    } catch (error) {
      showToast("Failed to delete item", "error");
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  const handleBulkDelete = async (): Promise<void> => {
    setSaving(true);
    const count = selectedRows.size;
    try {
      const selectedItems = sorted.filter((item) => selectedRows.has(rowKey(item)));
      await Promise.all(
        selectedItems.map((item) => {
          const key: DynamoItem = { [schema.pk]: item[schema.pk] };
          if (schema.sk) key[schema.sk] = item[schema.sk];
          return deleteItem(activeTable, key);
        }),
      );
      setSelectedRows(new Set());
      await switchTable(activeTable);
      showToast(`${count} items deleted`, "error");
    } catch (error) {
      showToast("Failed to delete some items", "error");
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  const toggleRow = (rowIdentifier: unknown): void => {
    setSelectedRows((previousSelection) => {
      const nextSelection = new Set(previousSelection);
      nextSelection.has(rowIdentifier) ? nextSelection.delete(rowIdentifier) : nextSelection.add(rowIdentifier);
      return nextSelection;
    });
  };

  const toggleAll = (): void => {
    if (selectedRows.size === sorted.length) setSelectedRows(new Set());
    else setSelectedRows(new Set(sorted.map(rowKey)));
  };

  return (
    <div style={styles.root}>
      {/* ── Sidebar ── */}
      <aside style={styles.sidebar}>
        <div style={styles.logo}>
          <Database size={22} color="#80FF00" />
          <span style={styles.logoText}>DynamoStudio</span>
        </div>

        <div style={styles.sideSection}>
          <div style={styles.sideSectionLabel}>TABLES ({tables.length})</div>
          {tablesLoading ? (
            <div style={{ padding: "12px 8px", display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ ...styles.spinner, width: 12, height: 12, borderWidth: 1.5 }} />
              <span style={{ fontSize: 11, color: "#444" }}>Connecting...</span>
            </div>
          ) : tables.length === 0 ? (
            <div style={{ padding: "12px 8px", fontSize: 11, color: "#444" }}>No tables found</div>
          ) : (
            tables.map((tableName) => (
              <button
                key={tableName}
                onClick={() => switchTable(tableName)}
                disabled={loading}
                style={{ ...styles.tableBtn, ...(activeTable === tableName ? styles.tableBtnActive : {}) }}
              >
                <Table2 size={14} />
                <span style={{ marginLeft: 8 }}>{tableName}</span>
              </button>
            ))
          )}
        </div>

        <div style={{ marginTop: "auto", padding: "16px 12px", borderTop: "1px solid #1e1e1e" }}>
          {tableMeta && (
            <div style={styles.sidebarMeta}>
              <span style={styles.sidebarMetaVal}>~{tableMeta.itemCount.toLocaleString()}</span>
              <span style={styles.sidebarMetaLabel}>records</span>
              <span style={styles.sidebarMetaDot}>·</span>
              <span style={styles.sidebarMetaVal}>{formatBytes(tableMeta.sizeBytes)}</span>
            </div>
          )}
          <div style={{ ...styles.connBadge, marginTop: tableMeta ? 8 : 0 }}>
            <div style={styles.connDot} />
            <span style={{ fontSize: 11, color: "#666" }}>{awsRegion ? `${awsRegion} · dynamodb` : "unknown · dynamodb"}</span>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <main style={styles.main}>
        {/* Header */}
        <header style={styles.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 style={styles.tableName}>{activeTable}</h1>
            <div style={styles.schemaTag}>
              <Key size={12} />
              <span style={{ marginLeft: 4 }}>{schema.pk}</span>
              {schema.sk && (
                <>
                  <span style={{ margin: "0 4px", color: "#444" }}>/</span>
                  <span>{schema.sk}</span>
                </>
              )}
            </div>
            {schema.gsi.length > 0 && <div style={{ ...styles.schemaTag, background: "#1a1a2e", color: "#818cf8" }}>GSI: {schema.gsi.join(", ")}</div>}
            {/* Approximate record count — shown with ~ and tooltip to explain */}
            {tableMeta && (
              <div style={styles.recordCountBadge} title="Approximate count from DescribeTable. AWS refreshes this every ~6 hours.">
                ~{tableMeta.itemCount.toLocaleString()} records
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button style={styles.btnSecondary} onClick={() => switchTable(activeTable)} disabled={loading}>
              <RefreshCw size={14} />
              <span style={{ marginLeft: 6 }}>Refresh</span>
            </button>
            <button style={styles.btnPrimary} onClick={openAdd}>
              <Plus size={14} />
              <span style={{ marginLeft: 6 }}>Add Item</span>
            </button>
            <button style={styles.btnSecondary} onClick={() => setVisualizerOpen(true)} title="Open table visualizer">
              <Table2 size={14} />
              <span style={{ marginLeft: 6 }}>Visualizer</span>
            </button>
            <button
              style={{ ...styles.btnSecondary, ...(agentOpen ? styles.btnAgentActive : {}) }}
              onClick={() => setAgentOpen((isCurrentlyOpen) => !isCurrentlyOpen)}
              title="Open AI Assistant"
            >
              <Bot size={14} />
              <span style={{ marginLeft: 6 }}>Ask AI</span>
            </button>
          </div>
        </header>

        {/* Toolbar */}
        <div style={styles.toolbar}>
          {/* Full-table search — commits on Enter or Search button click */}
          <div style={styles.searchWrap}>
            <input
              style={{ ...styles.searchInput, ...(activeSearch ? styles.searchInputActive : {}) }}
              placeholder={
                schema.pk ? `Search by PK (${schema.pk})${schema.sk ? ` or SK (${schema.sk})` : ""} — press Enter` : "Search by PK / SK..."
              }
              value={searchInput}
              onChange={(changeEvent) => setSearchInput(changeEvent.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            {activeSearch && (
              <button style={styles.searchClearBtn} onClick={clearSearch} title="Clear search">
                <X size={12} />
              </button>
            )}
            <button
              style={{ ...styles.searchBtn, ...(isSearching ? styles.searchBtnActive : {}) }}
              onClick={commitSearch}
              disabled={isSearching || loading}
            >
              {isSearching ? <div style={{ ...styles.spinner, width: 11, height: 11, borderWidth: 1.5 }} /> : <Search size={13} />}
              <span style={{ marginLeft: 5 }}>{isSearching ? "Searching..." : "Search"}</span>
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {/* "25 items on page 1 of ~12" */}
            <span style={styles.countLabel}>
              {items.length} item{items.length !== 1 ? "s" : ""} on page {currentPage}
              {approxTotalPages !== null ? <span style={{ color: "#3a3a3a" }}> of ~{approxTotalPages}</span> : null}
              {activeSearch && <span style={styles.searchPill}>"{activeSearch}"</span>}
            </span>
            {selectedRows.size > 0 && (
              <button style={styles.btnDanger} onClick={handleBulkDelete}>
                <Trash2 size={13} />
                <span style={{ marginLeft: 5 }}>Delete {selectedRows.size}</span>
              </button>
            )}
          </div>
        </div>

        {/* Table */}
        <div style={styles.tableWrap}>
          {loading ? (
            <div style={styles.loadingState}>
              <div style={styles.spinner} />
              <span style={{ color: "#555", marginTop: 12, fontSize: 13 }}>
                {isSearching ? `Searching ${activeTable}...` : `Loading ${activeTable}...`}
              </span>
            </div>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={{ ...styles.th, width: 40 }}>
                    <input
                      type="checkbox"
                      style={styles.checkbox}
                      checked={selectedRows.size === sorted.length && sorted.length > 0}
                      onChange={toggleAll}
                    />
                  </th>
                  {columns.map((columnName) => (
                    <th key={columnName} style={{ ...styles.th, cursor: "pointer" }} onClick={() => handleSort(columnName)}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={columnName === schema.pk || columnName === schema.sk ? { color: "#80FF00" } : {}}>{columnName}</span>
                        {columnName === schema.pk && <span style={styles.pkBadge}>PK</span>}
                        {columnName === schema.sk && <span style={styles.skBadge}>SK</span>}
                        {sortCol === columnName && <span style={{ color: "#80FF00", fontSize: 10 }}>{sortDir === "asc" ? "↑" : "↓"}</span>}
                      </div>
                    </th>
                  ))}
                  <th style={{ ...styles.th, width: 100, textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td colSpan={columns.length + 2} style={styles.emptyCell}>
                      {activeSearch ? `No records found matching "${activeSearch}"` : "No items found"}
                    </td>
                  </tr>
                ) : (
                  sorted.map((item, itemIndex) => {
                    const rowIdentifier = rowKey(item);
                    const isSelected = selectedRows.has(rowIdentifier);
                    return (
                      <tr key={rowIdentifier ?? itemIndex} style={{ ...styles.tr, ...(isSelected ? styles.trSelected : {}) }}>
                        <td style={styles.td}>
                          <input type="checkbox" style={styles.checkbox} checked={isSelected} onChange={() => toggleRow(rowIdentifier)} />
                        </td>
                        {columns.map((columnName) => (
                          <td key={columnName} style={styles.td}>
                            {isObjectLike(item[columnName]) ? (
                              <button
                                style={styles.cellJsonBtn}
                                onClick={() => setJsonViewer({ column: columnName, value: item[columnName] })}
                                title="View full JSON"
                              >
                                <span style={styles.cellVal}>{formatVal(item[columnName])}</span>
                              </button>
                            ) : (
                              <span style={styles.cellVal}>{formatVal(item[columnName])}</span>
                            )}
                          </td>
                        ))}
                        <td style={{ ...styles.td, textAlign: "right" }}>
                          <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                            <button style={styles.iconBtn} onClick={() => openEdit(item)} title="Edit">
                              <Pencil size={13} />
                            </button>
                            <button style={{ ...styles.iconBtn, ...styles.iconBtnDanger }} onClick={() => openDelete(item)} title="Delete">
                              <Trash2 size={13} />
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
        <div style={styles.statusBar}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ color: "#444", fontSize: 11 }}>
              {activeTable} · {columns.length} attributes
              {tableMeta && <span style={{ color: "#333" }}> · ~{tableMeta.itemCount.toLocaleString()} records total</span>}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#3a3a3a", fontSize: 11 }}>Rows per page:</span>
              <select value={pageSize} onChange={(changeEvent) => changePageSize(Number(changeEvent.target.value))} style={styles.pageSizeSelect}>
                {PAGE_SIZE_OPTIONS.map((pageSizeOption) => (
                  <option key={pageSizeOption} value={pageSizeOption}>
                    {pageSizeOption}
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
              style={{ ...styles.pageBtn, ...(currentPage <= 1 ? styles.pageBtnDisabled : {}) }}
              onClick={goPrevPage}
              disabled={currentPage <= 1 || loading}
              title="Previous page"
            >
              ←
            </button>
            <span style={styles.pageNum}>{currentPage}</span>
            <button
              style={{ ...styles.pageBtn, ...(!lastKey ? styles.pageBtnDisabled : {}) }}
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
        <div style={styles.overlay} onClick={() => setModal(null)}>
          <div style={styles.modal} onClick={(clickEvent) => clickEvent.stopPropagation()}>
            {(modal.type === "add" || modal.type === "edit") && (
              <>
                <div style={styles.modalHeader}>
                  <h2 style={styles.modalTitle}>{modal.type === "add" ? "Add New Item" : "Edit Item"}</h2>
                  <button style={styles.modalClose} onClick={() => setModal(null)}>
                    <X size={16} />
                  </button>
                </div>
                <div style={styles.modalBody}>
                  {columns.map((columnName) => (
                    <div key={columnName} style={styles.formRow}>
                      <label style={styles.formLabel}>
                        {columnName}
                        {columnName === schema.pk && <span style={styles.pkBadge}>PK</span>}
                        {columnName === schema.sk && <span style={styles.skBadge}>SK</span>}
                      </label>
                      <input
                        style={styles.formInput}
                        value={String(formData[columnName] ?? "")}
                        onChange={(changeEvent) =>
                          setFormData((previousFormData) => ({ ...previousFormData, [columnName]: changeEvent.target.value }))
                        }
                        placeholder={`Enter ${columnName}...`}
                      />
                    </div>
                  ))}
                </div>
                <div style={styles.modalFooter}>
                  <button style={styles.btnSecondary} onClick={() => setModal(null)} disabled={saving}>
                    Cancel
                  </button>
                  <button style={styles.btnPrimary} onClick={handleSave} disabled={saving}>
                    {saving ? <div style={{ ...styles.spinner, width: 12, height: 12, borderWidth: 1.5 }} /> : <Check size={14} />}
                    <span style={{ marginLeft: 6 }}>{saving ? "Saving..." : modal.type === "add" ? "Create Item" : "Save Changes"}</span>
                  </button>
                </div>
              </>
            )}
            {modal.type === "delete" && modal.item && (
              <>
                <div style={styles.modalHeader}>
                  <h2 style={{ ...styles.modalTitle, color: "#f87171" }}>Delete Item</h2>
                  <button style={styles.modalClose} onClick={() => setModal(null)}>
                    <X size={16} />
                  </button>
                </div>
                <div style={styles.modalBody}>
                  <p style={{ color: "#999", fontSize: 14, marginBottom: 16 }}>
                    This action cannot be undone. The following item will be permanently deleted:
                  </p>
                  <div style={styles.deletePreview}>
                    {Object.entries(modal.item)
                      .slice(0, 5)
                      .map(([attributeName, attributeValue]) => (
                        <div key={attributeName} style={styles.deleteRow}>
                          <span style={{ color: "#555" }}>{attributeName}</span>
                          <span style={{ color: "#ccc" }}>{truncateValue(stringifyValue(attributeValue), 100)}</span>
                        </div>
                      ))}
                  </div>
                </div>
                <div style={styles.modalFooter}>
                  <button style={styles.btnSecondary} onClick={() => setModal(null)} disabled={saving}>
                    Cancel
                  </button>
                  <button style={styles.btnDanger} onClick={handleDelete} disabled={saving}>
                    {saving ? <div style={{ ...styles.spinner, width: 12, height: 12, borderWidth: 1.5 }} /> : <Trash2 size={14} />}
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
        <div style={styles.overlay} onClick={() => setJsonViewer(null)}>
          <div style={{ ...styles.modal, width: 700, maxWidth: "92vw" }} onClick={(clickEvent) => clickEvent.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>JSON Value: {jsonViewer.column}</h2>
              <button style={styles.modalClose} onClick={() => setJsonViewer(null)}>
                <X size={16} />
              </button>
            </div>
            <div style={styles.modalBody}>
              <pre style={styles.jsonViewer}>{stringifyValue(jsonViewer.value, true)}</pre>
            </div>
            <div style={styles.modalFooter}>
              <button style={styles.btnSecondary} onClick={() => setJsonViewer(null)}>
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
            ...styles.toast,
            background: toast.type === "error" ? "#2d1515" : "#0f2d1a",
            borderColor: toast.type === "error" ? "#f87171" : "#4ade80",
          }}
        >
          <div style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: toast.type === "error" ? "#f87171" : "#4ade80" }} />
          <span style={{ color: toast.type === "error" ? "#f87171" : "#4ade80", fontSize: 13 }}>{toast.msg}</span>
        </div>
      )}

      {/* ── AI Agent Chat ── */}
      {visualizerOpen && <TableVisualizer onClose={() => setVisualizerOpen(false)} onAskAI={askAgentFromVisualizer} />}

      {/* ── AI Agent Chat ── */}
      {agentOpen && (
        <AgentChat
          key={activeTable || "no-table"}
          activeTable={activeTable}
          schema={schema}
          queuedPrompt={queuedAgentPrompt}
          onQueuedPromptHandled={() => setQueuedAgentPrompt(null)}
          onClose={() => setAgentOpen(false)}
        />
      )}

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
// Inline CSS object for the full page layout, table, controls, and modal surfaces.
const styles: Record<string, CSSProperties> = {
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
    background: "#001c0b",
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
