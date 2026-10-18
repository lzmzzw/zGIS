import { analysisTools } from "./analysisTools";
import type { DocumentLayer } from "./domain/types";

export interface UiCommand {
  id: string;
  label: string;
  group: string;
  disabledReason?: string;
  run: () => void;
}
export interface CommandContext {
  layer?: DocumentLayer;
  blockedReason?: string;
  analysisBlockedReason?: string;
  profile: () => void;
  style: () => void;
  fit: () => void;
  analysis: (id: string) => void;
}
/** UI discovery only: opening a form never executes an analysis or grants MCP capabilities. */
export function createUiCommands(context: CommandContext): UiCommand[] {
  const layerReason = context.blockedReason || (!context.layer ? "请先选择图层" : undefined);
  return [
    { id: "layer.profile", label: "字段概览", group: "图层", disabledReason: layerReason, run: context.profile },
    { id: "layer.style", label: "图层样式", group: "图层", disabledReason: layerReason, run: context.style },
    { id: "map.fit", label: "缩放至图层", group: "地图", disabledReason: layerReason || (!context.layer?.features.length ? "图层没有要素" : undefined), run: context.fit },
    ...analysisTools.map(tool => ({
      id: `analysis.${tool.id}`, label: tool.label, group: tool.category,
      disabledReason: context.blockedReason || context.analysisBlockedReason,
      run: () => context.analysis(tool.id),
    })),
  ];
}
export function matchUiCommands(commands: UiCommand[], query: string, translate: (text: string) => string): UiCommand[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter(command => {
    const text = `${command.id} ${command.label} ${translate(command.label)} ${command.group} ${translate(command.group)}`.toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
}
export function executeUiCommand(command: UiCommand): boolean {
  if (command.disabledReason) return false;
  command.run();
  return true;
}
