// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./globals.css";

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
