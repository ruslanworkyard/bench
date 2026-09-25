import { spawnSync } from "node:child_process";

import { render, type Instance } from "ink";
import { createElement } from "react";

import type { ReportView } from "../commands/compare.js";
import { App, Store } from "./App.js";
import { NoColor } from "./style.js";

/**
 * The interactive view the CLI hands a command in place of the plain renderer: it hears the
 * command's events, shows its report, and stays until the person quits. Ink is mounted on the
 * first event or report, so a command that fails its preflight never draws a frame.
 */

export type ViewOptions = {
  /** `q` then `y`, or Ctrl-C, on the board: the CLI's interruption path. Called after Ink lets go of the terminal. */
  onAbort: () => void;
  /** A replay's `--speed`, so the board's clock runs with the events. */
  speed?: number | undefined;
  env?: NodeJS.ProcessEnv;
};

export type View = ReportView & {
  /** Resolves once the person quits the results; at once when no report was shown (the command failed). */
  closed(): Promise<void>;
};

export function createView(options: ViewOptions): View {
  const env = options.env ?? process.env;
  const store = new Store();
  let instance: Instance | null = null;
  let shown = false;

  const openReport = (path: string | null): string => {
    if (path === null) return "no report file: the pair is from two batches";
    const editor = env["EDITOR"];
    if (editor === undefined || editor === "") return `report  ${path}`;
    // The editor takes the terminal; Ink redraws on the next frame.
    spawnSync(`${editor} '${path.replace(/'/g, `'\\''`)}'`, { shell: true, stdio: "inherit" });
    instance?.clear();
    return `opened ${path}`;
  };

  const mount = (): void => {
    if (instance !== null) return;
    const app = createElement(App, {
      store,
      onOpenReport: openReport,
      speed: options.speed ?? 1,
      onAbort: () => {
        instance?.unmount();
        options.onAbort();
      },
    });
    const noColor = env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "";
    instance = render(createElement(NoColor.Provider, { value: noColor }, app), { exitOnCtrlC: false, patchConsole: true });
  };

  return {
    subscriber: (event) => {
      mount();
      store.dispatch(event);
    },
    show: (report, path) => {
      mount();
      shown = true;
      store.show(report, path);
    },
    closed: async () => {
      if (instance === null) return;
      if (!shown) {
        instance.unmount();
        return;
      }
      await instance.waitUntilExit();
    },
  };
}
