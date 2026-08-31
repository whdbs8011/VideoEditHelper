"use strict";

/** @type {import('@adobe/premierepro').premierepro} */
const ppro = require("premierepro");
const { localFileSystem, formats } = require("uxp").storage;

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

function parseOptionalDuration(value, rowNumber) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (!text) return { duration: null, warning: null };
  try {
    const duration = parseTime(value, "duration", rowNumber);
    if (duration <= 0) throw new Error("duration must be greater than zero");
    return { duration, warning: null };
  } catch (error) {
    console.warn(`Invalid optional duration at row ${rowNumber}: ${text}`);
    return {
      duration: null,
      warning: `${rowNumber}행 경고: duration 형식을 읽지 못해 원본 길이 유지 (${text})`
    };
  }
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
    const durationResult = parseOptionalDuration(source.duration, rowNumber);
    const trackText = (source.track_index || "").trim();
    const trackIndex = trackText ? Number(trackText) : 1;
    if (!Number.isInteger(trackIndex) || trackIndex < 1) {
      throw new Error(`${rowNumber}행: track_index는 1 이상의 정수여야 합니다.`);
    }
    rows.push({
      fileName,
      start: parseTime(source.start_time, "start_time", rowNumber),
      duration: durationResult.duration,
      track: trackIndex - 1,
      sourceRow: rowNumber,
      parseWarnings: durationResult.warning ? [durationResult.warning] : []
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
    const durationResult = parseOptionalDuration(get("duration"), rowNumber);
    const trackValue = get("track_index");
    const trackText = String(trackValue ?? "").trim();
    const trackIndex = trackText ? Number(trackValue) : 1;
    if (!Number.isInteger(trackIndex) || trackIndex < 1) {
      throw new Error(`${rowNumber}행: track_index는 1 이상의 정수여야 합니다.`);
    }
    rows.push({
      fileName,
      start: parseTime(get("start_time"), "start_time", rowNumber),
      duration: durationResult.duration,
      track: trackIndex - 1,
      sourceRow: rowNumber,
      parseWarnings: durationResult.warning ? [durationResult.warning] : []
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
    const parseWarnings = [];
    if (durationValue !== "" && durationValue !== null && durationValue !== undefined) {
      const durationResult = parseOptionalDuration(durationValue, rowNumber);
      duration = durationResult.duration;
      if (durationResult.warning) parseWarnings.push(durationResult.warning);
    } else if (endColumn !== undefined) {
      duration = parseLegacyTime(record[endColumn], "end_time", rowNumber) - start;
      if (duration <= 0) {
        parseWarnings.push(`${rowNumber}행 경고: 종료 시간이 시작 시간보다 늦지 않아 원본 길이 유지`);
        duration = null;
      }
    }
    rows.push({
      fileName,
      start,
      duration,
      track: 0,
      sourceRow: rowNumber,
      parseWarnings
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
  return String(value)
    .normalize("NFC")
    .replace(/\\/g, "/")
    .toLocaleLowerCase();
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
  stats = { folders: 0, files: 0, unreadableFolders: [] }
) {
  stats.folders += 1;
  let entries;
  try {
    entries = await folder.getEntries();
  } catch (error) {
    stats.unreadableFolders.push(relativePrefix || folder.name || "선택한 폴더");
    console.error(`Folder scan failed: ${relativePrefix}`, error);
    if (onProgress) onProgress(stats);
    return lookup;
  }
  for (const entry of entries) {
    const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    if (entry.isFolder) {
      await indexMedia(entry, lookup, relativePath, onProgress, stats);
    }
    else {
      stats.files += 1;
      if (onProgress && stats.files % 250 === 0) onProgress(stats);
      const lastDot = entry.name.lastIndexOf(".");
      const stem = lastDot > 0 ? entry.name.slice(0, lastDot) : entry.name;
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
  if (!relativePrefix && onProgress) onProgress(stats);
  return lookup;
}

function resolveMedia(rows, lookup) {
  const resolvedRows = [];
  const warnings = [];
  for (const row of rows) {
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
    if (!candidates.length) {
      warnings.push(`${row.sourceRow}행 건너뜀: 미디어 없음 (${row.fileName})`);
      continue;
    }
    if (candidates.length > 1) {
      warnings.push(`${row.sourceRow}행 건너뜀: 같은 이름의 후보가 여러 개임 (${row.fileName})`);
      continue;
    }
    resolvedRows.push({
      ...row,
      mediaPath: candidates[0].nativePath,
      usedTakeFallback,
      resolvedMediaName: candidates[0].name
    });
  }
  return { resolvedRows, warnings };
}

function samePath(left, right) {
  return foldPath(left) === foldPath(right);
}

function mediaPathSearchTerms(mediaPath) {
  const nativePath = String(mediaPath);
  const posixPath = nativePath.replace(/\\/g, "/");
  const fileName = posixPath.split("/").pop();
  return [...new Set([nativePath, posixPath, fileName].filter(Boolean))];
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error || "unknown error");
}

async function findMatchingClip(items, mediaPath, allowFileNameFallback = false) {
  const expectedName = String(mediaPath).replace(/\\/g, "/").split("/").pop();
  const nameMatches = [];
  for (const match of items) {
    try {
      const clip = ppro.ClipProjectItem.cast(match);
      if (clip && samePath(await clip.getMediaFilePath(), mediaPath)) return match;
      if (allowFileNameFallback && clip && foldPath(match.name) === foldPath(expectedName)) {
        nameMatches.push(match);
      }
    } catch (_) {
      // Folder and sequence items cannot be cast to ClipProjectItem.
    }
  }
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

async function findProjectItem(mediaPath, importBin = null) {
  for (const term of mediaPathSearchTerms(mediaPath)) {
    const matches = await ppro.ClipProjectItem.findItemsMatchingMediaPath(term, true);
    const exact = await findMatchingClip(matches, mediaPath);
    if (exact) return exact;
  }
  if (!importBin) return null;

  // Premiere may canonicalize a path (for example a volume or Unicode form)
  // immediately after import. The import bin is controlled by this panel, so
  // a single matching filename there is a safe fallback to its clip item.
  const binItems = await importBin.getItems();
  return findMatchingClip(binItems, mediaPath, true);
}

async function findProjectItemSafely(mediaPath, importBin = null) {
  try {
    return await findProjectItem(mediaPath, importBin);
  } catch (error) {
    console.error(`Project item lookup failed: ${mediaPath}`, error);
    return null;
  }
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
  const wantedId = await projectItem.getId();
  const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const itemStart = await items[index].getStartTime();
    if (Math.abs(itemStart.seconds - start) > 0.02) continue;
    const source = await items[index].getProjectItem();
    if (await source.getId() === wantedId) return items[index];
  }
  return null;
}

function placeOverwriteItem(project, editor, projectItem, start, videoTrackIndex, audioTrackIndex) {
  let success = false;
  let failure = "";
  try {
    project.lockedAccess(() => {
      success = project.executeTransaction(compound => {
        const action = editor.createOverwriteItemAction(
          projectItem,
          ppro.TickTime.createWithSeconds(start),
          videoTrackIndex,
          audioTrackIndex
        );
        compound.addAction(action);
      }, "Place storyboard clip");
    });
    if (!success) failure = "Premiere 트랜잭션이 false를 반환했습니다.";
  } catch (error) {
    failure = errorMessage(error);
    console.error(`Timeline placement failed at V${videoTrackIndex + 1}`, error);
  }
  return { success, failure };
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
  const scanStats = { folders: 0, files: 0, unreadableFolders: [] };
  await indexMedia(selectedMediaFolder, mediaLookup, "", stats => {
    setStatus(
      "working",
      "미디어 폴더를 검색 중…",
      `${stats.folders}개 폴더 / ${stats.files}개 파일 확인`
    );
  }, scanStats);
  const resolution = resolveMedia(rows, mediaLookup);
  let resolvedRows = resolution.resolvedRows;
  const warnings = [];
  for (const row of rows) warnings.push(...(row.parseWarnings || []));
  warnings.push(...resolution.warnings);
  if (scanStats.unreadableFolders.length) {
    warnings.push(
      `읽지 못한 미디어 폴더 ${scanStats.unreadableFolders.length}개를 건너뜀`
    );
  }
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
  const rowsWithTracks = [];
  for (const row of resolvedRows) {
    if (row.track >= videoTrackCount) {
      warnings.push(`${row.sourceRow}행 건너뜀: 시퀀스에 V${row.track + 1} 트랙이 없음`);
    } else {
      rowsWithTracks.push(row);
    }
  }
  resolvedRows = rowsWithTracks;

  const binName = document.getElementById("bin-name").value.trim() || "Storyboard Media";
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
    const item = await findProjectItemSafely(row.mediaPath);
    if (item) projectItemByPath.set(key, item);
    else {
      pendingKeys.add(key);
      missing.push({ key, mediaPath: row.mediaPath, sourceRow: row.sourceRow });
    }
  }

  let imported = 0;
  if (missing.length) {
    setStatus("working", "새 미디어를 Premiere에 임포트 중…", `${missing.length}개 파일`);
    let targetBin = null;
    try {
      targetBin = await getOrCreateBin(project, binName);
    } catch (error) {
      warnings.push(`미디어 임포트 빈을 만들지 못해 ${missing.length}개 파일을 건너뜀`);
      console.error(error);
    }

    let targetProjectItem = null;
    if (targetBin) {
      try {
        targetProjectItem = ppro.ProjectItem.cast(targetBin);
      } catch (error) {
        warnings.push(`미디어 임포트 빈을 사용할 수 없어 ${missing.length}개 파일을 건너뜀`);
        console.error(error);
      }
    }

    if (targetProjectItem) {
      try {
        await project.importFiles(
          missing.map(candidate => candidate.mediaPath),
          true,
          targetProjectItem,
          false
        );
      } catch (error) {
        console.error("Batch import failed; retrying individually", error);
      }

      for (const candidate of missing) {
        let item = await findProjectItemSafely(candidate.mediaPath, targetBin);
        if (!item) {
          try {
            const importedOne = await project.importFiles(
              [candidate.mediaPath],
              true,
              targetProjectItem,
              false
            );
            if (importedOne) item = await findProjectItemSafely(candidate.mediaPath, targetBin);
          } catch (error) {
            console.error(`Import failed: ${candidate.mediaPath}`, error);
          }
        }
        if (item) {
          imported += 1;
          projectItemByPath.set(candidate.key, item);
        }
      }
    }
  }

  const timelineRows = [];
  for (const row of resolvedRows) {
    const projectItem = projectItemByPath.get(foldPath(row.mediaPath));
    if (!projectItem) {
      warnings.push(`${row.sourceRow}행 건너뜀: Premiere 임포트 실패 (${row.resolvedMediaName})`);
    } else {
      timelineRows.push({ row, projectItem });
    }
  }

  setStatus("working", "Premiere 타임라인에 배치 중…");
  const editor = timelineRows.length ? ppro.SequenceEditor.getEditor(sequence) : null;
  const placeAudio = document.getElementById("place-audio").checked;
  let placed = 0;
  for (let index = 0; index < timelineRows.length; index += 1) {
    const { row, projectItem } = timelineRows[index];
    if (index % 5 === 0) {
      setStatus(
        "working",
        "Premiere 타임라인에 배치 중…",
        `${index}/${timelineRows.length}`
      );
    }
    let audioTrackIndex = placeAudio && audioTrackCount > 0
      ? Math.min(row.track, audioTrackCount - 1)
      : -1;
    let placement = placeOverwriteItem(
      project,
      editor,
      projectItem,
      row.start,
      row.track,
      audioTrackIndex
    );
    if (!placement.success && audioTrackIndex >= 0) {
      const videoOnly = placeOverwriteItem(
        project,
        editor,
        projectItem,
        row.start,
        row.track,
        -1
      );
      if (videoOnly.success) {
        placement = videoOnly;
        audioTrackIndex = -1;
        warnings.push(`${row.sourceRow}행 경고: 오디오 없이 비디오만 배치`);
      }
    }
    if (!placement.success) {
      warnings.push(
        `${row.sourceRow}행 건너뜀: V${row.track + 1} 타임라인 배치 실패 ` +
        `(${placement.failure})`
      );
      continue;
    }
    try {
      await trimPlacedItems(project, sequence, row, projectItem, audioTrackIndex);
    } catch (error) {
      console.error(`Trim failed for row ${row.sourceRow}`, error);
      warnings.push(`${row.sourceRow}행 경고: duration 적용 실패로 원본 길이 유지`);
    }
    placed += 1;
  }

  if (document.getElementById("save-project").checked && !(await project.save())) {
    throw new Error("타임라인은 생성했지만 프로젝트 저장에 실패했습니다.");
  }
  return {
    placed,
    imported,
    sequence: sequence.name,
    takeFallbacks: takeFallbackCount,
    skipped: rows.length - placed,
    warnings
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
      const skippedDetails = result.skipped ? ` / 빈 구간 ${result.skipped}개` : "";
      const warningDetails = result.warnings.length
        ? `\n${result.warnings.slice(0, 20).join("\n")}${result.warnings.length > 20 ? "\n…" : ""}`
        : "";
      setStatus(
        result.skipped || result.warnings.length ? "warning" : "success",
        `완료: ${result.placed}개 배치, ${result.imported}개 임포트, ${result.skipped}개 건너뜀`,
        `시퀀스: ${result.sequence}${takeDetails}${skippedDetails}${warningDetails}`
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
    findProjectItem,
    indexMedia,
    mediaPathSearchTerms,
    placeOverwriteItem,
    parseCsvStoryboard,
    parseLegacyMatrix,
    parseNormalizedMatrix,
    parseOptionalDuration,
    parseXlsxStoryboard,
    resolveMedia
  };
}
