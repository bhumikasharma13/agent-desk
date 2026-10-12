// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Session Intelligence's `Conversation`, read from the descriptor set in
 * `contract/session-intelligence/`, and the strict check every exported
 * Conversation must pass.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFileRegistry, fromBinary, fromJson, type DescMessage, type JsonValue } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

const DESCRIPTOR = join(resolve(import.meta.dirname, "..", ".."), "contract", "session-intelligence", "conversation.binpb");

export const registry = createFileRegistry(fromBinary(FileDescriptorSetSchema, readFileSync(DESCRIPTOR)));
export const CONVERSATION = registry.getMessage("sessionintelligence.v1.Conversation")!;

/** Throws unless `json` parses strictly as `Conversation` with every key the proto's JSON name. */
export function assertConversation(json: unknown, label: string): void {
  fromJson(CONVERSATION, json as JsonValue, { ignoreUnknownFields: false });
  assertJsonNames(CONVERSATION, json, label);
}

/** protojson also reads proto field names; the export writes only JSON names. */
function assertJsonNames(desc: DescMessage, value: unknown, path: string): void {
  if (desc.typeName.startsWith("google.protobuf.")) return;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const field = desc.fields.find((f) => f.jsonName === key);
    assert.ok(field, `${path}.${key} is not a JSON field name of ${desc.typeName}`);
    const at = `${path}.${key}`;
    if (field.fieldKind === "message") assertJsonNames(field.message, v, at);
    if (field.fieldKind === "list" && field.listKind === "message") {
      (v as unknown[]).forEach((x, i) => assertJsonNames(field.message, x, `${at}[${i}]`));
    }
    if (field.fieldKind === "map" && field.mapKind === "message") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) assertJsonNames(field.message, x, `${at}.${k}`);
    }
  }
}
