import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ChevronDown, ChevronRight, Folder, LockKeyhole } from "lucide-react";
import type { DocumentLayer } from "./domain";
import type { LayerTreeNode, DropPosition } from "./layerTree";
import ContextMenu, {
  type ContextMenuAnchor,
  type ContextMenuItem,
} from "./ContextMenu";
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
  onOpenTable?(id: string): void;
  onRemoveLayer?(id: string): void;
  onStyle(id: string): void;
  onRenameLayer(id: string, name: string): void;
  onAliasLayer(id: string, name: string): void;
  onNewFile(groupId?: string): void;
  onDeleteGroup(id: string): void;
  onToggleLayer(id: string): void;
  onToggleGroup(id: string): void;
  onCollapseGroup(id: string): void;
  onMove(id: string, targetId: string | null, position: DropPosition): void;
  onAddFiles(groupId?: string): void;
  onAddMysql(groupId?: string): void;
  hasMysqlSources: boolean;
  hasPostgisSources: boolean;
  onAddPostgis(groupId?: string): void;
  desktop: boolean;
  onNewGroup(name: string, parentId?: string): void;
  onRenameGroup?(id: string, name: string): void;
  onDissolveGroup?(id: string): void;
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
        anchor: ContextMenuAnchor;
        nodeId?: string;
      }
    | undefined
  >(undefined);
  const [dialog, setDialog] = useState<
    | { kind: "new-group"; parentId?: string }
    | { kind: "alias-layer" | "rename-layer" | "rename-group"; id: string }
    | { kind: "dissolve-group" | "delete-group"; id: string }
  >();
  const [name, setName] = useState("");
  const [drop, setDrop] = useState<{ id: string; position: DropPosition }>();
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
        form.querySelector<HTMLElement>("input, button")?.focus();
    };
    document.addEventListener("focusin", guardFocus);
    return () => {
      document.removeEventListener("focusin", guardFocus);
      if (returnTarget?.isConnected) returnTarget.focus();
      else document.querySelector<HTMLElement>(".layer-tree")?.focus();
    };
  }, [dialog]);
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
                if (state.target && !props.busy)
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
              !props.busy &&
              (group ? props.onCollapseGroup(node.id) : props.onFit(node.id))
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
                if (!props.busy) props.onCollapseGroup(node.id);
              } else if (event.key === "Enter" && !props.busy)
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
                  anchor: {
                    x: rect.left + 16,
                    y: rect.bottom,
                    returnFocus: event.currentTarget,
                  },
                  nodeId: node.id,
                });
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setMenu({
                anchor: {
                  x: event.clientX,
                  y: event.clientY,
                  returnFocus: event.currentTarget,
                },
                nodeId: node.id,
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
                disabled={props.busy}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onCollapseGroup(node.id);
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                {node.collapsed ? <ChevronRight /> : <ChevronDown />}
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
  const findContext = (
    nodes: LayerTreeNode[],
    id: string,
    parentId?: string,
  ):
    | { node: LayerTreeNode; siblings: LayerTreeNode[]; parentId?: string }
    | undefined => {
    for (const node of nodes) {
      if (node.id === id) return { node, siblings: nodes, parentId };
      if (node.kind === "group") {
        const found = findContext(node.children, id, node.id);
        if (found) return found;
      }
    }
  };
  const context = menu?.nodeId
    ? findContext(props.tree, menu.nodeId)
    : undefined;
  const node = context?.node;
  const menuLayer = node?.kind === "layer" ? layerById.get(node.id) : undefined;
  const dialogTarget = dialog
    ? findContext(
        props.tree,
        dialog.kind === "new-group" ? (dialog.parentId ?? "") : dialog.id,
      )?.node
    : undefined;
  const dialogTargetValid =
    dialog?.kind === "new-group"
      ? !dialog.parentId || dialogTarget?.kind === "group"
      : dialog?.kind === "rename-layer" || dialog?.kind === "alias-layer"
        ? dialogTarget?.kind === "layer" && layerById.has(dialogTarget.id)
        : dialogTarget?.kind === "group";
  const groupId = node?.kind === "group" ? node.id : undefined;
  const act = (action: () => void) => {
    if (props.busy) return;
    setMenu(undefined);
    action();
  };
  const items: ContextMenuItem[] = [];
  const addItem = (
    id: string,
    label: string,
    action: () => void,
    disabled = false,
    shortcut?: string,
    danger?: boolean,
  ) => {
    items.push({
      id,
      label,
      onSelect: () => act(action),
      disabled: props.busy || disabled,
      shortcut,
      danger,
    });
  };
  const separator = (id: string) => items.push({ id, separator: true });
  const newGroup = () => {
    setName("");
    setDialog({ kind: "new-group", parentId: groupId });
  };
  if (!node || node.kind === "group") {
    addItem("new-group", groupId ? "新建子分组" : "新建分组", newGroup);
    if (node?.kind === "group") {
      addItem("rename-group", "重命名分组", () => {
        setName(node.name);
        setDialog({ kind: "rename-group", id: node.id });
      });
      separator("group-name");
    }
    addItem("new-file", "新建文件", () => props.onNewFile(groupId));
    separator("add");
    addItem("add-files", "添加文件图层", () => props.onAddFiles(groupId));
    addItem(
      "add-mysql",
      "添加Mysql表图层",
      () => props.onAddMysql(groupId),
      !props.desktop || !props.hasMysqlSources,
    );
    addItem(
      "add-postgis",
      "添加PostGIS表图层",
      () => props.onAddPostgis(groupId),
      !props.desktop || !props.hasPostgisSources,
    );
    if (node?.kind === "group") {
      separator("remove");
      addItem("dissolve-group", "解散分组", () =>
        setDialog({ kind: "dissolve-group", id: node.id }),
      );
      addItem(
        "delete-group",
        "删除分组",
        () => setDialog({ kind: "delete-group", id: node.id }),
        false,
        undefined,
        true,
      );
    }
  } else {
    addItem("alias-layer", "设置别名", () => {
      setName(menuLayer?.displayName ?? menuLayer?.name ?? "");
      setDialog({ kind: "alias-layer", id: node.id });
    });
    addItem(
      "rename-layer",
      "重命名",
      () => {
        setName(menuLayer?.name ?? "");
        setDialog({ kind: "rename-layer", id: node.id });
      },
      !props.desktop || !menuLayer?.sourceId || Boolean(menuLayer?.db),
    );
    separator("remove");
    addItem(
      "remove-layer",
      "移除",
      () => props.onRemoveLayer?.(node.id),
      !props.onRemoveLayer,
      undefined,
      true,
    );
  }
  return (
    <>
      <div
        className="panel-heading"
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({
            anchor: {
              x: event.clientX,
              y: event.clientY,
              returnFocus: document.querySelector<HTMLElement>(".layer-tree"),
            },
          });
        }}
      >
        <strong>图层</strong>
        {props.layers.length > 0 && (
          <span className="count">{props.layers.length}</span>
        )}
      </div>
      <div
        className="layer-tree"
        tabIndex={0}
        role="tree"
        aria-label="图层树"
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({
            anchor: {
              x: event.clientX,
              y: event.clientY,
              returnFocus: event.currentTarget,
            },
          });
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({
              anchor: {
                x: rect.left + 16,
                y: rect.top + 16,
                returnFocus: event.currentTarget,
              },
            });
          }
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
      {menu &&
        (!menu.nodeId || (node && (node.kind === "group" || menuLayer))) && (
          <ContextMenu
            anchor={menu.anchor}
            label="图层操作"
            items={items}
            onClose={() => setMenu(undefined)}
          />
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
              if (
                !props.busy &&
                dialogTargetValid &&
                (dialog.kind === "dissolve-group" ||
                  dialog.kind === "delete-group" ||
                  name.trim())
              ) {
                if (dialog.kind === "new-group")
                  props.onNewGroup(name.trim(), dialog.parentId);
                else if (dialog.kind === "alias-layer")
                  props.onAliasLayer(dialog.id, name.trim());
                else if (dialog.kind === "rename-layer")
                  props.onRenameLayer(dialog.id, name.trim());
                else if (dialog.kind === "dissolve-group")
                  props.onDissolveGroup?.(dialog.id);
                else if (dialog.kind === "delete-group")
                  props.onDeleteGroup(dialog.id);
                else props.onRenameGroup?.(dialog.id, name.trim());
                setDialog(undefined);
              }
            }}
          >
            <h3 id="layer-group-title">
              {dialog.kind === "new-group"
                ? dialog.parentId
                  ? "新建子分组"
                  : "新建分组"
                : dialog.kind === "alias-layer"
                  ? "设置别名"
                  : dialog.kind === "rename-layer"
                    ? "重命名"
                    : dialog.kind === "rename-group"
                      ? "重命名分组"
                      : dialog.kind === "delete-group"
                        ? "删除分组"
                        : "解散分组"}
            </h3>
            {dialog.kind === "delete-group" ? (
              <p className="layer-rename-help">
                删除此分组及其全部子分组、图层？未保存的修改将丢弃，磁盘文件保留。
              </p>
            ) : dialog.kind === "dissolve-group" ? (
              <p className="layer-rename-help">
                解散“
                {dialogTarget?.kind === "group" ? dialogTarget.name : "分组"}
                ”？图层和子分组将按原有结构移到根层。
              </p>
            ) : (
              <>
                <label htmlFor="layer-group-name">
                  {dialog.kind === "alias-layer"
                    ? "图层别名"
                    : dialog.kind === "rename-layer"
                      ? "文件名称"
                      : "分组名称"}
                </label>
                <input
                  id="layer-group-name"
                  autoFocus
                  disabled={props.busy}
                  onFocus={(event) => event.currentTarget.select()}
                  value={name}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                />
              </>
            )}
            <div>
              <button
                type="button"
                autoFocus={
                  dialog.kind === "dissolve-group" ||
                  dialog.kind === "delete-group"
                }
                onClick={() => setDialog(undefined)}
              >
                取消
              </button>
              <button
                type="submit"
                disabled={
                  (dialog.kind !== "dissolve-group" &&
                    dialog.kind !== "delete-group" &&
                    !name.trim()) ||
                  props.busy ||
                  !dialogTargetValid
                }
              >
                {dialog.kind === "new-group"
                  ? "创建"
                  : dialog.kind === "dissolve-group"
                    ? "解散"
                    : dialog.kind === "delete-group"
                      ? "删除"
                      : "确定"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
