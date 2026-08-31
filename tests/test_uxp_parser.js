"use strict";

const assert = require("assert");
const Module = require("module");
const XLSX = require("../uxp_plugin/vendor/xlsx.full.min.js");

global.window = { addEventListener() {}, XLSX };
global.document = { getElementById() { return null; } };

const originalLoad = Module._load;
Module._load = function loadMock(request, parent, isMain) {
  if (request === "premierepro") {
    return { TickTime: { createWithSeconds(seconds) { return { seconds }; } } };
  }
  if (request === "uxp") {
    return { storage: { localFileSystem: {}, formats: {} } };
  }
  return originalLoad.apply(this, arguments);
};

const plugin = require("../uxp_plugin/index.js");

function assertInvalidDurationsFallBack(rows) {
  for (const row of rows) {
    assert.strictEqual(row.duration, null);
    assert.strictEqual(row.parseWarnings.length, 1);
  }
}

const csvRows = plugin.parseCsvStoryboard(
  "file_name,start_time,duration,track_index\n" +
  "a.mp4,0,3초,1\n" +
  "b.mp4,5,0,1\n" +
  "c.mp4,10,broken,1\n"
);
assertInvalidDurationsFallBack(csvRows);

const workbook = XLSX.utils.book_new();
const sheet = XLSX.utils.aoa_to_sheet([
  ["file_name", "start_time", "duration", "track_index"],
  ["a.mp4", 0, "3초", 1],
  ["b.mp4", 5, 0, 1]
]);
XLSX.utils.book_append_sheet(workbook, sheet, "Storyboard");
const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
assertInvalidDurationsFallBack(plugin.parseXlsxStoryboard(bytes));

let action;
const mockProject = {
  lockedAccess(callback) { callback(); },
  executeTransaction(callback) {
    callback({ addAction(value) { action = value; } });
    return action.audioTrackIndex === -1;
  }
};
const mockEditor = {
  createOverwriteItemAction(projectItem, start, videoTrackIndex, audioTrackIndex) {
    return { projectItem, start, videoTrackIndex, audioTrackIndex };
  }
};
const failedAudioPlacement = plugin.placeOverwriteItem(
  mockProject,
  mockEditor,
  { id: "clip" },
  12,
  0,
  0
);
assert.strictEqual(failedAudioPlacement.success, false);
assert.match(failedAudioPlacement.failure, /false/);
const videoOnlyPlacement = plugin.placeOverwriteItem(
  mockProject,
  mockEditor,
  { id: "clip" },
  12,
  0,
  -1
);
assert.strictEqual(videoOnlyPlacement.success, true);

console.log("UXP parser and placement fallback tests passed");
