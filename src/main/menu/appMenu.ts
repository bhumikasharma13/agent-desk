// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { Menu, type MenuItemConstructorOptions } from "electron";

export interface AppMenuDeps {
  appName: string;
  isPackaged: boolean;
}

// Curated macOS menu: About and Quit (Cmd+Q) / working Edit shortcuts / Window with
// Close Window (Cmd+W, which hides the window to the menu bar). In packaged
// builds DevTools stays out — the View submenu is dev-only (gated on
// isPackaged below) and the input-event guards in index.ts are the hard block.
export function buildAppMenu(deps: AppMenuDeps): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: deps.appName,
      submenu: [
        { role: "about", label: `About ${deps.appName}` },
        { type: "separator" },
        { role: "hide", label: `Hide ${deps.appName}` },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: `Quit ${deps.appName}` },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    // View (Reload / Toggle DevTools) only in dev — never in packaged builds.
    ...(deps.isPackaged
      ? []
      : [
          {
            label: "View",
            submenu: [{ role: "reload" }, { role: "toggleDevTools" }],
          } as MenuItemConstructorOptions,
        ]),
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "close" }, { type: "separator" }, { role: "front" }],
    },
  ];
  return Menu.buildFromTemplate(template);
}
