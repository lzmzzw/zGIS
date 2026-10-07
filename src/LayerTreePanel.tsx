import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ChevronDown, ChevronRight, Folder, LockKeyhole } from "lucide-react";
import type { DocumentLayer } from "./domain";
import type { LayerTreeNode, DropPosition } from "./layerTree";
import "./layer-tree.css";

interface Props {
  tree: LayerTreeNode[];
  layers: DocumentLayer[];
  activeId?: string;
  busy: boolean;
  readonlyIds?: string[];
  onSelect(id: string): void;
  onFit(id: string): void;
  onProperties(id: string): void;
  onStyle(id: string): void;
  onRenameLayer(id: string, name: string): void;
  onToggleLayer(id: string): void;
  onToggleGroup(id: string): void;
  onCollapseGroup(id: string): void;
  onMove(id: string, targetId: string | null, position: DropPosition): void;
  onAddFiles(groupId?: string): void;
  onAddPostgis(groupId?: string): void;
  desktop: boolean;
  onNewGroup(name: string, parentId?: string): void;
  onRenameGroup?(id: string, name: string): void;
  onRemoveGroup?(id: string): void;
}
const MIME = "application/x-zgis-layer-node";
type SymbolKind = "polygon" | "line" | "point" | "mixed" | "empty";
const symbolLabels: Record<SymbolKind, string> = {
  polygon: "面图层",
  line: "线图层",
  point: "点图层",
  mixed: "混合几何图层",
  empty: "无几何图层",
};
function symbolKind(layer: DocumentLayer): SymbolKind {
  const kinds = new Set<SymbolKind>();
  for (const feature of layer.features) {
    const type = feature.geometry?.type;
    if (!type) continue;
    kinds.add(
      type === "Polygon" || type === "MultiPolygon"
        ? "polygon"
        : type === "LineString" || type === "MultiLineString"
          ? "line"
          : type === "Point" || type === "MultiPoint"
            ? "point"
            : "mixed",
    );
    if (kinds.size > 1 || kinds.has("mixed")) return "mixed";
  }
  return kinds.values().next().value ?? "empty";
}
export default function LayerTree(props: Props) {
  const [menu, setMenu] = useState<
    | {
        x: number;
        y: number;
        node?: LayerTreeNode;
        siblings: LayerTreeNode[];
      }
    | undefined
  >(undefined);
  const [dialog, setDialog] = useState<
    | { kind: "new-group"; parentId?: string }
    | { kind: "rename-layer" | "rename-group"; id: string }
  >();
  const [name, setName] = useState("");
  const [drop, setDrop] = useState<{ id: string; position: DropPosition }>();
  const menuRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const dragId = useRef<string | undefined>(undefined);
  const pointerDrag = useRef<
    | {
        id: string;
        x: number;
        y: number;
        moving: boolean;
        forbidden: Set<string>;
        target?: { id: string; position: DropPosition };
      }
    | undefined
  >(undefined);
  const suppressClick = useRef(false);
  const layerById = useMemo(
    () => new Map(props.layers.map((layer) => [layer.id, layer])),
    [props.layers],
  );
  const symbols = useMemo(
    () => new Map(props.layers.map((layer) => [layer.id, symbolKind(layer)])),
    [props.layers],
  );
  useEffect(() => {
    if (!dialog) return;
    const form = dialogRef.current;
    const returnId = dialog.kind === "new-group" ? dialog.parentId : dialog.id;
    const returnTarget = returnId
      ? [
          ...document.querySelectorAll<HTMLElement>(
            ".layer-tree [data-node-id]",
          ),
        ].find((row) => row.dataset.nodeId === returnId)
      : document.querySelector<HTMLElement>(".layer-tree");
    const guardFocus = (event: FocusEvent) => {
      if (form && !form.contains(event.target as Node))
        form.querySelector<HTMLInputElement>("input")?.focus();
    };
    document.addEventListener("focusin", guardFocus);
    return () => {
      document.removeEventListener("focusin", guardFocus);
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [dialog]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(undefined);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(undefined);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);
  const position = (
    event: DragEvent<HTMLDivElement>,
    group: boolean,
  ): DropPosition => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    return group && ratio > 0.25 && ratio < 0.75
      ? "inside"
      : ratio < 0.5
        ? "before"
        : "after";
  };
  const moveSibling = (
    node: LayerTreeNode,
    siblings: LayerTreeNode[],
    direction: -1 | 1,
  ) => {
    if (props.busy) return;
    const target =
      siblings[siblings.findIndex((item) => item.id === node.id) + direction];
    if (target)
      props.onMove(node.id, target.id, direction < 0 ? "before" : "after");
  };
  const renderNodes = (
    nodes: LayerTreeNode[],
    level = 1,
    ancestorsVisible = true,
  ) =>
    nodes.map((node) => {
      const group = node.kind === "group";
      const layer = group ? undefined : layerById.get(node.id);
      if (!group && !layer) return null;
      const visible = group ? node.visible : layer!.visible;
      const displayName = group
        ? node.name
        : (layer!.displayName ?? layer!.name);
      const symbol = symbols.get(node.id) ?? "empty";
      return (
        <div key={node.id} role="none">
          <div
            role="treeitem"
            aria-level={level}
            aria-expanded={group ? !node.collapsed : undefined}
            aria-selected={group ? undefined : node.id === props.activeId}
            tabIndex={0}
            draggable={false}
            data-node-id={node.id}
            data-node-kind={node.kind}
            className={`layer-row tree-row ${!ancestorsVisible || !visible ? "effective-hidden" : ""} ${!group && node.id === props.activeId ? "selected" : ""} ${drop?.id === node.id ? `drop-${drop.position}` : ""}`}
            style={{ paddingLeft: 8 + (level - 1) * 20 }}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              if (!group) props.onSelect(node.id);
            }}
            onPointerDown={(event) => {
              if (
                props.busy ||
                event.button !== 0 ||
                (event.target as HTMLElement).closest("button, input")
              )
                return;
              const forbidden = new Set<string>();
              const collect = (value: LayerTreeNode) => {
                forbidden.add(value.id);
                if (value.kind === "group") value.children.forEach(collect);
              };
              collect(node);
              pointerDrag.current = {
                id: node.id,
                x: event.clientX,
                y: event.clientY,
                moving: false,
                forbidden,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const state = pointerDrag.current;
              if (!state) return;
              if (
                !state.moving &&
                Math.hypot(event.clientX - state.x, event.clientY - state.y) < 5
              )
                return;
              state.moving = true;
              const hit = document
                .elementFromPoint(event.clientX, event.clientY)
                ?.closest<HTMLElement>("[data-node-id]");
              const root = document
                .elementFromPoint(event.clientX, event.clientY)
                ?.closest(".layer-tree");
              if (hit && !state.forbidden.has(hit.dataset.nodeId!)) {
                const rect = hit.getBoundingClientRect();
                const ratio = (event.clientY - rect.top) / rect.height;
                const value: DropPosition =
                  hit.dataset.nodeKind === "group" &&
                  ratio > 0.25 &&
                  ratio < 0.75
                    ? "inside"
                    : ratio < 0.5
                      ? "before"
                      : "after";
                state.target = { id: hit.dataset.nodeId!, position: value };
                setDrop(state.target);
              } else {
                state.target =
                  root && !hit ? { id: "", position: "inside" } : undefined;
                setDrop(undefined);
              }
            }}
            onPointerUp={(event) => {
              const state = pointerDrag.current;
              pointerDrag.current = undefined;
              setDrop(undefined);
              if (state?.moving) {
                suppressClick.current = true;
                window.setTimeout(() => {
                  suppressClick.current = false;
                }, 0);
                if (state.target)
                  props.onMove(
                    state.id,
                    state.target.id || null,
                    state.target.position,
                  );
              }
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              pointerDrag.current = undefined;
              setDrop(undefined);
            }}
            onDoubleClick={() =>
              group ? props.onCollapseGroup(node.id) : props.onFit(node.id)
            }
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (
                event.altKey &&
                (event.key === "ArrowUp" || event.key === "ArrowDown")
              ) {
                event.preventDefault();
                moveSibling(node, nodes, event.key === "ArrowUp" ? -1 : 1);
              } else if (
                group &&
                ((event.key === "ArrowRight" && node.collapsed) ||
                  (event.key === "ArrowLeft" && !node.collapsed))
              ) {
                event.preventDefault();
                props.onCollapseGroup(node.id);
              } else if (event.key === "Enter")
                group
                  ? props.onCollapseGroup(node.id)
                  : props.onSelect(node.id);
              else if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({
                  x: rect.left + 16,
                  y: rect.bottom,
                  node,
                  siblings: nodes,
                });
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setMenu({
                x: event.clientX,
                y: event.clientY,
                node,
                siblings: nodes,
              });
            }}
            onDragStart={(event) => {
              event.stopPropagation();
              dragId.current = node.id;
              event.dataTransfer.setData(MIME, node.id);
              event.dataTransfer.effectAllowed = "move";
              setMenu(undefined);
            }}
            onDragEnd={() => {
              dragId.current = undefined;
              setDrop(undefined);
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(MIME) || props.busy)
                return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
              setDrop({ id: node.id, position: position(event, group) });
            }}
            onDrop={(event) => {
              if (!event.dataTransfer.types.includes(MIME) || props.busy)
                return;
              event.preventDefault();
              event.stopPropagation();
              const id = event.dataTransfer.getData(MIME) || dragId.current;
              if (id) props.onMove(id, node.id, position(event, group));
              setDrop(undefined);
            }}
          >
            {group ? (
              <button
                className="icon-button layer-expander"
                aria-label={
                  node.collapsed ? `展开 ${node.name}` : `折叠 ${node.name}`
                }
                onClick={(event) => {
                  event.stopPropagation();
                  props.onCollapseGroup(node.id);
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                {node.collapsed ? (
                  <ChevronRight />
                ) : (
                  <ChevronDown />
                )}
              </button>
            ) : (
              <span className="layer-expander-placeholder" aria-hidden="true" />
            )}
            <input
              type="checkbox"
              className="layer-visibility"
              checked={visible}
              disabled={props.busy}
              aria-label={`显示${group ? "分组" : "图层"} ${displayName}`}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onChange={() => {
                group
                  ? props.onToggleGroup(node.id)
                  : props.onToggleLayer(node.id);
              }}
            />
            {group ? (
              <span className="layer-symbol-slot" aria-hidden="true">
                <Folder />
              </span>
            ) : (
              <button
                className="layer-symbol-button"
                disabled={props.busy}
                aria-label={`${displayName}样式`}
                title={`${symbolLabels[symbol]} · 点击设置样式`}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onStyle(node.id);
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <span
                  className={`layer-swatch layer-swatch-${symbol}`}
                  style={{
                    background:
                      symbol === "line" ||
                      symbol === "empty" ||
                      symbol === "mixed"
                        ? undefined
                        : layer!.color,
                    color: layer!.color,
                  }}
                  aria-hidden="true"
                />
              </button>
            )}
            <span className="layer-text">
              <strong title={displayName}>
                {group
                  ? node.name
                  : `${displayName}${layer!.dirty ? " *" : ""}`}
              </strong>
            </span>
            {!group && props.readonlyIds?.includes(node.id) && (
              <LockKeyhole aria-label="只读图层" />
            )}
          </div>
          {group && !node.collapsed && (
            <div role="group">
              {renderNodes(
                node.children,
                level + 1,
                ancestorsVisible && visible,
              )}
            </div>
          )}
        </div>
      );
    });
  const groupId = menu?.node?.kind === "group" ? menu.node.id : undefined;
  const act = (action: () => void) => {
    setMenu(undefined);
    action();
  };
  return (
    <>
      <div className="panel-heading">
        <strong>图层</strong>
        {props.layers.length > 0 && (
          <span className="count">{props.layers.length}</span>
        )}
      </div>
      <div
        className="layer-tree"
        tabIndex={-1}
        role="tree"
        aria-label="图层树"
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, siblings: props.tree });
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(MIME) && !props.busy) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDrop(undefined);
          }
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes(MIME) || props.busy) return;
          event.preventDefault();
          const id = event.dataTransfer.getData(MIME) || dragId.current;
          if (id) props.onMove(id, null, "inside");
          setDrop(undefined);
        }}
      >
        {renderNodes(props.tree)}
      </div>
      {menu && (
        <div
          ref={menuRef}
          className="layer-tree-menu"
          role="menu"
          aria-label="图层操作"
          style={{
            left: Math.max(4, Math.min(menu.x, window.innerWidth - 200)),
            top: Math.max(
              4,
              Math.min(menu.y, window.innerHeight - (menu.node ? 260 : 130)),
            ),
          }}
        >
          <button
            role="menuitem"
            disabled={props.busy}
            onClick={() => act(() => props.onAddFiles(groupId))}
          >
            添加文件…
          </button>
          <button
            role="menuitem"
            disabled={props.busy || !props.desktop}
            onClick={() => act(() => props.onAddPostgis(groupId))}
          >
            添加 PostGIS…
          </button>
          <button
            role="menuitem"
            disabled={props.busy}
            onClick={() =>
              act(() => {
                setName("");
                setDialog({ kind: "new-group", parentId: groupId });
              })
            }
          >
            新建分组…
          </button>
          {menu.node && (
            <>
              <hr />
              {menu.node.kind === "layer" && (
                <button
                  role="menuitem"
                  disabled={props.busy}
                  onClick={() => act(() => props.onProperties(menu.node!.id))}
                >
                  图层属性…
                </button>
              )}
              {(menu.node.kind === "layer" || props.onRenameGroup) && (
                <button
                  role="menuitem"
                  disabled={props.busy}
                  onClick={() =>
                    act(() => {
                      const node = menu.node!;
                      const layer = layerById.get(node.id);
                      setName(
                        node.kind === "group"
                          ? node.name
                          : (layer!.displayName ?? layer!.name),
                      );
                      setDialog({
                        kind:
                          node.kind === "group"
                            ? "rename-group"
                            : "rename-layer",
                        id: node.id,
                      });
                    })
                  }
                >
                  {menu.node.kind === "group" ? "重命名分组…" : "重命名图层…"}
                </button>
              )}
              <button
                role="menuitem"
                disabled={props.busy || menu.siblings[0]?.id === menu.node.id}
                onClick={() =>
                  act(() => moveSibling(menu.node!, menu.siblings, -1))
                }
              >
                上移 <span>Alt+↑</span>
              </button>
              <button
                role="menuitem"
                disabled={
                  props.busy || menu.siblings.at(-1)?.id === menu.node.id
                }
                onClick={() =>
                  act(() => moveSibling(menu.node!, menu.siblings, 1))
                }
              >
                下移 <span>Alt+↓</span>
              </button>
              <button
                role="menuitem"
                disabled={props.busy}
                onClick={() =>
                  act(() => props.onMove(menu.node!.id, null, "inside"))
                }
              >
                移到顶层
              </button>
            </>
          )}
        </div>
      )}
      {dialog && (
        <div
          className="layer-group-backdrop"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setDialog(undefined);
            } else if (event.key === "Tab") {
              const focusable = [
                ...(dialogRef.current?.querySelectorAll<HTMLElement>(
                  "input:not(:disabled), button:not(:disabled)",
                ) ?? []),
              ];
              const first = focusable[0];
              const last = focusable.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
          onClick={() => setDialog(undefined)}
        >
          <form
            ref={dialogRef}
            className="layer-group-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="layer-group-title"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && !props.busy) {
                if (dialog.kind === "new-group")
                  props.onNewGroup(name.trim(), dialog.parentId);
                else if (dialog.kind === "rename-layer")
                  props.onRenameLayer(dialog.id, name.trim());
                else props.onRenameGroup?.(dialog.id, name.trim());
                setDialog(undefined);
              }
            }}
          >
            <h3 id="layer-group-title">
              {dialog.kind === "new-group"
                ? "新建分组"
                : dialog.kind === "rename-layer"
                  ? "重命名图层"
                  : "重命名分组"}
            </h3>
            <label htmlFor="layer-group-name">
              {dialog.kind === "rename-layer" ? "显示名称" : "分组名称"}
            </label>
            <input
              id="layer-group-name"
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
            {dialog.kind === "rename-layer" && (
              <p className="layer-rename-help">
                原始文件名不变。
              </p>
            )}
            <div>
              <button type="button" onClick={() => setDialog(undefined)}>
                取消
              </button>
              <button type="submit" disabled={!name.trim() || props.busy}>
                {dialog.kind === "new-group" ? "创建" : "确定"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
