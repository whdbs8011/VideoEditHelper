"use strict";

/** @type {import('@adobe/premierepro').premierepro} */
const ppro = require("premierepro");
const { localFileSystem, formats } = require("uxp").storage;

const MEDIA_EXTENSIONS = new Set([
  "avi", "jpeg", "jpg", "m4v", "mkv", "mov", "mp4", "mxf",
  "png", "tif", "tiff", "wav", "webm"
]);

let selectedStoryboard = null;
let selectedMediaFolder = null;

function setStatus(kind, message, details = "") {
  const status = document.getElementById("status");
  status.className = `status ${kind}`;
  status.textContent = message;
  document.getElementById("details").textContent = details;
}

function parseCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field.replace(/\r$/, ""));
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV에 닫히지 않은 따옴표가 있습니다.");
  if (field || record.length) {
    record.push(field.replace(/\r$/, ""));
    records.push(record);
  }
  return records;
}

function parseTime(value, fieldName, rowNumber) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (!text) throw new Error(`${rowNumber}행: ${fieldName} 값이 비어 있습니다.`);
  let seconds;
  const match = /^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/.exec(text);
  if (match) seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  else seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`${rowNumber}행: ${fieldName}은 0 이상의 초 또는 HH:MM:SS여야 합니다.`);
  }
  return seconds;
}

function validateMediaRequest(value, rowNumber) {
  const fileName = String(value ?? "").trim();
  if (!fileName) throw new Error(`${rowNumber}행: file_name 값이 비어 있습니다.`);
  const normalized = fileName.replace(/\\/g, "/");
  if (/^(?:\/|[A-Za-z]:\/)/.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`${rowNumber}행: file_name은 미디어 폴더 기준 상대 경로여야 합니다.`);
  }
  return fileName;
}

function parseCsvStoryboard(text) {
  const records = parseCsv(text.replace(/^\uFEFF/, ""));
  if (!records.length) throw new Error("CSV가 비어 있습니다.");
  const headers = records[0].map(value => value.trim());
  for (const required of ["file_name", "start_time"]) {
    if (!headers.includes(required)) throw new Error(`필수 CSV 열이 없습니다: ${required}`);
  }
  const rows = [];
  for (let index = 1; index < records.length; index += 1) {
    if (records[index].every(value => !value.trim())) continue;
    const source = Object.fromEntries(headers.map((header, column) => [header, records[index][column] || ""]));
    const rowNumber = index + 1;
    const fileName = validateMediaRequest(source.file_name, rowNumber);
    const durationText = (source.duration || "").trim();
    const duration = durationText ? parseTime(durationText, "duration", rowNumber) : null;
    if (duration === 0) throw new Error(`${rowNumber}행: duration은 0보다 커야 합니다.`);
    const trackText = (source.track_index || "").trim();
    const trackIndex = trackText ? Number(trackText) : 1;
    if (!Number.isInteger(trackIndex) || trackIndex < 1) {
      throw new Error(`${rowNumber}행: track_index는 1 이상의 정수여야 합니다.`);
    }
    rows.push({
      fileName,
      start: parseTime(source.start_time, "start_time", rowNumber),
      duration,
      track: trackIndex - 1,
      sourceRow: rowNumber
    });
  }
  if (!rows.length) throw new Error("CSV에 데이터 행이 없습니다.");
  return rows;
}

function normalizeHeader(value) {
  return String(value === null || value === undefined ? "" : value)
    .normalize("NFC")
    .replace(/\s+/g, "")
    .toLocaleLowerCase();
}

function headerMap(record) {
  const result = new Map();
  record.forEach((value, column) => {
    const normalized = normalizeHeader(value);
    if (normalized) result.set(normalized, column);
  });
  return result;
}

function parseNormalizedMatrix(records, headerIndex, headers) {
  const rows = [];
  for (let index = headerIndex + 1; index < records.length; index += 1) {
    const record = records[index] || [];
    if (record.every(value => value === "" || value === null || value === undefined)) continue;
    const rowNumber = index + 1;
    const get = name => headers.has(name) ? record[headers.get(name)] : "";
    const fileName = validateMediaRequest(get("file_name"), rowNumber);
    const durationValue = get("duration");
    const durationText = String(durationValue ?? "").trim();
    const duration = durationText ? parseTime(durationValue, "duration", rowNumber) : null;
    if (duration === 0) throw new Error(`${rowNumber}행: duration은 0보다 커야 합니다.`);
    const trackValue = get("track_index");
    const trackText = String(trackValue ?? "").trim();
    const trackIndex = trackText ? Number(trackValue) : 1;
    if (!Number.isInteger(trackIndex) || trackIndex < 1) {
      throw new Error(`${rowNumber}행: track_index는 1 이상의 정수여야 합니다.`);
    }
    rows.push({
      fileName,
      start: parseTime(get("start_time"), "start_time", rowNumber),
      duration,
      track: trackIndex - 1,
      sourceRow: rowNumber
    });
  }
  return rows;
}

function parseLegacyTime(value, fieldName, rowNumber) {
  if (typeof value === "number") {
    const seconds = Math.round(value * 86400 * 1000000) / 1000000;
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  }
  return parseTime(value, fieldName, rowNumber);
}

function assignLegacyTracks(rows) {
  const trackEnds = [];
  const chronological = rows.map((_, index) => index).sort((left, right) =>
    rows[left].start - rows[right].start || rows[left].sourceRow - rows[right].sourceRow
  );
  for (const rowIndex of chronological) {
    const row = rows[rowIndex];
    const end = row.start + (row.duration === null ? 0 : row.duration);
    let track = trackEnds.findIndex(trackEnd => trackEnd <= row.start + 0.000001);
    if (track < 0) {
      track = trackEnds.length;
      trackEnds.push(end);
    } else {
      trackEnds[track] = end;
    }
    row.track = track;
  }
  return rows;
}

function parseLegacyMatrix(records, headerIndex, headers) {
  const rows = [];
  const cutColumn = headers.get("컷번호");
  const startColumn = headers.get("시작시간");
  const durationColumn = headers.has("길이(초)") ? headers.get("길이(초)") : headers.get("길이초");
  const endColumn = headers.get("종료시간");
  for (let index = headerIndex + 1; index < records.length; index += 1) {
    const record = records[index] || [];
    const cutValue = record[cutColumn];
    if (cutValue === "" || cutValue === null || cutValue === undefined) continue;
    const rowNumber = index + 1;
    const fileName = validateMediaRequest(cutValue, rowNumber);
    const start = parseLegacyTime(record[startColumn], "start_time", rowNumber);
    const durationValue = durationColumn === undefined ? "" : record[durationColumn];
    let duration = null;
    if (durationValue !== "" && durationValue !== null && durationValue !== undefined) {
      duration = parseTime(durationValue, "duration", rowNumber);
    } else if (endColumn !== undefined) {
      duration = parseLegacyTime(record[endColumn], "end_time", rowNumber) - start;
    }
    if (duration !== null && duration <= 0) {
      throw new Error(`${rowNumber}행: duration은 0보다 커야 합니다.`);
    }
    rows.push({
      fileName,
      start,
      duration,
      track: 0,
      sourceRow: rowNumber
    });
  }
  return assignLegacyTracks(rows);
}

function parseXlsxStoryboard(arrayBuffer) {
  if (!window.XLSX) throw new Error("내장 XLSX 모듈을 불러오지 못했습니다.");
  const workbook = window.XLSX.read(new Uint8Array(arrayBuffer), {
    type: "array",
    cellDates: false
  });
  let legacyCandidate = null;
  for (const sheetName of workbook.SheetNames) {
    const records = window.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      raw: true,
      defval: ""
    });
    for (let index = 0; index < records.length; index += 1) {
      const headers = headerMap(records[index] || []);
      if (headers.has("file_name") && headers.has("start_time")) {
        const rows = parseNormalizedMatrix(records, index, headers);
        if (rows.length) return rows;
      }
      const hasLegacyDuration = headers.has("길이(초)") || headers.has("길이초") || headers.has("종료시간");
      if (headers.has("컷번호") && headers.has("시작시간") && hasLegacyDuration) {
        legacyCandidate = { records, headerIndex: index, headers };
      }
    }
  }
  if (legacyCandidate) {
    const rows = parseLegacyMatrix(
      legacyCandidate.records,
      legacyCandidate.headerIndex,
      legacyCandidate.headers
    );
    if (rows.length) return rows;
  }
  throw new Error("XLSX에서 file_name/start_time 또는 컷 번호/시작 시간/길이(초) 머리글을 찾지 못했습니다.");
}

async function parseStoryboardFile(file) {
  const extension = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "";
  if (extension === "csv") return parseCsvStoryboard(await file.read());
  if (extension === "xlsx") {
    return parseXlsxStoryboard(await file.read({ format: formats.binary }));
  }
  throw new Error(`지원하지 않는 스토리보드 형식입니다: .${extension || "(없음)"}`);
}

function foldPath(value) {
  return String(value).replace(/\\/g, "/").toLocaleLowerCase();
}

function appendLookup(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function createMediaLookup(rows) {
  const requestedRelative = new Set();
  const requestedNames = new Set();
  const requestedStems = new Set();
  for (const row of rows) {
    const requested = foldPath(row.fileName);
    requestedRelative.add(requested);
    const basename = requested.split("/").pop();
    if (/\.[^/]+$/.test(requested)) requestedNames.add(basename);
    else requestedStems.add(basename);
  }
  return {
    requestedRelative,
    requestedNames,
    requestedStems,
    byRelative: new Map(),
    byName: new Map(),
    byStem: new Map(),
    byTake: new Map()
  };
}

async function indexMedia(
  folder,
  lookup,
  relativePrefix = "",
  onProgress = null,
  stats = { folders: 0, files: 0 }
) {
  stats.folders += 1;
  const entries = await folder.getEntries();
  for (const entry of entries) {
    const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    if (entry.isFolder) {
      await indexMedia(entry, lookup, relativePath, onProgress, stats);
    }
    else {
      stats.files += 1;
      if (onProgress && stats.files % 250 === 0) onProgress(stats);
      const extension = entry.name.includes(".") ? entry.name.split(".").pop().toLowerCase() : "";
      if (MEDIA_EXTENSIONS.has(extension)) {
        const stem = entry.name.slice(0, -(extension.length + 1));
        const relativeKey = foldPath(relativePath);
        const nameKey = foldPath(entry.name);
        const stemKey = foldPath(stem);
        const matchesRelative = lookup.requestedRelative.has(relativeKey);
        const matchesName = lookup.requestedNames.has(nameKey);
        const matchesStem = lookup.requestedStems.has(stemKey);
        const takeMatch = /^(.*)-(\d+)$/.exec(stemKey);
        const matchesTake = takeMatch && lookup.requestedStems.has(takeMatch[1]);
        if (!matchesRelative && !matchesName && !matchesStem && !matchesTake) continue;
        const record = {
          name: entry.name,
          stem,
          relativePath,
          nativePath: localFileSystem.getNativePath(entry)
        };
        if (matchesRelative) {
          appendLookup(lookup.byRelative, relativeKey, record);
        }
        if (matchesName) {
          appendLookup(lookup.byName, nameKey, record);
        }
        if (matchesStem) {
          appendLookup(lookup.byStem, stemKey, record);
        }
        if (matchesTake) {
          appendLookup(lookup.byTake, takeMatch[1], {
            record,
            take: Number(takeMatch[2])
          });
        }
      }
    }
  }
  if (!relativePrefix && onProgress) onProgress(stats);
  return lookup;
}

function resolveMedia(rows, lookup) {
  return rows.map(row => {
    const requested = foldPath(row.fileName);
    const hasExtension = /\.[^/]+$/.test(requested);
    let candidates = lookup.byRelative.get(requested) || [];
    if (!candidates.length) {
      const basename = requested.split("/").pop();
      candidates = (hasExtension ? lookup.byName : lookup.byStem).get(basename) || [];
    }
    let usedTakeFallback = false;
    if (!candidates.length && !hasExtension) {
      const basename = requested.split("/").pop();
      const takeMatches = lookup.byTake.get(basename) || [];
      if (takeMatches.length) {
        const highestTake = takeMatches.reduce(
          (highest, candidate) => Math.max(highest, candidate.take),
          -1
        );
        candidates = takeMatches
          .filter(candidate => candidate.take === highestTake)
          .map(candidate => candidate.record);
        usedTakeFallback = true;
      }
    }
    if (!candidates.length) throw new Error(`${row.sourceRow}행: 미디어를 찾을 수 없습니다: ${row.fileName}`);
    if (candidates.length > 1) {
      throw new Error(`${row.sourceRow}행: 같은 이름의 미디어가 여러 개입니다. 상대 경로를 쓰세요: ${row.fileName}`);
    }
    return {
      ...row,
      mediaPath: candidates[0].nativePath,
      usedTakeFallback,
      resolvedMediaName: candidates[0].name
    };
  });
}

function samePath(left, right) {
  return foldPath(left) === foldPath(right);
}

async function findProjectItem(mediaPath) {
  const matches = await ppro.ClipProjectItem.findItemsMatchingMediaPath(mediaPath, true);
  for (const match of matches) {
    try {
      const clip = ppro.ClipProjectItem.cast(match);
      if (clip && samePath(await clip.getMediaFilePath(), mediaPath)) return match;
    } catch (_) {}
  }
  return null;
}

async function asFolder(item) {
  try {
    const folder = ppro.FolderItem.cast(item);
    await folder.getItems();
    return folder;
  } catch (_) {
    return null;
  }
}

async function getOrCreateBin(project, name) {
  const root = await project.getRootItem();
  for (const item of await root.getItems()) {
    if (item.name === name) {
      const folder = await asFolder(item);
      if (folder) return folder;
    }
  }
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction(compound => {
      compound.addAction(root.createBinAction(name, false));
    }, `Create ${name} bin`);
  });
  if (!success) throw new Error(`프로젝트 빈을 만들지 못했습니다: ${name}`);
  for (const item of await root.getItems()) {
    if (item.name === name) {
      const folder = await asFolder(item);
      if (folder) return folder;
    }
  }
  throw new Error(`생성한 프로젝트 빈을 찾지 못했습니다: ${name}`);
}

async function selectSequence(project, requestedName) {
  if (!requestedName) {
    const active = await project.getActiveSequence();
    if (!active) throw new Error("활성 시퀀스가 없습니다.");
    return active;
  }
  const sequences = await project.getSequences();
  const found = sequences.find(sequence => sequence.name === requestedName);
  if (!found) throw new Error(`시퀀스를 찾을 수 없습니다: ${requestedName}`);
  await project.setActiveSequence(found);
  await project.openSequence(found);
  return found;
}

async function findPlacedTrackItem(track, projectItem, start) {
  const wantedId = projectItem.getId();
  const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const itemStart = await items[index].getStartTime();
    if (Math.abs(itemStart.seconds - start) > 0.02) continue;
    const source = await items[index].getProjectItem();
    if (source.getId() === wantedId) return items[index];
  }
  return null;
}

async function trimPlacedItems(project, sequence, row, projectItem, audioTrackIndex) {
  if (row.duration === null) return;
  const end = ppro.TickTime.createWithSeconds(row.start + row.duration);
  const videoTrack = await sequence.getVideoTrack(row.track);
  const videoItem = await findPlacedTrackItem(videoTrack, projectItem, row.start);
  const trimTargets = videoItem ? [videoItem] : [];
  if (audioTrackIndex >= 0) {
    const audioTrack = await sequence.getAudioTrack(audioTrackIndex);
    const audioItem = await findPlacedTrackItem(audioTrack, projectItem, row.start);
    if (audioItem) trimTargets.push(audioItem);
  }
  if (!trimTargets.length) throw new Error(`${row.sourceRow}행: 배치한 클립을 duration에 맞게 자르지 못했습니다.`);

  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction(compound => {
      for (const target of trimTargets) compound.addAction(target.createSetEndAction(end));
    }, "Trim storyboard clip");
  });
  if (!success) throw new Error(`${row.sourceRow}행: 클립 duration 적용에 실패했습니다.`);
}

async function buildTimeline() {
  if (!selectedStoryboard || !selectedMediaFolder) throw new Error("스토리보드 파일과 미디어 폴더를 먼저 선택하세요.");
  setStatus("working", "스토리보드와 미디어 파일을 확인 중…");
  const rows = await parseStoryboardFile(selectedStoryboard);
  const mediaLookup = createMediaLookup(rows);
  await indexMedia(selectedMediaFolder, mediaLookup, "", stats => {
    setStatus(
      "working",
      "미디어 폴더를 검색 중…",
      `${stats.folders}개 폴더 / ${stats.files}개 파일 확인`
    );
  });
  const resolvedRows = resolveMedia(rows, mediaLookup);
  const takeFallbackCount = resolvedRows.filter(row => row.usedTakeFallback).length;
  if (takeFallbackCount) {
    setStatus(
      "working",
      "대체 테이크를 선택했습니다.",
      `정확한 파일이 없던 ${takeFallbackCount}개 컷에서 가장 높은 테이크 사용`
    );
  }

  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("열린 Premiere 프로젝트가 없습니다.");
  const sequenceName = document.getElementById("sequence-name").value.trim();
  const sequence = await selectSequence(project, sequenceName);
  const videoTrackCount = await sequence.getVideoTrackCount();
  const audioTrackCount = await sequence.getAudioTrackCount();
  for (const row of resolvedRows) {
    if (row.track >= videoTrackCount) {
      throw new Error(`${row.sourceRow}행: V${row.track + 1} 트랙이 시퀀스에 없습니다.`);
    }
  }

  const binName = document.getElementById("bin-name").value.trim() || "Storyboard Media";
  const targetBin = await getOrCreateBin(project, binName);
  const projectItemByPath = new Map();
  const missing = [];
  const pendingKeys = new Set();
  for (let index = 0; index < resolvedRows.length; index += 1) {
    const row = resolvedRows[index];
    if (index % 10 === 0) {
      setStatus(
        "working",
        "Premiere 프로젝트의 미디어를 확인 중…",
        `${index}/${resolvedRows.length}`
      );
    }
    const key = foldPath(row.mediaPath);
    if (projectItemByPath.has(key) || pendingKeys.has(key)) continue;
    const item = await findProjectItem(row.mediaPath);
    if (item) projectItemByPath.set(key, item);
    else {
      pendingKeys.add(key);
      missing.push({ key, mediaPath: row.mediaPath, sourceRow: row.sourceRow });
    }
  }

  let imported = 0;
  if (missing.length) {
    setStatus("working", "새 미디어를 Premiere에 임포트 중…", `${missing.length}개 파일`);
    const ok = await project.importFiles(
      missing.map(candidate => candidate.mediaPath),
      true,
      ppro.ProjectItem.cast(targetBin),
      false
    );
    if (!ok) throw new Error(`${missing.length}개 미디어의 일괄 임포트에 실패했습니다.`);
    imported = missing.length;
    for (const candidate of missing) {
      const item = await findProjectItem(candidate.mediaPath);
      if (!item) throw new Error(`${candidate.sourceRow}행: 임포트한 프로젝트 항목을 찾지 못했습니다.`);
      projectItemByPath.set(candidate.key, item);
    }
  }
  const projectItems = resolvedRows.map(row => projectItemByPath.get(foldPath(row.mediaPath)));

  setStatus("working", "Premiere 타임라인에 배치 중…");
  const editor = ppro.SequenceEditor.getEditor(sequence);
  const placeAudio = document.getElementById("place-audio").checked;
  for (let index = 0; index < resolvedRows.length; index += 1) {
    const row = resolvedRows[index];
    if (index % 5 === 0) {
      setStatus(
        "working",
        "Premiere 타임라인에 배치 중…",
        `${index}/${resolvedRows.length}`
      );
    }
    const audioTrackIndex = placeAudio && audioTrackCount > 0 ? Math.min(row.track, audioTrackCount - 1) : -1;
    let success = false;
    project.lockedAccess(() => {
      success = project.executeTransaction(compound => {
        compound.addAction(editor.createOverwriteItemAction(
          projectItems[index],
          ppro.TickTime.createWithSeconds(row.start),
          row.track,
          audioTrackIndex
        ));
      }, "Place storyboard clip");
    });
    if (!success) throw new Error(`${row.sourceRow}행: 타임라인 배치에 실패했습니다.`);
    await trimPlacedItems(project, sequence, row, projectItems[index], audioTrackIndex);
  }

  if (document.getElementById("save-project").checked && !(await project.save())) {
    throw new Error("타임라인은 생성했지만 프로젝트 저장에 실패했습니다.");
  }
  return {
    placed: resolvedRows.length,
    imported,
    sequence: sequence.name,
    takeFallbacks: takeFallbackCount
  };
}

window.addEventListener("load", () => {
  document.getElementById("pick-storyboard").addEventListener("click", async () => {
    selectedStoryboard = await localFileSystem.getFileForOpening({ types: ["csv", "xlsx"] });
    if (selectedStoryboard) {
      document.getElementById("storyboard-path").value = localFileSystem.getNativePath(selectedStoryboard);
    }
  });

  document.getElementById("pick-media").addEventListener("click", async () => {
    selectedMediaFolder = await localFileSystem.getFolder();
    if (selectedMediaFolder) {
      document.getElementById("media-root").value = localFileSystem.getNativePath(selectedMediaFolder);
    }
  });

  const buildButton = document.getElementById("build");
  buildButton.addEventListener("click", async () => {
    buildButton.disabled = true;
    setStatus("working", "작업을 시작하는 중…");
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      const result = await buildTimeline();
      const takeDetails = result.takeFallbacks
        ? ` / 대체 테이크 ${result.takeFallbacks}개`
        : "";
      setStatus(
        "success",
        `완료: ${result.placed}개 배치, ${result.imported}개 임포트`,
        `시퀀스: ${result.sequence}${takeDetails}`
      );
    } catch (error) {
      console.error(error);
      setStatus("error", "실행 실패", error && error.message ? error.message : String(error));
    } finally {
      buildButton.disabled = false;
    }
  });
});

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    assignLegacyTracks,
    createMediaLookup,
    indexMedia,
    parseCsvStoryboard,
    parseLegacyMatrix,
    parseNormalizedMatrix,
    parseXlsxStoryboard,
    resolveMedia
  };
}
