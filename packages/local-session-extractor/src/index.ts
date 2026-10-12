// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * local-session-extractor — reads AI coding sessions from local agent and IDE
 * files into one normalized record.
 */
export type * from "./types/session";
export type { SessionSummary, SessionSummaryFilter, TrackingRow, TranscriptMessage, UpsertParams } from "./types/store";
export type * from "./types/seatTier";
export type { Logger } from "./seams/logger";
export type { CounterTags, MetricsSink } from "./seams/metrics";
export type { SeatTierLookup, SeatTierLookupResult } from "./seams/seatTier";
export { redactPath, redactPrompts, redactText, sanitizeSessionMeta, unredactPath } from "./redaction";
export { SessionStore, StoreOpenError, defaultStorePath, openStore } from "./store/SessionStore";
export {
  DuplicateSourceError,
  UnsupportedSourceError,
  readAll,
  readSource,
  type RecordError,
  type ScanOptions,
  type ScanProgressEvent,
  type ScanResult,
} from "./scan";
export { capabilities, type Capabilities } from "./capabilities";
export {
  exportSessions,
  type ExportFilter,
  type ExportFormat,
  type ExportOptions,
  type ExportShape,
  type ExportSplitOptions,
  type ExportToOutOptions,
} from "./export";
export { toConversation } from "./sessionIntelligence";
export type * as SessionIntelligence from "./types/sessionIntelligence";
export type { Conversation as SessionIntelligenceConversation } from "./types/sessionIntelligence";
export { UnknownPathKeyError, type PathKey } from "./extractors/pathResolver";
