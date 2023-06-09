import { analysisStateField } from "../../LanguageServer";
import { statementsIntersecting } from "../statementIntersection";
import StyleCircle from "./StyleCircle";
import { RangeSet, Extension } from "@codemirror/state";
import { GutterMarker, gutter, gutters } from "@codemirror/view";
import { DCGView } from "DCGView";
import { ItemModel } from "globals/models";
import { Calc } from "globals/window";

export function styleCircles(): Extension {
  return [gutters(), styleCircleGutter];
}

const styleCircleGutter = gutter({
  renderEmptyElements: false,
  markers(view) {
    const program = view.state.field(analysisStateField).program;
    const { from, to } = view.viewport;
    const ranges = [];
    let last = -1;
    for (const stmt of statementsIntersecting(program, from, to)) {
      const model = Calc.controller.getItemModel(stmt.id);
      if (model?.type === "expression" || model?.type === "image") {
        const pos = view.lineBlockAt(stmt.pos.from).from;
        if (pos > last) {
          last = pos;
          ranges.push(new StyleCircleMarker(stmt.id, model).range(pos));
        }
      }
    }
    return RangeSet.of(ranges);
  },
  initialSpacer() {
    return new StyleCircleSpacer();
  },
});

class StyleCircleMarker extends GutterMarker {
  unsub: (() => void) | undefined;
  div: HTMLElement | undefined;

  constructor(readonly id: string, readonly model: ItemModel) {
    super();
  }

  eq(other: StyleCircleMarker) {
    return this.model === other.model;
  }

  toDOM() {
    this.div = document.createElement("div");
    const view = DCGView.mountToNode(StyleCircle, this.div, {
      id: DCGView.const(this.id),
      model: DCGView.const(this.model),
    });
    this.unsub = Calc.controller.subToChanges(() => view.update());
    return this.div;
  }

  destroy() {
    this.unsub?.();
    if (this.div) DCGView.unmountFromNode(this.div);
  }
}

class StyleCircleSpacer extends GutterMarker {
  eq() {
    return true;
  }

  toDOM() {
    const div = document.createElement("div");
    div.style.width = "29px";
    return div;
  }
}
