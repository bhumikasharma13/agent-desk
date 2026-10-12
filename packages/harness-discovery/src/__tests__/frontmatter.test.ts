// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { bestDescription, fileNameToDisplayName, parseFrontmatter } from "../scanShared";

describe("parseFrontmatter", () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ["plain keys, quotes stripped from name and description", '---\nname: "review"\ndescription: \'Checks a change.\'\nversion: 1.2\n---\nBody.\n', { name: "review", description: "Checks a change.", version: "1.2" }],
    ["CRLF line endings", "---\r\nname: crlf\r\ndescription: Windows line endings.\r\n---\r\nBody.\r\n", { name: "crlf", description: "Windows line endings." }],
    ["a folded (>-) description", "---\nname: f\ndescription: >-\n  Folded description that spans\n  two lines.\n---\nBody.\n", { description: "Folded description that spans two lines." }],
    ["a folded (>) description with a paragraph break", "---\ndescription: >\n  one\n  two\n\n  three\n---\n", { description: "one two\nthree" }],
    ["a literal (|) description keeps its lines", "---\ndescription: |\n  line one\n  line two\n---\n", { description: "line one\nline two" }],
    ["a block-scalar name and version", "---\nname: >\n  block name\nversion: |-\n  2.0\n---\n", { name: "block name", version: "2.0" }],
    ["a block scalar followed by another key", "---\ndescription: |\n  text\nname: after\n---\n", { description: "text", name: "after" }],
    ["an empty value is absent, not the next line", "---\nname:\ndescription: real\n---\n", { name: undefined, description: "real" }],
    ["the first of duplicate keys wins", "---\nname: one\nname: two\n---\n", { name: "one" }],
    ["a comment after a plain value", "---\nname: a # c\ndescription: plain#not-a-comment\n---\n", { name: "a", description: "plain#not-a-comment" }],
    ["a comment after a block-scalar header", "---\ndescription: > # c\n  folded text\n---\n", { description: "folded text" }],
    ["doubled single quotes and escaped double quotes decode", "---\nname: 'it''s'\ndescription: \"say \\\"hi\\\" \\\\ back\"\n---\n", { name: "it's", description: 'say "hi" \\ back' }],
    ["fences with trailing spaces or tabs", "--- \nname: spaced\n---\t\nBody.\n", { name: "spaced" }],
    ["an empty name is absent", "---\nname: ''\ndescription: \"\"\n---\n", { name: undefined, description: undefined }],
    ["a name of terminal escapes only is absent", "---\nname: \u001b[31m‮\n---\n", { name: undefined }],
    ["\"a\" or \"b\" is kept as written", '---\nname: "a" or "b"\n---\n', { name: '"a" or "b"' }],
    ["a mismatched quote pair is kept", "---\nname: \"a'\n---\n", { name: "\"a'" }],
    ["an empty double-quoted value is absent", '---\ndescription: ""\n---\n', { description: undefined }],
    ["a comment on the closing fence line does not close it", "---\nname: x\n--- # c\ndescription: y\n---\n", { description: "y" }],
    ["only an opening fence is not frontmatter", "---\nname: x\n", { name: undefined }],
    ["a closing fence at the end of the file", "---\nname: at-eof\n---", { name: "at-eof" }],
    ["an escaped quote inside a quoted value before a comment", '---\nname: "a\\" # x" # c\ndescription: \'it\'\'s # y\' # c\n---\n', { name: 'a" # x', description: "it's # y" }],
    ["a quoted version with a comment", '---\nversion: "1.0" # c\n---\n', { version: "1.0" }],
    ["a # right after a closing quote is not a comment", '---\nname: "a"#b\n---\n', { name: '"a"#b' }],
    ["the first comment after a quoted value ends it", '---\ndescription: "a" # x "b" # y\n---\n', { description: "a" }],
    ["unmatched quotes are kept", "---\nname: 'a' or 'b'\n---\n", { name: "'a' or 'b'" }],
    ["a line of four dashes does not close the frontmatter", "---\nname: x\n----\ndescription: after the dashes\n---\n", { description: "after the dashes" }],
    ["a leading byte-order mark", "﻿---\nname: bom\n---\nBody.\n", { name: "bom" }],
    ["a comment after a quoted value", '---\ndescription: "quoted: with colon" # comment\nname: \'n\' # c\n---\n', { description: "quoted: with colon", name: "n" }],
    ["a comment alone is an empty value", "---\nname: # note\ndescription: real\n---\n", { name: undefined, description: "real" }],
    ["a comment after tabs takes the tabs with it", "---\nname: a\t\t# c\n---\n", { name: "a" }],
    ["a # inside a word stays and the first one after whitespace starts the comment", "---\nname: a#b \t # c # d\n---\n", { name: "a#b" }],
    ["a # after a non-ASCII space starts a comment", "---\nname: a\u3000# c\n---\n", { name: "a" }],
    ["a # inside a quoted value with no comment stays", '---\nname: "a #b"\n---\n', { name: "a #b" }],
    ["a value holding a line separator is not read", "---\nname: a\u2028b\ndescription: next\n---\n", { name: undefined, description: "next" }],
    // Known limits (README, "Before you rely on it"): not a full YAML parser.
    ["a plain value spanning lines keeps only its first line", "---\ndescription: first line\n  continued\n---\n", { description: "first line" }],
    ["a nested map is not read as its keys", "---\nmetadata:\n  name: inner\n---\n", { name: undefined }],
    ["a flow collection is kept as its literal text", "---\nname: [a, b]\n---\n", { name: "[a, b]" }],
  ];
  it.each(cases)("%s", (_title, content, expected) => {
    const fm = parseFrontmatter(content);
    for (const [k, v] of Object.entries(expected)) expect(fm[k as keyof typeof fm], k).toEqual(v);
  });

  // Each of these took 20 seconds or more while a pattern retried a long run from each of its
  // characters. Linear, they take a few milliseconds.
  const run = (c: string) => c.repeat(200_000);
  it.each([
    ["spaces", `---\ndescription: x${run(" ")}y\n---\n`, { description: `x${run(" ")}y` }],
    ["tabs before a comment", `---\ndescription: x${run("\t")}y # c\n---\n`, { description: `x${run("\t")}y` }],
    ["spaces before a line separator", `---\nname: n\ndescription:${run(" ")}\u2028\n---\n`, { name: "n", description: undefined }],
  ])("reads a value with 200 KB of %s in linear time", (_title, content, expected) => {
    const start = performance.now();
    const fm = parseFrontmatter(content);
    const ms = performance.now() - start;
    for (const [k, v] of Object.entries(expected)) expect(fm[k as keyof typeof fm], k).toEqual(v);
    expect(ms).toBeLessThan(1000);
  });

  it("returns nothing for a file without frontmatter", () => {
    expect(parseFrontmatter("# Title\n\nText.\n")).toEqual({});
  });

  it("collects every top-level key in raw, later duplicates winning", () => {
    expect(parseFrontmatter("---\ninclusion: fileMatch\nfileMatchPattern: '*.ts'\ninclusion: manual\n---\n").raw).toEqual({
      inclusion: "manual",
      fileMatchPattern: "*.ts",
    });
  });

  it("takes the first paragraph after the frontmatter, skipping headings, capped at 300 chars", () => {
    const long = "x".repeat(400);
    expect(parseFrontmatter("---\nname: n\n---\n# Heading\n\nFirst line\nsecond line\n\nNext.\n").firstParagraph).toBe("First line second line");
    expect(parseFrontmatter(`---\nname: n\n---\n${long}\n`).firstParagraph).toHaveLength(300);
  });
});

describe("bestDescription", () => {
  it("prefers a description of 20+ characters, else the first paragraph, else the short description", () => {
    expect(bestDescription({ description: "A long enough description.", firstParagraph: "p" })).toBe("A long enough description.");
    expect(bestDescription({ description: "short", firstParagraph: "The paragraph." })).toBe("The paragraph.");
    expect(bestDescription({ description: "exactly twenty chars", firstParagraph: "p" })).toBe("exactly twenty chars");
    expect(bestDescription({ description: "nineteen characters", firstParagraph: "p" })).toBe("p");
    expect(bestDescription({ description: "short" })).toBe("short");
    expect(bestDescription({})).toBeUndefined();
  });
});

describe("fileNameToDisplayName", () => {
  it("title-cases a slug", () => {
    expect(fileNameToDisplayName("code-review_notes.md")).toBe("Code Review Notes");
  });
});
