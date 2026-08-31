"use strict";

/** @type {import('@adobe/premierepro').premierepro} */
const ppro = require("premierepro");
const { localFileSystem } = require("uxp").storage;

const MEDIA_EXTENSIONS = new Set([
  "avi", "jpeg", "jpg", "m4v", "mkv", "mov", "mp4", "mxf",
  "png", "tif", "tiff", "wav", "webm"
]);

let selectedCsv = null;
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
  const text = String(value || "").trim();
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

function parseStoryboard(text) {
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
    const fileName = source.file_name.trim();
    if (!fileName) throw new Error(`${rowNumber}행: file_name 값이 비어 있습니다.`);
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

async function indexMedia(folder, relativePrefix = "", output = []) {
  const entries = await folder.getEntries();
  for (const entry of entries) {
    const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    if (entry.isFolder) await indexMedia(entry, relativePath, output);
    else {
      const extension = entry.name.includes(".") ? entry.name.split(".").pop().toLowerCase() : "";
      if (MEDIA_EXTENSIONS.has(extension)) {
        output.push({
          name: entry.name,
          stem: entry.name.slice(0, -(extension.length + 1)),
          relativePath,
          nativePath: localFileSystem.getNativePath(entry)
        });
      }
    }
  }
  return output;
}

function resolveMedia(rows, mediaFiles) {
  const folded = value => value.replace(/\\/g, "/").toLocaleLowerCase();
  return rows.map(row => {
    const requested = folded(row.fileName);
    const hasExtension = /\.[^/]+$/.test(requested);
    let candidates = mediaFiles.filter(file => folded(file.relativePath) === requested);
    if (!candidates.length) {
      candidates = mediaFiles.filter(file =>
        hasExtension ? folded(file.name) === requested.split("/").pop() : folded(file.stem) === requested.split("/").pop()
      );
    }
    if (!candidates.length) throw new Error(`${row.sourceRow}행: 미디어를 찾을 수 없습니다: ${row.fileName}`);
    if (candidates.length > 1) {
      throw new Error(`${row.sourceRow}행: 같은 이름의 미디어가 여러 개입니다. 상대 경로를 쓰세요: ${row.fileName}`);
    }
    return { ...row, mediaPath: candidates[0].nativePath };
  });
}

function samePath(left, right) {
  const normalize = value => String(value).replace(/\\/g, "/").toLocaleLowerCase();
  return normalize(left) === normalize(right);
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
  if (!selectedCsv || !selectedMediaFolder) throw new Error("CSV와 미디어 폴더를 먼저 선택하세요.");
  setStatus("working", "CSV와 미디어 파일을 확인 중…");
  const rows = parseStoryboard(await selectedCsv.read());
  const resolvedRows = resolveMedia(rows, await indexMedia(selectedMediaFolder));

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
  const projectItems = [];
  let imported = 0;
  for (const row of resolvedRows) {
    let item = await findProjectItem(row.mediaPath);
    if (!item) {
      const ok = await project.importFiles([row.mediaPath], true, ppro.ProjectItem.cast(targetBin), false);
      if (!ok) throw new Error(`${row.sourceRow}행: 임포트 실패: ${row.mediaPath}`);
      imported += 1;
      item = await findProjectItem(row.mediaPath);
      if (!item) throw new Error(`${row.sourceRow}행: 임포트한 프로젝트 항목을 찾지 못했습니다.`);
    }
    projectItems.push(item);
  }

  setStatus("working", "Premiere 타임라인에 배치 중…");
  const editor = ppro.SequenceEditor.getEditor(sequence);
  const placeAudio = document.getElementById("place-audio").checked;
  for (let index = 0; index < resolvedRows.length; index += 1) {
    const row = resolvedRows[index];
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
  return { placed: resolvedRows.length, imported, sequence: sequence.name };
}

window.addEventListener("load", () => {
  document.getElementById("pick-csv").addEventListener("click", async () => {
    selectedCsv = await localFileSystem.getFileForOpening({ types: ["csv"] });
    if (selectedCsv) document.getElementById("csv-path").value = selectedCsv.nativePath;
  });

  document.getElementById("pick-media").addEventListener("click", async () => {
    selectedMediaFolder = await localFileSystem.getFolder();
    if (selectedMediaFolder) document.getElementById("media-root").value = selectedMediaFolder.nativePath;
  });

  document.getElementById("build").addEventListener("click", async event => {
    event.currentTarget.disabled = true;
    try {
      const result = await buildTimeline();
      setStatus("success", `완료: ${result.placed}개 배치, ${result.imported}개 임포트`, `시퀀스: ${result.sequence}`);
    } catch (error) {
      console.error(error);
      setStatus("error", "실행 실패", error && error.message ? error.message : String(error));
    } finally {
      event.currentTarget.disabled = false;
    }
  });
});
