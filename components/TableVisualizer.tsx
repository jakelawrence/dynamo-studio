"use client";
import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { WheelEvent as ReactWheelEvent } from "react";

// Table visualizer modal:
// - Loads table/field metadata for all tables
// - Lets users position cards and draw explicit field relations
// - Sends the visible schema snapshot to the AI assistant for analysis

interface VisualizerField {
  name: string;
  type: string;
  source: "key" | "inferred";
}

interface VisualizerTable {
  name: string;
  pk: string;
  sk: string | null;
  gsi: string[];
  fields: VisualizerField[];
}

interface VisualizerRelation {
  id: string;
  fromTable: string;
  fromField: string;
  toTable: string;
  toField: string;
}

interface TableVisualizerProps {
  onClose: () => void;
  onAskAI: (prompt: string) => void;
  onOpenVisualizerChat: () => void;
}

interface TablePosition {
  x: number;
  y: number;
}

interface PersistedVisualizerState {
  positions: Record<string, TablePosition>;
  relations: VisualizerRelation[];
  hidden: string[];
}

const CARD_WIDTH = 280;
const CARD_GAP = 28;
type AnchorSide = "top" | "right" | "bottom" | "left";
const VISUALIZER_STORAGE_KEY = "dynamoStudio.tableVisualizer.v1";

const readPersistedVisualizerState = (): PersistedVisualizerState => {
  const defaults: PersistedVisualizerState = {
    positions: {},
    relations: [],
    hidden: [],
  };
  if (typeof window === "undefined") return defaults;

  try {
    const raw = window.localStorage.getItem(VISUALIZER_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PersistedVisualizerState>;

    const positions =
      parsed.positions && typeof parsed.positions === "object"
        ? Object.entries(parsed.positions).reduce<Record<string, TablePosition>>((acc, [tableName, pos]) => {
            if (
              typeof tableName === "string" &&
              pos &&
              typeof pos === "object" &&
              typeof (pos as TablePosition).x === "number" &&
              typeof (pos as TablePosition).y === "number"
            ) {
              acc[tableName] = { x: (pos as TablePosition).x, y: (pos as TablePosition).y };
            }
            return acc;
          }, {})
        : {};

    const relations = Array.isArray(parsed.relations)
      ? parsed.relations.filter(
          (relation): relation is VisualizerRelation =>
            !!relation &&
            typeof relation === "object" &&
            typeof relation.id === "string" &&
            typeof relation.fromTable === "string" &&
            typeof relation.fromField === "string" &&
            typeof relation.toTable === "string" &&
            typeof relation.toField === "string",
        )
      : [];

    const hidden = Array.isArray(parsed.hidden) ? parsed.hidden.filter((tableName): tableName is string => typeof tableName === "string") : [];

    return { positions, relations, hidden };
  } catch {
    return defaults;
  }
};

// Estimate card height so relation routing can target edges more accurately.
function estimateCardHeight(table: VisualizerTable): number {
  const header = 58;
  const fieldRows = Math.min(table.fields.length, 9) * 20;
  const gsi = table.gsi.length > 0 ? 30 : 0;
  return Math.min(300, header + fieldRows + gsi + 12);
}

// Translate a side + card geometry into an anchor point for relation lines.
function sidePoint(side: AnchorSide, pos: TablePosition, width: number, height: number): { x: number; y: number } {
  if (side === "top") return { x: pos.x + width / 2, y: pos.y };
  if (side === "bottom") return { x: pos.x + width / 2, y: pos.y + height };
  if (side === "left") return { x: pos.x, y: pos.y + height / 2 };
  return { x: pos.x + width, y: pos.y + height / 2 };
}

// Unit vector for each edge side, used to project bezier control handles outward.
function directionVector(side: AnchorSide): { x: number; y: number } {
  if (side === "top") return { x: 0, y: -1 };
  if (side === "bottom") return { x: 0, y: 1 };
  if (side === "left") return { x: -1, y: 0 };
  return { x: 1, y: 0 };
}

// Build a smooth cubic bezier between two card anchors with adaptive handle length.
function buildBezierPath(start: { x: number; y: number }, startSide: AnchorSide, end: { x: number; y: number }, endSide: AnchorSide): string {
  const minOffset = 36;
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const handle = Math.max(minOffset, Math.min(distance * 0.45, 120));
  const startDir = directionVector(startSide);
  const endDir = directionVector(endSide);

  const c1 = { x: start.x + startDir.x * handle, y: start.y + startDir.y * handle };
  const c2 = { x: end.x + endDir.x * handle, y: end.y + endDir.y * handle };
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
}

const DEFAULT_AI_QUESTIONS = [
  "Where should I add GSIs?",
  "How can I make this database table structure faster for my app?",
  "What access patterns are missing from this design?",
  "Which relationships should be denormalized or materialized?",
] as const;

export default function TableVisualizer({ onClose, onAskAI, onOpenVisualizerChat }: TableVisualizerProps) {
  const persistedState = useRef<PersistedVisualizerState>(readPersistedVisualizerState());

  // Data, layout, and interaction state for the canvas and relation editor toolbar.
  const [tables, setTables] = useState<VisualizerTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set(persistedState.current.hidden));
  const [positions, setPositions] = useState<Record<string, TablePosition>>(persistedState.current.positions);
  const [relations, setRelations] = useState<VisualizerRelation[]>(persistedState.current.relations);
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fromTable, setFromTable] = useState("");
  const [fromField, setFromField] = useState("");
  const [toTable, setToTable] = useState("");
  const [toField, setToField] = useState("");

  const dragRef = useRef<{ table: string; offsetX: number; offsetY: number } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  // Initial schema load for visualizer cards.
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/tables/visualizer");
        if (!res.ok) throw new Error("Failed to load table schema visualizer");
        const data: { tables: VisualizerTable[] } = await res.json();
        setTables(data.tables ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load visualizer");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  useEffect(() => {
    if (tables.length === 0) return;
    setPositions((prev) => {
      const next = { ...prev };
      tables.forEach((t, index) => {
        if (next[t.name]) return;
        const col = index % 4;
        const row = Math.floor(index / 4);
        next[t.name] = {
          x: 30 + col * (CARD_WIDTH + CARD_GAP),
          y: 30 + row * 330,
        };
      });
      return next;
    });
  }, [tables]);

  // Keep persisted hidden/relations aligned with currently loaded tables/fields.
  useEffect(() => {
    if (tables.length === 0) return;
    const tableNames = new Set(tables.map((table) => table.name));
    const fieldsByTable = new Map(tables.map((table) => [table.name, new Set(table.fields.map((field) => field.name))]));

    setHidden((prev) => {
      const next = new Set([...prev].filter((tableName) => tableNames.has(tableName)));
      return next.size === prev.size ? prev : next;
    });

    setPositions((prev) => {
      const nextEntries = Object.entries(prev).filter(([tableName]) => tableNames.has(tableName));
      if (nextEntries.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(nextEntries);
    });

    setRelations((prev) => {
      const seen = new Set<string>();
      const next: VisualizerRelation[] = [];

      for (const relation of prev) {
        const fromFields = fieldsByTable.get(relation.fromTable);
        const toFields = fieldsByTable.get(relation.toTable);
        if (!fromFields || !toFields) continue;
        if (!fromFields.has(relation.fromField) || !toFields.has(relation.toField)) continue;
        if (relation.fromTable === relation.toTable && relation.fromField === relation.toField) continue;

        const normalizedId = `${relation.fromTable}:${relation.fromField}->${relation.toTable}:${relation.toField}`;
        if (seen.has(normalizedId)) continue;
        seen.add(normalizedId);
        next.push({ ...relation, id: normalizedId });
      }
      return next.length === prev.length && next.every((relation, index) => relation.id === prev[index].id) ? prev : next;
    });
  }, [tables]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stateToPersist: PersistedVisualizerState = {
      positions,
      relations,
      hidden: Array.from(hidden),
    };
    window.localStorage.setItem(VISUALIZER_STORAGE_KEY, JSON.stringify(stateToPersist));
  }, [positions, relations, hidden]);

  // Auto-seed relation dropdown defaults once tables are available.
  useEffect(() => {
    if (!fromTable && tables.length > 0) setFromTable(tables[0].name);
    if (!toTable && tables.length > 1) setToTable(tables[1].name);
  }, [tables, fromTable, toTable]);

  // Keep chosen fields valid whenever source table changes.
  useEffect(() => {
    const table = tables.find((t) => t.name === fromTable);
    if (!table) return;
    if (!table.fields.some((f) => f.name === fromField)) {
      setFromField(table.fields[0]?.name ?? "");
    }
  }, [fromTable, fromField, tables]);

  // Keep chosen fields valid whenever target table changes.
  useEffect(() => {
    const table = tables.find((t) => t.name === toTable);
    if (!table) return;
    if (!table.fields.some((f) => f.name === toField)) {
      setToField(table.fields[0]?.name ?? "");
    }
  }, [toTable, toField, tables]);

  // Derived lists used for rendering and hidden-table chip recovery row.
  const visibleTables = useMemo(() => tables.filter((t) => !hidden.has(t.name)), [tables, hidden]);
  const hiddenTables = useMemo(() => tables.filter((t) => hidden.has(t.name)), [tables, hidden]);

  const fieldsFor = (name: string) => tables.find((t) => t.name === name)?.fields ?? [];

  // Record drag offset so pointer movement maps to stable card positioning under current zoom.
  const onDragStart = (tableName: string, event: ReactPointerEvent<HTMLDivElement>) => {
    const boardRect = boardRef.current?.getBoundingClientRect();
    const board = boardRef.current;
    if (!boardRect || !board) return;
    const pos = positions[tableName] ?? { x: 0, y: 0 };
    const rawX = event.clientX - boardRect.left + board.scrollLeft;
    const rawY = event.clientY - boardRect.top + board.scrollTop;
    dragRef.current = {
      table: tableName,
      offsetX: rawX / zoom - pos.x,
      offsetY: rawY / zoom - pos.y,
    };
  };

  // Move the active card and clamp to positive canvas coordinates.
  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const boardRect = boardRef.current?.getBoundingClientRect();
    const board = boardRef.current;
    if (!drag || !boardRect || !board) return;

    const rawX = event.clientX - boardRect.left + board.scrollLeft;
    const rawY = event.clientY - boardRect.top + board.scrollTop;
    const nextX = Math.max(0, rawX / zoom - drag.offsetX);
    const nextY = Math.max(0, rawY / zoom - drag.offsetY);

    setPositions((prev) => ({ ...prev, [drag.table]: { x: nextX, y: nextY } }));
  };

  const onDragEnd = () => {
    dragRef.current = null;
  };

  const hideTable = (name: string) => {
    setHidden((prev) => new Set(prev).add(name));
  };

  const showTable = (name: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  };

  // Create a unique directed relation between two table fields.
  const addRelation = () => {
    if (!fromTable || !fromField || !toTable || !toField) return;
    if (fromTable === toTable && fromField === toField) return;
    const id = `${fromTable}:${fromField}->${toTable}:${toField}`;
    if (relations.some((r) => r.id === id)) return;
    setRelations((prev) => [...prev, { id, fromTable, fromField, toTable, toField }]);
    setSelectedRelationId(null);
  };

  // Load an existing relation into toolbar inputs for editing.
  const startEditRelation = (relationId: string) => {
    const relation = relations.find((r) => r.id === relationId);
    if (!relation) return;
    setFromTable(relation.fromTable);
    setFromField(relation.fromField);
    setToTable(relation.toTable);
    setToField(relation.toField);
    setSelectedRelationId(relationId);
  };

  // Persist toolbar changes back onto the selected relation.
  const editRelation = () => {
    if (!selectedRelationId) return;
    if (!fromTable || !fromField || !toTable || !toField) return;
    if (fromTable === toTable && fromField === toField) return;

    const nextId = `${fromTable}:${fromField}->${toTable}:${toField}`;
    if (nextId !== selectedRelationId && relations.some((r) => r.id === nextId)) return;

    setRelations((prev) =>
      prev.map((relation) =>
        relation.id === selectedRelationId
          ? {
              id: nextId,
              fromTable,
              fromField,
              toTable,
              toField,
            }
          : relation,
      ),
    );
    setSelectedRelationId(nextId);
  };

  // Delete currently selected relation.
  const removeRelation = () => {
    if (!selectedRelationId) return;
    setRelations((prev) => prev.filter((relation) => relation.id !== selectedRelationId));
    setSelectedRelationId(null);
  };

  const visibleRelations = relations.filter((r) => !hidden.has(r.fromTable) && !hidden.has(r.toTable));
  // Precompute line paths and label positions for visible relations.
  const relationGeometry = useMemo(() => {
    const result: Record<
      string,
      {
        path: string;
        midX: number;
        midY: number;
      }
    > = {};
    const sides: AnchorSide[] = ["top", "right", "bottom", "left"];

    for (const relation of visibleRelations) {
      const fromTableObj = tables.find((t) => t.name === relation.fromTable);
      const toTableObj = tables.find((t) => t.name === relation.toTable);
      const fromPos = positions[relation.fromTable];
      const toPos = positions[relation.toTable];
      if (!fromTableObj || !toTableObj || !fromPos || !toPos) continue;

      const fromH = estimateCardHeight(fromTableObj);
      const toH = estimateCardHeight(toTableObj);

      let best:
        | {
            from: { x: number; y: number };
            to: { x: number; y: number };
            fromSide: AnchorSide;
            toSide: AnchorSide;
            score: number;
          }
        | undefined;

      for (const fromSide of sides) {
        for (const toSide of sides) {
          const fromPoint = sidePoint(fromSide, fromPos, CARD_WIDTH, fromH);
          const toPoint = sidePoint(toSide, toPos, CARD_WIDTH, toH);
          const dx = toPoint.x - fromPoint.x;
          const dy = toPoint.y - fromPoint.y;
          const dist = Math.hypot(dx, dy);
          // Penalize routes that point back into their origin card direction.
          const fromDir = directionVector(fromSide);
          const toDir = directionVector(toSide);
          const fromPenalty = (fromDir.x * dx + fromDir.y * dy) < 0 ? 160 : 0;
          const toPenalty = (toDir.x * -dx + toDir.y * -dy) < 0 ? 160 : 0;
          const score = dist + fromPenalty + toPenalty;
          if (!best || score < best.score) {
            best = { from: fromPoint, to: toPoint, fromSide, toSide, score };
          }
        }
      }

      if (!best) continue;
      result[relation.id] = {
        path: buildBezierPath(best.from, best.fromSide, best.to, best.toSide),
        midX: (best.from.x + best.to.x) / 2,
        midY: (best.from.y + best.to.y) / 2,
      };
    }

    return result;
  }, [visibleRelations, tables, positions]);
  const zoomPercent = Math.round(zoom * 100);

  // Expand canvas bounds to include all visible cards and padding for links/labels.
  const canvasSize = useMemo(() => {
    let maxX = 1800;
    let maxY = 1200;
    for (const table of visibleTables) {
      const pos = positions[table.name];
      if (!pos) continue;
      maxX = Math.max(maxX, pos.x + CARD_WIDTH + 220);
      maxY = Math.max(maxY, pos.y + 360);
    }
    return { width: maxX, height: maxY };
  }, [visibleTables, positions]);

  // Keep zoom in a practical interaction range.
  const clampZoom = (value: number): number => Math.min(2, Math.max(0.35, value));

  const changeZoom = (delta: number) => {
    setZoom((prev) => clampZoom(Number((prev + delta).toFixed(2))));
  };

  const resetZoom = () => {
    setZoom(1);
  };

  // Ctrl/Cmd+wheel zoom behavior to avoid hijacking normal scroll.
  const onWheelZoom = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    changeZoom(event.deltaY > 0 ? -0.08 : 0.08);
  };

  // Build a visibility-aware schema snapshot and send it to AgentChat as a prefilled prompt.
  const sendSnapshotToAI = (question: string) => {
    const includedTables = tables
      .filter((table) => !hidden.has(table.name))
      .map((table) => ({
        name: table.name,
        pk: table.pk,
        sk: table.sk,
        gsi: table.gsi,
        fields: table.fields,
      }));

    const includedRelations = relations
      .filter((relation) => !hidden.has(relation.fromTable) && !hidden.has(relation.toTable))
      .map((relation) => ({
        fromTable: relation.fromTable,
        fromField: relation.fromField,
        toTable: relation.toTable,
        toField: relation.toField,
      }));

    const snapshot = {
      generatedAt: new Date().toISOString(),
      includedTableCount: includedTables.length,
      includedRelationCount: includedRelations.length,
      tables: includedTables,
      relations: includedRelations,
    };

    const prompt = `You are reviewing a DynamoDB table visualizer snapshot (hidden tables excluded).\n\nQuestion: ${question}\n\nPlease analyze this schema and give concrete, actionable recommendations with tradeoffs.\n\nSnapshot:\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\``;
    onAskAI(prompt);
  };

  return (
    <div style={s.overlay}>
      <div style={s.modal}>
        <div style={s.header}>
          <div>
            <div style={s.title}>Table Visualizer</div>
            <div style={s.subtitle}>Drag tables, link fields, and hide tables to simplify view.</div>
          </div>
          <button style={s.closeBtn} onClick={onClose}>
            Close
          </button>
        </div>

        <div style={s.toolbar}>
          <div style={s.toolbarLabel}>Connect tables</div>
          <select value={fromTable} onChange={(e) => setFromTable(e.target.value)} style={s.select}>
            {tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <select value={fromField} onChange={(e) => setFromField(e.target.value)} style={s.select}>
            {fieldsFor(fromTable).map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
          <span style={s.arrow}>→</span>
          <select value={toTable} onChange={(e) => setToTable(e.target.value)} style={s.select}>
            {tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <select value={toField} onChange={(e) => setToField(e.target.value)} style={s.select}>
            {fieldsFor(toTable).map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
          <button style={s.addBtn} onClick={selectedRelationId ? editRelation : addRelation}>
            {selectedRelationId ? "Edit Link" : "Add Link"}
          </button>
          {selectedRelationId ? (
            <button style={s.removeBtn} onClick={removeRelation}>
              Remove Link
            </button>
          ) : null}
          <div style={s.zoomWrap}>
            <button style={s.zoomBtn} onClick={() => changeZoom(-0.1)}>
              -
            </button>
            <span style={s.zoomLabel}>{zoomPercent}%</span>
            <button style={s.zoomBtn} onClick={() => changeZoom(0.1)}>
              +
            </button>
            <button style={s.zoomReset} onClick={resetZoom}>
              Reset
            </button>
          </div>
        </div>

        {hiddenTables.length > 0 && (
          <div style={s.hiddenRow}>
            <span style={s.hiddenLabel}>Hidden:</span>
            {hiddenTables.map((t) => (
              <button key={t.name} style={s.hiddenChip} onClick={() => showTable(t.name)}>
                {t.name}
              </button>
            ))}
          </div>
        )}

        <div style={s.aiPromptRow}>
          <span style={s.aiPromptLabel}>Ask AI about this visible schema:</span>
          <button style={s.aiOpenBtn} onClick={onOpenVisualizerChat}>
            Open Visualizer Chat
          </button>
          {DEFAULT_AI_QUESTIONS.map((question) => (
            <button key={question} style={s.aiPromptBtn} onClick={() => sendSnapshotToAI(question)}>
              {question}
            </button>
          ))}
        </div>

        <div
          ref={boardRef}
          style={s.board}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerLeave={onDragEnd}
          onWheel={onWheelZoom}
          onClick={() => setSelectedRelationId(null)}
        >
          {loading && <div style={s.status}>Loading visualizer…</div>}
          {error && <div style={{ ...s.status, color: "#f87171" }}>{error}</div>}

          {!loading && !error && (
            <div style={{ ...s.canvas, width: canvasSize.width, height: canvasSize.height, transform: `scale(${zoom})` }}>
              <svg style={s.lines}>
                {visibleRelations.map((r) => {
                  const geometry = relationGeometry[r.id];
                  if (!geometry) return null;
                  return (
                    <g key={r.id}>
                      <path d={geometry.path} fill="none" stroke="#80FF00" strokeWidth="1.2" />
                      <text x={geometry.midX} y={geometry.midY - 4} fill="#9bcf84" fontSize="10" textAnchor="middle">
                        {r.fromField} → {r.toField}
                      </text>
                    </g>
                  );
                })}
              </svg>
              <svg style={s.linkHitLayer}>
                {visibleRelations.map((r) => {
                  const geometry = relationGeometry[r.id];
                  if (!geometry) return null;
                  const active = selectedRelationId === r.id;

                  return (
                    <g key={`hit:${r.id}`}>
                      <path
                        d={geometry.path}
                        fill="none"
                        stroke={active ? "#bef264" : "transparent"}
                        strokeOpacity={active ? 0.95 : 0}
                        strokeWidth={active ? 2.2 : 14}
                        style={{ cursor: "pointer" }}
                        onClick={(event) => {
                          event.stopPropagation();
                          startEditRelation(r.id);
                        }}
                      />
                    </g>
                  );
                })}
              </svg>

              {visibleTables.map((table) => {
                const pos = positions[table.name] ?? { x: 20, y: 20 };
                return (
                  <div
                    key={table.name}
                    style={{ ...s.card, left: pos.x, top: pos.y, width: CARD_WIDTH }}
                    onPointerDown={(e) => onDragStart(table.name, e)}
                  >
                    <div style={s.cardHeader}>
                      <div>
                        <div style={s.cardTitle}>{table.name}</div>
                        <div style={s.cardMeta}>
                          PK: {table.pk || "-"} {table.sk ? `· SK: ${table.sk}` : ""}
                        </div>
                      </div>
                      <button style={s.hideBtn} onClick={(e) => {
                        e.stopPropagation();
                        hideTable(table.name);
                      }}>
                        Hide
                      </button>
                    </div>

                    <div style={s.fieldList}>
                      {table.fields.map((field) => (
                        <div key={field.name} style={s.fieldRow}>
                          <span style={s.fieldName}>{field.name}</span>
                          <span style={s.fieldType}>{field.type}</span>
                        </div>
                      ))}
                    </div>

                    {table.gsi.length > 0 && <div style={s.gsi}>GSI: {table.gsi.join(", ")}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Inline styles for modal shell, toolbar, zoomable board, cards, and relation layers.
const s: Record<string, CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.65)",
    zIndex: 520,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  modal: {
    width: "min(96vw, 1400px)",
    height: "min(92vh, 920px)",
    background: "#0b0d0b",
    border: "1px solid #1f271e",
    borderRadius: 12,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 14px",
    borderBottom: "1px solid #1d231d",
    background: "#090b09",
  },
  title: {
    color: "#f1f5f9",
    fontSize: 15,
    fontWeight: 700,
  },
  subtitle: {
    color: "#7a8b78",
    fontSize: 11,
    marginTop: 3,
  },
  closeBtn: {
    border: "1px solid #2b3829",
    background: "#0d140c",
    color: "#b8c4b6",
    borderRadius: 6,
    padding: "6px 10px",
    cursor: "pointer",
    fontSize: 12,
  },
  toolbar: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    borderBottom: "1px solid #1d231d",
    padding: "10px 12px",
    background: "#0b110b",
    flexWrap: "wrap",
  },
  toolbarLabel: {
    color: "#95aa92",
    fontSize: 11,
    marginRight: 4,
  },
  select: {
    background: "#111711",
    border: "1px solid #273227",
    borderRadius: 6,
    color: "#d0ddd0",
    fontSize: 12,
    padding: "6px 8px",
    minWidth: 130,
  },
  arrow: {
    color: "#82a17d",
    fontSize: 14,
    padding: "0 2px",
  },
  addBtn: {
    background: "#80FF00",
    color: "#101210",
    border: "none",
    borderRadius: 6,
    padding: "7px 10px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  removeBtn: {
    background: "#2c1414",
    color: "#fca5a5",
    border: "1px solid #4b1d1d",
    borderRadius: 6,
    padding: "7px 10px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  zoomWrap: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginLeft: "auto",
  },
  zoomBtn: {
    width: 24,
    height: 24,
    border: "1px solid #2e3a2e",
    borderRadius: 5,
    background: "#121812",
    color: "#d2ddd1",
    fontSize: 14,
    cursor: "pointer",
    lineHeight: 1,
  },
  zoomLabel: {
    width: 48,
    textAlign: "center",
    color: "#9db39a",
    fontSize: 11,
  },
  zoomReset: {
    border: "1px solid #2e3a2e",
    borderRadius: 5,
    background: "#121812",
    color: "#c9d6c8",
    fontSize: 11,
    padding: "4px 7px",
    cursor: "pointer",
  },
  hiddenRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderBottom: "1px solid #1d231d",
    background: "#0a0f0a",
    flexWrap: "wrap",
  },
  aiPromptRow: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    padding: "10px 12px",
    borderBottom: "1px solid #1d231d",
    background: "#0b120b",
    flexWrap: "wrap",
  },
  aiPromptLabel: {
    color: "#7a8f76",
    fontSize: 11,
    marginRight: 4,
  },
  aiPromptBtn: {
    border: "1px solid #2e3b2d",
    borderRadius: 999,
    background: "#101810",
    color: "#b8d3b2",
    padding: "5px 10px",
    fontSize: 11,
    cursor: "pointer",
  },
  aiOpenBtn: {
    border: "1px solid #2c4750",
    borderRadius: 999,
    background: "#0d1b20",
    color: "#7dd3fc",
    padding: "5px 10px",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
  },
  hiddenLabel: {
    color: "#667666",
    fontSize: 11,
  },
  hiddenChip: {
    border: "1px solid #2a3a2a",
    background: "#101710",
    color: "#aac7a4",
    borderRadius: 999,
    padding: "4px 9px",
    fontSize: 11,
    cursor: "pointer",
  },
  board: {
    position: "relative",
    flex: 1,
    overflow: "auto",
    background:
      "radial-gradient(circle at 1px 1px, rgba(129,147,128,0.18) 1px, transparent 0), linear-gradient(180deg,#090c09,#0b100b)",
    backgroundSize: "24px 24px, auto",
    minHeight: 0,
  },
  canvas: {
    position: "relative",
    transformOrigin: "top left",
  },
  lines: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
  },
  linkHitLayer: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "auto",
  },
  card: {
    position: "absolute",
    background: "#0f140f",
    border: "1px solid #263026",
    borderRadius: 9,
    boxShadow: "0 10px 24px rgba(0,0,0,0.45)",
    display: "flex",
    flexDirection: "column",
    maxHeight: 300,
    overflow: "hidden",
    cursor: "grab",
  },
  cardHeader: {
    padding: "10px 10px 8px",
    borderBottom: "1px solid #222d22",
    display: "flex",
    alignItems: "start",
    justifyContent: "space-between",
    gap: 8,
  },
  cardTitle: {
    color: "#f0f5f0",
    fontWeight: 700,
    fontSize: 13,
  },
  cardMeta: {
    color: "#88a086",
    fontSize: 10,
    marginTop: 3,
  },
  hideBtn: {
    border: "1px solid #2a352a",
    background: "#131b13",
    color: "#c9d2c8",
    borderRadius: 5,
    padding: "3px 7px",
    fontSize: 10,
    cursor: "pointer",
    flexShrink: 0,
  },
  fieldList: {
    padding: "8px 10px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    overflowY: "auto",
  },
  fieldRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    fontSize: 11,
  },
  fieldName: {
    color: "#cdd8cd",
  },
  fieldType: {
    color: "#80FF00",
  },
  gsi: {
    borderTop: "1px solid #222d22",
    color: "#7f8cff",
    fontSize: 10,
    padding: "8px 10px",
    background: "#11152a",
  },
  status: {
    position: "absolute",
    top: 20,
    left: 20,
    color: "#b6c2b5",
    fontSize: 13,
  },
};
