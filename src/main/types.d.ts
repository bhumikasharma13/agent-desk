// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Global type augmentation — no imports, so TypeScript treats this as ambient.

declare namespace Electron {
  interface App {
    isQuitting: boolean;
  }
}
