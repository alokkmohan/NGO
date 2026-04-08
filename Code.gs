// ══════════════════════════════════════════════════════════════
// SAMAGRA NGO PORTAL — Google Apps Script Backend
// ══════════════════════════════════════════════════════════════
// SETUP STEPS:
// 1. Replace SHEET_ID below with your Google Spreadsheet ID
// 2. Replace DRIVE_FOLDER_ID below with your Drive folder ID
// 3. In Apps Script: Deploy → New Deployment → Web App
//    Execute as: Me | Who has access: Anyone
// 4. Copy the Web App URL into index.html (SCRIPT_URL variable)
// ══════════════════════════════════════════════════════════════

const SHEET_ID        = '1fESLu2sjfmKuszrSUZgCjt296gf2GRTSAMkb2uv7F_M';
const DRIVE_FOLDER_ID = '151IYtuGpaXal0DiInwUGyaGl7ZX51HD7';

// ── ROUTER ──────────────────────────────────────────────────
// GET handles everything except photo upload (too large for URL)
function doGet(e) {
  try {
    const p      = e.parameter;
    const action = p.action;
    if (action === 'getNGOs')      return respond(getNGOs());
    if (action === 'getReports')   return respond(getReports());
    if (action === 'getNGOList')   return respond(getNGOList());
    if (action === 'login')        return respond(login(p));
    if (action === 'saveProfile')  return respond(saveProfile(p));
    if (action === 'submitReport') return respond(submitReport({ report: JSON.parse(p.report) }));
    return respond({ error: 'Unknown action', received_action: action, all_params: JSON.stringify(p) });
  } catch (err) {
    return respond({ error: err.message });
  }
}

// POST only used for photo upload (base64 payload too large for URL)
function doPost(e) {
  try {
    const data   = JSON.parse(e.postData.contents);
    const action = data.action;
    if (action === 'uploadPhoto') return respond(uploadPhoto(data));
    return respond({ error: 'Unknown action' });
  } catch (err) {
    return respond({ error: err.message });
  }
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── LOGIN ────────────────────────────────────────────────────
// Users sheet columns: email | password | role | name | org
function login(data) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Users');
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const [email, password, role, name, org] = rows[i];
    if (email === data.email && String(password) === String(data.password)) {
      // Admin always allowed; NGO partners checked against NGO_List status
      if (role !== 'admin' && !isNGOActive(org)) {
        return { success: false, error: 'Your organisation is currently inactive. Please contact PMU Admin.' };
      }
      return { success: true, user: { email, role, name, org, profileDone: true } };
    }
  }
  return { success: false, error: 'Invalid email or password' };
}

// ── GET NGO MASTER LIST (for signup dropdown) ────────────────
// NGO_List sheet columns: sr_no | name | status (active/inactive)
function getNGOList() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('NGO_List');
  if (!sheet) return { success: true, data: [] };
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return { success: true, data: [] };
  const data = rows.slice(1)
    .filter(r => r[1] && String(r[2]).toLowerCase().trim() === 'active')  // only active NGOs
    .map(r => ({ sr: r[0], name: String(r[1]).trim() }));
  return { success: true, data };
}

// Check if NGO is active in NGO_List
function isNGOActive(orgName) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('NGO_List');
  if (!sheet) return true; // if no list, allow
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]).trim().toLowerCase() === orgName.trim().toLowerCase()) {
      return String(rows[i][2]).toLowerCase().trim() === 'active';
    }
  }
  return true; // admin users not in NGO_List are always allowed
}

// ── GET NGOs ─────────────────────────────────────────────────
// NGOs sheet columns: id|name|theme|person|dist|x|y|schools|students|girls|teachers|progress|month|kmi
function getNGOs() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('NGOs');
  const rows  = sheet.getDataRange().getValues();
  if (rows.length < 2) return { success: true, data: [] };
  const headers = rows[0];
  const data    = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
  return { success: true, data };
}

// ── GET REPORTS ──────────────────────────────────────────────
// Reports sheet columns: id|ngo|month|schools|students|girls|teachers|meetings|events|
//   scst|divyang|budget|dropout|tasks|status|kmi|achieve|challenges|support|plans|
//   photos_count|photos_folder|submitted
function getReports() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Reports');
  const rows  = sheet.getDataRange().getValues();
  if (rows.length < 2) return { success: true, data: [] };
  const headers = rows[0];
  const data    = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
  return { success: true, data };
}

// ── SUBMIT REPORT ────────────────────────────────────────────
function submitReport(data) {
  const ss     = SpreadsheetApp.openById(SHEET_ID);
  const rSheet = ss.getSheetByName('Reports');
  const r      = data.report;

  rSheet.appendRow([
    new Date().getTime(),
    r.ngo, r.month,
    r.schools  || 0, r.students  || 0, r.girls   || 0, r.teachers || 0,
    r.meetings || 0, r.events    || 0, r.scst     || 0, r.divyang  || 0,
    r.budget   || 0, r.dropout   || 0,
    r.tasks    || '', r.status   || '',
    r.kmi      || '', r.achieve  || '', r.challenges || '',
    r.support  || '', r.plans    || '',
    r.photos_count  || 0,
    r.photos_folder || '',
    new Date().toLocaleDateString('en-IN')
  ]);

  // Update latest values in NGOs sheet
  const nSheet = ss.getSheetByName('NGOs');
  const nRows  = nSheet.getDataRange().getValues();
  for (let i = 1; i < nRows.length; i++) {
    if (nRows[i][1] === r.ngo) {
      if (r.schools)  nSheet.getRange(i + 1,  8).setValue(+r.schools);
      if (r.students) nSheet.getRange(i + 1,  9).setValue(+r.students);
      if (r.girls)    nSheet.getRange(i + 1, 10).setValue(+r.girls);
      if (r.teachers) nSheet.getRange(i + 1, 11).setValue(+r.teachers);
      if (r.status)   nSheet.getRange(i + 1, 12).setValue(+r.status);
      nSheet.getRange(i + 1, 13).setValue(r.month);
      if (r.kmi)      nSheet.getRange(i + 1, 14).setValue(r.kmi);
      break;
    }
  }

  return { success: true };
}

// ── UPLOAD PHOTO TO DRIVE ────────────────────────────────────
// Receives base64-encoded image, saves to Drive subfolder NGO_Month
function uploadPhoto(data) {
  const folder  = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const subName = (data.ngo + '_' + data.month).replace(/[^a-zA-Z0-9]/g, '_');

  let sub;
  const existing = folder.getFoldersByName(subName);
  sub = existing.hasNext() ? existing.next() : folder.createFolder(subName);

  const bytes = Utilities.base64Decode(data.base64);
  const blob  = Utilities.newBlob(bytes, data.mimeType, data.filename);
  const file  = sub.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return {
    success:  true,
    fileId:   file.getId(),
    url:      'https://drive.google.com/uc?id=' + file.getId(),
    folderId: sub.getId()
  };
}

// ── SAVE NEW NGO PROFILE (on first signup) ───────────────────
function saveProfile(data) {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // 1. Add to Users sheet (if not already there)
  const uSheet = ss.getSheetByName('Users');
  const uRows  = uSheet.getDataRange().getValues();
  let userExists = false;
  for (let i = 1; i < uRows.length; i++) {
    if (uRows[i][0] === data.email) { userExists = true; break; }
  }
  if (!userExists) {
    uSheet.appendRow([data.email, data.password || '', 'ngo', data.name, data.org]);
  }

  // 2. Add / update NGO in NGOs sheet
  const nSheet = ss.getSheetByName('NGOs');
  const nRows  = nSheet.getDataRange().getValues();
  for (let i = 1; i < nRows.length; i++) {
    if (nRows[i][1] === data.org) {
      nSheet.getRange(i + 1, 3).setValue(data.theme  || '');
      nSheet.getRange(i + 1, 4).setValue(data.person || data.name);
      nSheet.getRange(i + 1, 5).setValue(data.dist   || '');
      return { success: true, action: 'updated' };
    }
  }

  // New NGO row — x/y defaults to centre of map (admin can update later in Sheet)
  const newId = nRows.length;
  nSheet.appendRow([
    newId, data.org, data.theme || '', data.person || data.name,
    data.dist || '', 300, 300, 0, 0, 0, 0, 0, '', '',
    data.phone || '', data.desig || '', data.org_type || '',
    data.prog || '', data.desc || '', data.budget_target || 0,
    data.start_date || '', new Date().toLocaleDateString('en-IN')
  ]);
  return { success: true, action: 'created' };
}
