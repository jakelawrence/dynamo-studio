"use client";
import { useState, useEffect, CSSProperties } from "react";

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

type SortDir = "asc" | "desc";

// DynamoDB LastEvaluatedKey is a plain object of attribute name → value
type DynamoKey = Record<string, unknown>;

interface FetchItemsResult {
  items: DynamoItem[];
  lastKey: DynamoKey | null; // null means no more pages
}

// ─── API Helpers ───────────────────────────────────────────────────────────
// These call the Next.js API routes which proxy to the AWS SDK server-side.
// See: app/api/tables/route.ts and app/api/tables/[name]/items/route.ts

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

// Accepts an optional ExclusiveStartKey for DynamoDB pagination.
// The API route should forward it as a query param or POST body.
async function fetchItems(tableName: string, exclusiveStartKey?: DynamoKey | null, limit: number = 25): Promise<FetchItemsResult> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (exclusiveStartKey) {
    params.set("startKey", encodeURIComponent(JSON.stringify(exclusiveStartKey)));
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
const getColumns = (items: DynamoItem[]): string[] => {
  if (!items?.length) return [];
  const all = new Set<string>();
  items.forEach((item) => Object.keys(item).forEach((k) => all.add(k)));
  return [...all];
};

const formatVal = (v: unknown): React.ReactNode => {
  if (v === null || v === undefined) return <span style={{ color: "#555" }}>null</span>;
  if (typeof v === "boolean") return <span style={{ color: v ? "#4ade80" : "#f87171" }}>{String(v)}</span>;
  if (typeof v === "number") return <span style={{ color: "#67e8f9" }}>{v}</span>;
  if (typeof v === "string" && v.match(/^\d{4}-\d{2}-\d{2}/)) return <span style={{ color: "#c4b5fd" }}>{v}</span>;
  return String(v);
};

// ─── Main Component ────────────────────────────────────────────────────────
export default function DynamoStudio() {
  const [tables, setTables] = useState<string[]>([]);
  const [activeTable, setActiveTable] = useState<string>("");
  const [schema, setSchema] = useState<TableSchema>({ pk: "", sk: null, gsi: [] });
  const [items, setItems] = useState<DynamoItem[]>([]);
  const [search, setSearch] = useState<string>("");
  const [modal, setModal] = useState<ModalState | null>(null);
  const [formData, setFormData] = useState<DynamoItem>({});
  const [toast, setToast] = useState<ToastState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [tablesLoading, setTablesLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [selectedRows, setSelectedRows] = useState<Set<unknown>>(new Set());
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // ── Pagination state ──────────────────────────────────────────────────────
  const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
  const [pageSize, setPageSize] = useState<number>(25);
  const [currentPage, setCurrentPage] = useState<number>(1);
  // DynamoDB cursor stack: index 0 = first page (no key), index N = key for page N+1
  const [cursorStack, setCursorStack] = useState<(DynamoKey | null)[]>([null]);
  const [lastKey, setLastKey] = useState<DynamoKey | null>(null);

  const columns: string[] = getColumns(items);

  const showToast = (msg: string, type: ToastState["type"] = "success"): void => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  };

  // ── Load table list on mount ──────────────────────────────────────────────
  useEffect(() => {
    const loadTables = async (): Promise<void> => {
      try {
        const tableList = await fetchTables();
        setTables(tableList);
        if (tableList.length > 0) {
          await switchTable(tableList[0]);
        }
      } catch (err) {
        showToast("Failed to connect to DynamoDB", "error");
        console.error(err);
      } finally {
        setTablesLoading(false);
      }
    };
    loadTables();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reset pagination and fetch first page of a table ─────────────────────
  const switchTable = async (t: string): Promise<void> => {
    setLoading(true);
    setActiveTable(t);
    setSearch("");
    setSelectedRows(new Set());
    setSortCol(null);
    setCurrentPage(1);
    setCursorStack([null]);
    setLastKey(null);
    try {
      const [schemaData, result] = await Promise.all([fetchSchema(t), fetchItems(t, null, pageSize)]);
      setSchema(schemaData);
      setItems(result.items);
      setLastKey(result.lastKey);
    } catch (err) {
      showToast(`Failed to load ${t}`, "error");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // ── Go to next DynamoDB page ──────────────────────────────────────────────
  const goNextPage = async (): Promise<void> => {
    if (!lastKey) return;
    setLoading(true);
    setSelectedRows(new Set());
    try {
      const result = await fetchItems(activeTable, lastKey, pageSize);
      // Push the current lastKey onto the stack so we can go back
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

  // ── Go to previous DynamoDB page ─────────────────────────────────────────
  const goPrevPage = async (): Promise<void> => {
    if (currentPage <= 1) return;
    setLoading(true);
    setSelectedRows(new Set());
    try {
      // Pop back to the cursor for the previous page
      const prevStack = cursorStack.slice(0, -1);
      const prevCursor = prevStack[prevStack.length - 1];
      const result = await fetchItems(activeTable, prevCursor, pageSize);
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

  // ── Change page size and reset to page 1 ─────────────────────────────────
  const changePageSize = async (size: number): Promise<void> => {
    setPageSize(size);
    setLoading(true);
    setCurrentPage(1);
    setCursorStack([null]);
    setSelectedRows(new Set());
    try {
      const result = await fetchItems(activeTable, null, size);
      setItems(result.items);
      setLastKey(result.lastKey);
    } catch (err) {
      showToast("Failed to reload table", "error");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const filtered: DynamoItem[] = items.filter(
    (item) => !search || Object.values(item).some((v) => String(v).toLowerCase().includes(search.toLowerCase())),
  );

  const sorted: DynamoItem[] = sortCol
    ? [...filtered].sort((a, b) => {
        const av = a[sortCol];
        const bv = b[sortCol];
        const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      })
    : filtered;

  const handleSort = (col: string): void => {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

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

  // ── Create / Update ───────────────────────────────────────────────────────
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

  // ── Delete single ─────────────────────────────────────────────────────────
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

  // ── Bulk delete ───────────────────────────────────────────────────────────
  const handleBulkDelete = async (): Promise<void> => {
    setSaving(true);
    const count = selectedRows.size;
    try {
      const targets = sorted.filter((i) => selectedRows.has(i[schema.pk]));
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
    else setSelectedRows(new Set(sorted.map((i) => i[schema.pk])));
  };

  return (
    <div style={s.root}>
      {/* ── Sidebar ── */}
      <aside style={s.sidebar}>
        <div style={s.logo}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="2">
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
                style={{ ...s.tableBtn, ...(activeTable === t ? s.tableBtnActive : {}) }}
                disabled={loading}
              >
                <Icon d={icons.table} size={14} />
                <span style={{ marginLeft: 8 }}>{t}</span>
              </button>
            ))
          )}
        </div>

        <div style={{ marginTop: "auto", padding: "16px 12px", borderTop: "1px solid #1e1e1e" }}>
          <div style={s.connBadge}>
            <div style={s.connDot} />
            <span style={{ fontSize: 11, color: "#666" }}>us-east-1 · mock</span>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <main style={s.main}>
        {/* Header */}
        <header style={s.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={s.btnSecondary} onClick={() => switchTable(activeTable)} disabled={loading}>
              <Icon d={icons.refresh} size={14} />
              <span style={{ marginLeft: 6 }}>Refresh</span>
            </button>
            <button style={s.btnPrimary} onClick={openAdd}>
              <Icon d={icons.plus} size={14} />
              <span style={{ marginLeft: 6 }}>Add Item</span>
            </button>
          </div>
        </header>

        {/* Toolbar */}
        <div style={s.toolbar}>
          <div style={s.searchWrap}>
            <div style={s.searchIconWrap}>
              <Icon d={icons.search} size={14} />
            </div>
            <input
              style={s.searchInput}
              placeholder={`Search ${activeTable.toLowerCase()}...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button style={s.clearBtn} onClick={() => setSearch("")}>
                <Icon d={icons.close} size={12} />
              </button>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={s.countLabel}>
              {sorted.length} item{sorted.length !== 1 ? "s" : ""} on page {currentPage}
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
              <span style={{ color: "#555", marginTop: 12, fontSize: 13 }}>Loading {activeTable}...</span>
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
                        <span style={col === schema.pk || col === schema.sk ? { color: "#f97316" } : {}}>{col}</span>
                        {col === schema.pk && <span style={s.pkBadge}>PK</span>}
                        {col === schema.sk && <span style={s.skBadge}>SK</span>}
                        {sortCol === col && <span style={{ color: "#f97316", fontSize: 10 }}>{sortDir === "asc" ? "↑" : "↓"}</span>}
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
                      No items found{search ? ` for "${search}"` : ""}
                    </td>
                  </tr>
                ) : (
                  sorted.map((item, idx) => {
                    const pk = item[schema.pk];
                    const isSelected = selectedRows.has(pk);
                    return (
                      <tr key={String(pk) ?? idx} style={{ ...s.tr, ...(isSelected ? s.trSelected : {}) }}>
                        <td style={s.td}>
                          <input type="checkbox" style={s.checkbox} checked={isSelected} onChange={() => toggleRow(pk)} />
                        </td>
                        {columns.map((col) => (
                          <td key={col} style={s.td}>
                            <span style={s.cellVal}>{formatVal(item[col])}</span>
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
              Page {currentPage} · {sorted.length} item{sorted.length !== 1 ? "s" : ""} shown
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

      {/* ── Modals ── */}
      {modal && (
        <div style={s.overlay} onClick={() => setModal(null)}>
          <div style={s.modal} onClick={(e) => e.stopPropagation()}>
            {/* Add / Edit */}
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

            {/* Delete */}
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
                          <span style={{ color: "#ccc" }}>{String(v)}</span>
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

      {/* ── Toast ── */}
      {toast && (
        <div
          style={{
            ...s.toast,
            background: toast.type === "error" ? "#2d1515" : "#0f2d1a",
            borderColor: toast.type === "error" ? "#f87171" : "#4ade80",
          }}
        >
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: toast.type === "error" ? "#f87171" : "#4ade80",
              flexShrink: 0,
            }}
          />
          <span style={{ color: toast.type === "error" ? "#f87171" : "#4ade80", fontSize: 13 }}>{toast.msg}</span>
        </div>
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
const s: Record<string, CSSProperties> = {
  root: {
    display: "flex",
    height: "100vh",
    background: "#0a0a0a",
    fontFamily: "'JetBrains Mono', monospace",
    color: "#e0e0e0",
    overflow: "hidden",
  },
  sidebar: {
    width: 220,
    background: "#0d0d0d",
    borderRight: "1px solid #1a1a1a",
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
  },
  logo: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "18px 16px 14px",
    borderBottom: "1px solid #1a1a1a",
  },
  logoText: {
    fontFamily: "'Syne', sans-serif",
    fontWeight: 700,
    fontSize: 15,
    color: "#f0f0f0",
    letterSpacing: "-0.3px",
  },
  sideSection: { padding: "12px 8px", flex: 1, overflowY: "auto" },
  sideSectionLabel: {
    fontSize: 9,
    fontWeight: 600,
    color: "#3a3a3a",
    letterSpacing: "1.5px",
    padding: "4px 8px 8px",
  },
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
  tableBtnActive: {
    background: "#1a1a1a",
    color: "#f0f0f0",
    borderLeft: "2px solid #f97316",
    paddingLeft: 6,
  },
  badge: {
    fontSize: 10,
    background: "#1e1e1e",
    color: "#555",
    padding: "1px 6px",
    borderRadius: 10,
  },
  connBadge: { display: "flex", alignItems: "center", gap: 7 },
  connDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "#4ade80",
    boxShadow: "0 0 6px #4ade80",
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
  tableName: {
    fontFamily: "'Syne', sans-serif",
    fontSize: 20,
    fontWeight: 700,
    color: "#f0f0f0",
    letterSpacing: "-0.5px",
  },
  schemaTag: {
    display: "flex",
    alignItems: "center",
    fontSize: 11,
    color: "#f97316",
    background: "#1a1000",
    border: "1px solid #2a1800",
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
  },
  searchWrap: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    width: 280,
    color: "#555",
  },
  searchIconWrap: { margin: "0px 8px 0px 0px" },
  searchInput: {
    width: "100%",
    padding: "7px 30px 7px 32px",
    background: "#111",
    border: "1px solid #222",
    borderRadius: 6,
    color: "#e0e0e0",
    fontSize: 12,
    fontFamily: "inherit",
    outline: "none",
  },
  clearBtn: {
    position: "absolute",
    right: 8,
    background: "none",
    border: "none",
    color: "#555",
    cursor: "pointer",
    padding: 2,
  },
  countLabel: { fontSize: 11, color: "#444" },
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
  trSelected: { background: "#1a1200" },
  td: { padding: "8px 16px", verticalAlign: "middle" },
  cellVal: { fontFamily: "'JetBrains Mono', monospace", fontSize: 12 },
  pkBadge: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: "0.5px",
    background: "#2d1200",
    color: "#f97316",
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
  checkbox: { accentColor: "#f97316", cursor: "pointer" },
  iconBtn: {
    padding: "5px 7px",
    borderRadius: 4,
    background: "transparent",
    border: "1px solid #222",
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
    background: "#f97316",
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
    border: "1px solid #2a2a2a",
    color: "#888",
    fontSize: 12,
    fontFamily: "inherit",
    cursor: "pointer",
    transition: "all 0.15s",
  },
  btnDanger: {
    display: "flex",
    alignItems: "center",
    padding: "7px 14px",
    borderRadius: 6,
    background: "#2d1515",
    border: "1px solid #5a1d1d",
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
    border: "1px solid #222",
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
    border: "1px solid #222",
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
  pageBtnDisabled: {
    color: "#2a2a2a",
    cursor: "not-allowed",
    borderColor: "#181818",
  },
  pageNum: {
    fontSize: 11,
    color: "#f97316",
    background: "#1a1000",
    border: "1px solid #2a1800",
    borderRadius: 4,
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 8,
    paddingRight: 8,
    fontFamily: "'JetBrains Mono', monospace",
  },
  loadingState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "300px",
  },
  spinner: {
    width: 24,
    height: 24,
    border: "2px solid #1e1e1e",
    borderTop: "2px solid #f97316",
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
    border: "1px solid #222",
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
  modalTitle: {
    fontFamily: "'Syne', sans-serif",
    fontSize: 16,
    fontWeight: 700,
    color: "#f0f0f0",
  },
  modalClose: {
    background: "none",
    border: "none",
    color: "#555",
    cursor: "pointer",
    padding: 4,
    borderRadius: 4,
  },
  modalBody: { padding: "16px 20px", overflowY: "auto", flex: 1 },
  modalFooter: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "14px 20px",
    borderTop: "1px solid #1a1a1a",
  },
  formRow: { marginBottom: 12 },
  formLabel: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    color: "#666",
    marginBottom: 5,
    fontWeight: 500,
    letterSpacing: "0.3px",
  },
  formInput: {
    width: "100%",
    padding: "8px 10px",
    background: "#0d0d0d",
    border: "1px solid #222",
    borderRadius: 5,
    color: "#e0e0e0",
    fontSize: 12,
    fontFamily: "inherit",
    outline: "none",
  },
  deletePreview: {
    background: "#0d0d0d",
    border: "1px solid #1a1a1a",
    borderRadius: 6,
    padding: "10px 14px",
  },
  deleteRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "4px 0",
    fontSize: 11,
    borderBottom: "1px solid #141414",
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
