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
const VERSION         = 'v9-month-text-2026-05-30'; // bump on each deploy to verify live code

// Cached spreadsheet — avoids repeated openById() calls within one request
function getSS() { return SpreadsheetApp.openById(SHEET_ID); }

// ── ROUTER ──────────────────────────────────────────────────
// GET handles everything except photo upload (too large for URL)
function doGet(e) {
  try {
    const p      = e.parameter;
    const action = p.action;
    let result;
    if (action === 'getNGOs')         result = getNGOs();
    else if (action === 'getReports') result = getReports();
    else if (action === 'getNGOList') result = getNGOList();
    else if (action === 'sendOTP')    result = sendOTP(p);
    else if (action === 'verifyOTP')  result = verifyOTP(p);
    else if (action === 'saveProfile')   result = saveProfile(p);
    else if (action === 'saveProject')          result = saveProject(p);
    else if (action === 'getProjects')          result = getProjects(p);
    else if (action === 'deleteUnlockedProjects') result = deleteUnlockedProjects(p);
    else if (action === 'deleteProject')          result = deleteProject(p);
    else if (action === 'lockProject')          result = lockProject(p);
    else if (action === 'unlockProject')        result = unlockProject(p);
    else if (action === 'unlockProjectsByComponent') result = unlockProjectsByComponent(p);
    else if (action === 'lockReport')           result = lockReport(p);
    else if (action === 'submitReport')  result = submitReport({ report: JSON.parse(p.report), lock: !!p.lock });
    else if (action === 'getAdminPartners')     result = getAdminPartners();
    else if (action === 'setNGOStatus')         result = setNGOStatus(p);
    else if (action === 'debugReports')         result = debugReportsInfo();
    else if (action === 'version')              result = { version: VERSION };
    else if (action === 'cleanupDuplicates')    result = { message: cleanupDuplicateReports() };
    else if (action === 'repairHeader')         result = { message: repairReportsHeader() };
    // legacy — kept for backward compat
    else if (action === 'login')          result = login(p);
    else if (action === 'changePassword') result = changePassword(p);
    else result = { error: 'Unknown action' };
    return respond(result, p.callback);
  } catch (err) {
    return respond({ error: err.message }, e.parameter.callback);
  }
}

// POST used for photo upload and saveProfile (large school list exceeds GET URL limit)
function doPost(e) {
  try {
    const data   = JSON.parse(e.postData.contents);
    const action = data.action;
    if (action === 'getNGOs')      return respond(getNGOs());
    if (action === 'getReports')   return respond(getReports());
    if (action === 'getProjects')  return respond(getProjects(data));
    if (action === 'getNGOList')   return respond(getNGOList());
    if (action === 'sendOTP')      return respond(sendOTP(data));
    if (action === 'verifyOTP')    return respond(verifyOTP(data));
    if (action === 'login')        return respond(login(data));
    if (action === 'changePassword') return respond(changePassword(data));
    if (action === 'uploadPhoto')  return respond(uploadPhoto(data));
    if (action === 'saveProfile')  return respond(saveProfile(data));
    if (action === 'saveProject')  return respond(saveProject(data));
    if (action === 'lockProject')   return respond(lockProject(data));
    if (action === 'unlockProject') return respond(unlockProject(data));
    if (action === 'unlockProjectsByComponent') return respond(unlockProjectsByComponent(data));
    if (action === 'deleteUnlockedProjects') return respond(deleteUnlockedProjects(data));
    if (action === 'deleteProject')          return respond(deleteProject(data));
    if (action === 'lockReport')        return respond(lockReport(data));
    if (action === 'submitReport')      return respond(submitReport({ report: JSON.parse(data.report), lock: !!data.lock }));
    if (action === 'getAdminPartners')  return respond(getAdminPartners());
    if (action === 'setNGOStatus')      return respond(setNGOStatus(data));
    return respond({ error: 'Unknown action' });
  } catch (err) {
    return respond({ error: err.message });
  }
}

// Supports both plain JSON and JSONP (callback param)
function respond(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ── OTP LOGIN ────────────────────────────────────────────────
// Users sheet columns: email | password(unused) | role | name | org | pwd_changed | otp | otp_expiry
//
// Step 1 — sendOTP: generate 6-digit OTP, save to sheet, email to user
function sendOTP(data) {
  if (!data.email) return { success: false, error: 'Email required' };
  const sheet = getSS().getSheetByName('Users');
  const rows  = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    const [email, , role, name, org] = rows[i];
    if (String(email).trim().toLowerCase() !== data.email.trim().toLowerCase()) continue;

    // Admin uses password login — skip OTP
    if (role === 'admin') {
      return { success: false, isAdmin: true, error: 'admin' };
    }

    // Ensure OTP columns exist (col 7 = otp, col 8 = otp_expiry, col 9 = otp_sent_at)
    const hRow = sheet.getRange(1, 1, 1, 9).getValues()[0];
    if (!hRow[6]) sheet.getRange(1, 7).setValue('otp');
    if (!hRow[7]) sheet.getRange(1, 8).setValue('otp_expiry');
    if (!hRow[8]) sheet.getRange(1, 9).setValue('otp_sent_at');

    // Rate limiting — allow only 1 OTP per 60 seconds
    const sentAt = rows[i][8] ? new Date(rows[i][8]) : null;
    if (sentAt && (Date.now() - sentAt.getTime()) < 60 * 1000) {
      const secsLeft = Math.ceil((60 * 1000 - (Date.now() - sentAt.getTime())) / 1000);
      return { success: false, error: `Please wait ${secsLeft} seconds before requesting a new OTP.` };
    }

    // Generate 6-digit OTP
    const otp    = String(Math.floor(100000 + Math.random() * 900000));
    const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    sheet.getRange(i + 1, 7).setValue(otp);
    sheet.getRange(i + 1, 8).setValue(expiry);
    sheet.getRange(i + 1, 9).setValue(new Date().toISOString()); // rate limit timestamp

    // Send email
    try {
      MailApp.sendEmail({
        to: email,
        subject: 'Your OTP — Samagra UP NGO Portal',
        body:
          'Dear ' + (name || 'Partner') + ',\n\n' +
          'Your One-Time Password (OTP) for login is:\n\n' +
          '  ' + otp + '\n\n' +
          'This OTP is valid for 10 minutes.\n' +
          'Do not share this OTP with anyone.\n\n' +
          'Login at: ' + PORTAL_URL + '\n\n' +
          '— PMU Team, Samagra UP Secondary Education Programme'
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: 'Could not send email: ' + e.message };
    }
  }
  return { success: false, error: 'Email not registered. Please contact PMU Admin.' };
}

// Step 2 — verifyOTP: check OTP, return user object on success
function verifyOTP(data) {
  if (!data.email || !data.otp) return { success: false, error: 'Email and OTP required' };
  const sheet = getSS().getSheetByName('Users');
  const rows  = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    const [email, , role, name, org, , storedOtp, otpExpiry] = rows[i];
    if (String(email).trim().toLowerCase() !== data.email.trim().toLowerCase()) continue;

    if (!storedOtp) return { success: false, error: 'No OTP found. Please request a new one.' };
    if (String(storedOtp).trim() !== String(data.otp).trim()) {
      return { success: false, error: 'Incorrect OTP. Please try again.' };
    }
    if (otpExpiry && new Date() > new Date(otpExpiry)) {
      return { success: false, error: 'OTP has expired. Please request a new one.' };
    }

    // Clear OTP after successful use (one-time use)
    sheet.getRange(i + 1, 7).setValue('');
    sheet.getRange(i + 1, 8).setValue('');

    const profileDone = role !== 'admin' ? isNGOProfileDone(org) : true;
    return { success: true, user: { email, role, name, org, profileDone } };
  }
  return { success: false, error: 'Email not found.' };
}

// Check if NGO has completed their profile
// Criteria: person name filled in NGOs sheet + at least one active task saved in Projects
function isNGOProfileDone(orgName) {
  const ss = getSS();

  // Check NGOs sheet — must have person name filled
  const ngoSheet = ss.getSheetByName('NGOs');
  if (!ngoSheet) return false;
  const ngoRows = ngoSheet.getDataRange().getValues();
  const h = ngoRows[0];
  const nameIdx   = h.indexOf('name');
  const personIdx = h.indexOf('person');

  let hasPerson = false;
  for (let i = 1; i < ngoRows.length; i++) {
    const rowName = nameIdx >= 0 ? String(ngoRows[i][nameIdx]||'') : String(ngoRows[i][1]||'');
    if (rowName.trim().toLowerCase() !== orgName.trim().toLowerCase()) continue;
    const person = personIdx >= 0 ? String(ngoRows[i][personIdx]||'') : String(ngoRows[i][14]||'');
    hasPerson = person.trim() !== '';
    break;
  }
  if (!hasPerson) return false;

  // Check Projects sheet — must have at least one active (non-deleted) task saved
  const projSheet = ss.getSheetByName('Projects');
  if (!projSheet) return false;
  const projRows = projSheet.getDataRange().getValues();
  const ph = projRows[0];
  const pNgoIdx    = ph.indexOf('ngo');
  const pStatusIdx = ph.indexOf('status');
  for (let i = 1; i < projRows.length; i++) {
    const pNgo    = pNgoIdx    >= 0 ? String(projRows[i][pNgoIdx]   ||'') : '';
    const pStatus = pStatusIdx >= 0 ? String(projRows[i][pStatusIdx]||'') : '';
    if (pNgo.trim().toLowerCase() !== orgName.trim().toLowerCase()) continue;
    if (pStatus !== 'deleted') return true;
  }
  return false;
}

// ── LEGACY (kept for backward compat) ───────────────────────
function login(data) {
  const sheet = getSS().getSheetByName('Users');
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const [email, password, role, name, org] = rows[i];
    if (email === data.email && String(password) === String(data.password)) {
      if (role !== 'admin' && !isNGOActive(org)) {
        return { success: false, error: 'Your organisation is currently inactive.' };
      }
      const profileDone = role !== 'admin' ? isNGOProfileDone(org) : true;
      return { success: true, user: { email, role, name, org, profileDone } };
    }
  }
  return { success: false, error: 'Invalid email or password' };
}
function changePassword(data) {
  const sheet = getSS().getSheetByName('Users');
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === data.email) {
      sheet.getRange(i + 1, 2).setValue(data.newPassword);
      return { success: true };
    }
  }
  return { success: false, error: 'User not found' };
}

// ── GET NGO MASTER LIST (for signup dropdown) ────────────────
// NGO_List sheet columns: sr_no | name | status (active/inactive)
function getNGOList() {
  const sheet = getSS().getSheetByName('NGO_List');
  if (!sheet) return { success: true, data: [] };
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return { success: true, data: [] };
  const data = rows.slice(1)
    .filter(r => r[1] && String(r[2]).toLowerCase().trim() === 'active')  // only active NGOs
    .map(r => ({ sr: r[0], name: String(r[1]).trim() }));
  return { success: true, data };
}

// ── One-time: set ALL NGOs in NGO_List to active ──
// Run once from Apps Script editor to re-enable all NGOs
function activateAllNGOs() {
  const ss        = getSS();
  const listSheet = ss.getSheetByName('NGO_List');
  if (!listSheet) { Logger.log('NGO_List not found'); return; }

  const rows = listSheet.getDataRange().getValues();
  const h    = rows[0];
  let sIdx   = h.indexOf('status');
  if (sIdx < 0) { sIdx = h.length; listSheet.getRange(1, sIdx+1).setValue('status'); }

  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    if (!String(rows[i][1]||'').trim()) continue;
    listSheet.getRange(i+1, sIdx+1).setValue('active');
    count++;
  }

  // Also clear any 'inactive' status in Users sheet
  const usersSheet = ss.getSheetByName('Users');
  if (usersSheet) {
    const uRows = usersSheet.getDataRange().getValues();
    const uH    = uRows[0];
    const usIdx = uH.indexOf('status');
    if (usIdx >= 0) {
      for (let i = 1; i < uRows.length; i++) {
        if (String(uRows[i][usIdx]||'').toLowerCase() === 'inactive') {
          usersSheet.getRange(i+1, usIdx+1).setValue('active');
        }
      }
    }
  }

  Logger.log('activateAllNGOs: ' + count + ' NGOs set to active.');
}

// Check if NGO is active in NGO_List
function isNGOActive(orgName) {
  const sheet = getSS().getSheetByName('NGO_List');
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
// Returns all NGOs with a 'ngo_status' field (active/inactive) from NGO_List
// Frontend filters inactive ones for non-admin; admin sees all with toggle
function getNGOs() {
  const sheet = getSS().getSheetByName('NGOs');
  const rows  = sheet.getDataRange().getValues();
  if (rows.length < 2) return { success: true, data: [] };
  const headers = rows[0];
  // Build status map from NGO_List: name → 'active'/'inactive'
  const statusMap = {};
  const listSheet = getSS().getSheetByName('NGO_List');
  if (listSheet) {
    const lRows = listSheet.getDataRange().getValues();
    for (let i = 1; i < lRows.length; i++) {
      const name   = String(lRows[i][1]||'').trim().toLowerCase();
      const status = String(lRows[i][2]||'active').toLowerCase().trim();
      if (name) statusMap[name] = status;
    }
  }
  const data = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    const key = String(obj.name||'').trim().toLowerCase();
    obj.ngo_status = statusMap[key] || 'active'; // default active if not in list
    return obj;
  });
  return { success: true, data };
}

// ── GET REPORTS ──────────────────────────────────────────────
// Reports sheet columns: id|ngo|month|schools|students|girls|teachers|meetings|events|
//   scst|divyang|budget|dropout|tasks_readable|tasks_json|status|kmi|achieve|challenges|
//   support|plans|photos_count|photos_folder|submitted|equipment|training|machine|donation|other_support
function getReports() {
  const sheet = getSS().getSheetByName('Reports');
  const rows  = sheet.getDataRange().getValues();
  if (rows.length < 2) return { success: true, data: [] };
  // Normalize header names (trim + lowercase) so keys are predictable for the
  // frontend regardless of trailing spaces / capitals in the sheet header.
  const headers = rows[0].map(h => String(h == null ? '' : h).trim().toLowerCase());
  const raw = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = row[i]; });
    if (obj['tasks_json'] && typeof obj['tasks_json'] !== 'string') obj['tasks_json'] = JSON.stringify(obj['tasks_json']);
    obj['tasks'] = obj['tasks_json'] || obj['tasks'] || '[]';
    // Normalize report_locked to string 'true'/'false' for the frontend
    obj['report_locked'] = (String(obj['report_locked']).toLowerCase() === 'true') ? 'true' : 'false';
    // Month may be stored as a Date (Sheets auto-conversion) — return clean
    // "May 2026" text so the frontend's month matching works after reload.
    obj['month'] = _monthDisplay(obj['month']);
    if (obj['ngo'] != null) obj['ngo'] = String(obj['ngo']).trim();
    return obj;
  });
  // Deduplicate: one row per ngo+month, prefer locked over draft
  const best = {};
  raw.forEach(r => {
    const key = String(r.ngo).trim().toLowerCase() + '|' + String(r.month).trim().toLowerCase();
    if (!best[key] || r.report_locked === 'true') best[key] = r;
  });
  const data = Object.values(best);
  return { success: true, data };
}

// Convert tasks JSON array → human-readable multiline text for Google Sheet
function tasksToReadable(tasksJson) {
  try {
    const tasks = JSON.parse(tasksJson || '[]');
    if (!tasks.length) return '';
    return tasks.map((t, i) => {
      const lines = [
        `[Task ${i+1}] ${t.task_name} (${t.component||'—'})`,
        `  Status   : ${t.status||'Not started'}`,
        `  Activity : ${t.activity||'—'}`
      ];
      if (t.done_date) lines.push(`  Completed: ${t.done_date}`);
      return lines.join('\n');
    }).join('\n\n');
  } catch(e) { return tasksJson || ''; }
}

// ── MONTH NORMALIZERS ────────────────────────────────────────
// Google Sheets auto-converts the text "May 2026" into a DATE value when
// written to a cell. That broke all matching (resubmit made duplicates,
// reload showed Submit again). These helpers convert ANY stored month value
// (Date object, ISO string, or "May 2026" text) into a single comparable form.
function _monthDisplay(v) {
  try {
    if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
      return Utilities.formatDate(v, 'Asia/Kolkata', 'MMMM yyyy');
    }
  } catch (e) {}
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d)) return Utilities.formatDate(d, 'Asia/Kolkata', 'MMMM yyyy');
  }
  return s;
}
function _monthKey(v) { return _monthDisplay(v).trim().toLowerCase(); }

// ── SUBMIT REPORT ────────────────────────────────────────────
// Fully HEADER-DRIVEN: every field is written by column NAME, never by
// position. This guarantees ngo/month/tasks_json land in the right columns
// regardless of the sheet's actual column order — which was the root cause
// of duplicate rows and tasks disappearing on refresh.
function submitReport(data) {
  const ss     = getSS();
  const rSheet = ss.getSheetByName('Reports');
  const r      = data.report;

  const rNgo   = String(r.ngo   || '').trim().toLowerCase();
  const rMonth = _monthKey(r.month);

  // Normalize header names so trailing spaces / capitals never break matching
  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

  // ── Ensure all required columns exist (append missing at end) ──
  const REQUIRED = ['id','ngo','month','schools','students','girls','teachers',
    'meetings','events','scst','divyang','budget','dropout',
    'tasks_readable','tasks_json','status','kmi','achieve','challenges',
    'support','plans','photos_count','photos_folder','submitted',
    'equipment','training','machine','donation','other_support',
    'report_from','report_to','report_locked','drive_doc_url'];
  {
    let h = rSheet.getRange(1, 1, 1, rSheet.getLastColumn()).getValues()[0];
    // Migrate legacy 'tasks' header → 'tasks_readable'
    const legacyTasks = h.findIndex(c => norm(c) === 'tasks');
    if (legacyTasks >= 0 && h.findIndex(c => norm(c) === 'tasks_readable') < 0) {
      rSheet.getRange(1, legacyTasks + 1).setValue('tasks_readable');
      h = rSheet.getRange(1, 1, 1, rSheet.getLastColumn()).getValues()[0];
    }
    REQUIRED.forEach(name => {
      if (h.findIndex(c => norm(c) === name) < 0) {
        rSheet.getRange(1, h.length + 1).setValue(name);
        h.push(name);
      }
    });
  }

  const readableText = tasksToReadable(r.tasks);

  // ── Values keyed by COLUMN NAME ──────────────────────────
  const vals = {
    ngo:            r.ngo,
    month:          r.month,
    schools:        r.schools  || 0,
    students:       r.students || 0,
    girls:          r.girls    || 0,
    teachers:       r.teachers || 0,
    meetings:       r.meetings || 0,
    events:         r.events   || 0,
    scst:           r.scst     || 0,
    divyang:        r.divyang  || 0,
    budget:         0,
    dropout:        r.dropout  || 0,
    tasks_readable: readableText,
    tasks_json:     r.tasks    || '',
    status:         r.status   || '',
    kmi:            r.kmi      || '',
    achieve:        r.achieve  || '',
    challenges:     r.challenges || '',
    support:        r.support  || '',
    plans:          r.plans    || '',
    photos_count:   r.photos_count  || 0,
    photos_folder:  r.photos_folder || '',
    submitted:      new Date().toLocaleDateString('en-IN'),
    equipment:      r.equipment || '',
    training:       r.training  || '',
    machine:        r.machine   || '',
    donation:       r.donation  || '',
    other_support:  r.other_support || '',
    report_from:    r.report_from || '',
    report_to:      r.report_to   || ''
  };

  // ── Script lock — serialize concurrent writes ────────────
  const scriptLock = LockService.getScriptLock();
  scriptLock.waitLock(20000);

  let savedRow = -1;

  try {
    const allRows = rSheet.getDataRange().getValues();
    const hdr     = allRows[0];
    // Normalized lookup — tolerant of trailing spaces / capital letters in header
    const colOf   = (name) => hdr.findIndex(c => norm(c) === norm(name)); // 0-based, -1 if missing
    const ngoIdx  = colOf('ngo');
    const monIdx  = colOf('month');
    const lockIdx = colOf('report_locked');
    const idIdx   = colOf('id');

    // Find ALL matching rows for this ngo+month
    const matches = [];
    for (let i = 1; i < allRows.length; i++) {
      const sNgo = String(allRows[i][ngoIdx] || '').trim().toLowerCase();
      const sMon = _monthKey(allRows[i][monIdx]);
      if (sNgo === rNgo && sMon === rMonth) matches.push(i + 1); // 1-based
    }

    // ── SELF-HEAL: if duplicates exist, delete extras (keep first) ──
    if (matches.length > 1) {
      // delete from bottom up so row numbers stay valid
      for (let k = matches.length - 1; k >= 1; k--) {
        rSheet.deleteRow(matches[k]);
      }
    }
    const targetRow = matches.length ? matches[0] : -1;

    // Preserve existing id + locked state if updating
    let keepId     = new Date().getTime();
    let keepLocked = 'false';
    if (targetRow > 0) {
      if (idIdx   >= 0) keepId     = allRows[targetRow - 1][idIdx] || keepId;
      if (lockIdx >= 0) keepLocked = String(allRows[targetRow - 1][lockIdx]) === 'true' ? 'true' : 'false';
    }
    vals.id            = keepId;
    vals.report_locked = keepLocked;

    // Build row array in EXACT header order (normalized name → value)
    const rowArr = hdr.map((colName, ci) => {
      const key = norm(colName);
      if (vals.hasOwnProperty(key)) return vals[key];
      // keep existing value (e.g. drive_doc_url) when updating, else blank
      if (targetRow > 0) return allRows[targetRow - 1][ci];
      return '';
    });

    if (targetRow > 0) {
      rSheet.getRange(targetRow, 1, 1, rowArr.length).setValues([rowArr]);
      savedRow = targetRow;
    } else {
      rSheet.appendRow(rowArr);
      savedRow = rSheet.getLastRow();
    }

    // Force the month cell to PLAIN TEXT so Sheets never re-converts "May 2026"
    // into a date. This is the root-cause fix for duplicate rows / reload showing
    // Submit again. We re-write the month as text in the correct display form.
    if (monIdx >= 0 && savedRow > 0) {
      rSheet.getRange(savedRow, monIdx + 1).setNumberFormat('@').setValue(_monthDisplay(r.month));
    }

    SpreadsheetApp.flush();

    // ── FINAL GUARANTEE: exactly ONE row for this ngo+month ──
    // Re-read and delete any stray duplicates, keeping the row we just wrote
    // (identified by its id). This makes duplicate rows structurally impossible
    // even if a prior match somehow failed.
    {
      const fresh = rSheet.getDataRange().getValues();
      const fHdr  = fresh[0];
      const fNgo  = fHdr.findIndex(c => norm(c) === 'ngo');
      const fMon  = fHdr.findIndex(c => norm(c) === 'month');
      const fId   = fHdr.findIndex(c => norm(c) === 'id');
      const dupRows = [];
      let keepRow = -1;
      for (let i = 1; i < fresh.length; i++) {
        const sN = String(fresh[i][fNgo] || '').trim().toLowerCase();
        const sM = _monthKey(fresh[i][fMon]);
        if (sN === rNgo && sM === rMonth) {
          if (fId >= 0 && String(fresh[i][fId]) === String(vals.id)) keepRow = i + 1;
          else dupRows.push(i + 1);
        }
      }
      // If our id wasn't found (edge case), keep the first match instead
      if (keepRow < 0 && dupRows.length) { keepRow = dupRows.shift(); }
      // Deleting rows above keepRow shifts it up — account for that
      const above = dupRows.filter(rn => rn < keepRow).length;
      dupRows.sort((a, b) => b - a).forEach(rn => rSheet.deleteRow(rn));
      if (keepRow > 0) savedRow = keepRow - above;
      SpreadsheetApp.flush();
    }
  } finally {
    scriptLock.releaseLock();
  }

  // ── Update latest values in NGOs sheet ───────────────────
  try {
    const nSheet = ss.getSheetByName('NGOs');
    const nRows  = nSheet.getDataRange().getValues();
    for (let i = 1; i < nRows.length; i++) {
      if (String(nRows[i][1] || '').trim().toLowerCase() === rNgo) {
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
  } catch (ngoErr) {
    Logger.log('NGO sheet update error: ' + ngoErr.message);
  }

  // ── Drive Google Doc generation DISABLED ─────────────────
  // Previously each final submit created a new Google Doc (Report_<month>_<timestamp>)
  // in the NGO's Drive folder, producing a duplicate doc on every (re)submit.
  // The app already provides an in-app official report + PDF download, so the
  // Drive doc was redundant and is no longer generated.
  const docUrl = '';

  // ── If lock:true — mark report_locked = 'true' ───────────
  if (data.lock && savedRow > 0) {
    try {
      const lHdr      = rSheet.getRange(1, 1, 1, rSheet.getLastColumn()).getValues()[0];
      let   lLockedIdx = lHdr.indexOf('report_locked');
      if (lLockedIdx < 0) {
        lLockedIdx = lHdr.length;
        rSheet.getRange(1, lLockedIdx + 1).setValue('report_locked');
      }
      rSheet.getRange(savedRow, lLockedIdx + 1).setValue('true');
      SpreadsheetApp.flush();
    } catch (lockErr) {
      Logger.log('Lock write error: ' + lockErr.message);
    }
  }

  return { success: true, docUrl: docUrl };
}

// ── DEBUG ────────────────────────────────────────────────────
// Run from editor (select debugReportsInfo → Run, then View → Logs)
// OR call via URL: ...exec?action=debugReports
function debugReportsInfo() {
  const sheet = getSS().getSheetByName('Reports');
  const rows  = sheet.getDataRange().getValues();
  const hdr   = rows[0];
  const norm  = (s) => String(s == null ? '' : s).trim().toLowerCase();
  const info  = {
    version:    VERSION,
    columnCount: hdr.length,
    rowCount:   rows.length - 1,
    header:     hdr.map((h, i) => i + ':"' + h + '"'),
    ngoIdx:     hdr.findIndex(c => norm(c) === 'ngo'),
    monthIdx:   hdr.findIndex(c => norm(c) === 'month'),
    lockedIdx:  hdr.findIndex(c => norm(c) === 'report_locked'),
    tasksJsonIdx: hdr.findIndex(c => norm(c) === 'tasks_json')
  };
  Logger.log(JSON.stringify(info, null, 2));
  return info;
}

// ── ONE-TIME CLEANUP ─────────────────────────────────────────
// Run this manually from the Apps Script editor (select cleanupDuplicateReports
// in the function dropdown → Run) to remove all duplicate rows from the Reports
// sheet. Keeps one row per ngo+month, preferring a locked row if any exists.
function cleanupDuplicateReports() {
  const sheet = getSS().getSheetByName('Reports');
  const rows  = sheet.getDataRange().getValues();
  if (rows.length < 2) { Logger.log('Nothing to clean.'); return 'Nothing to clean.'; }
  const hdr      = rows[0];
  const nrm      = (s) => String(s == null ? '' : s).trim().toLowerCase();
  const ngoIdx   = hdr.findIndex(c => nrm(c) === 'ngo');
  const monIdx   = hdr.findIndex(c => nrm(c) === 'month');
  const lockIdx  = hdr.findIndex(c => nrm(c) === 'report_locked');

  // Group row numbers (1-based) by ngo+month key
  const groups = {};
  for (let i = 1; i < rows.length; i++) {
    const key = String(rows[i][ngoIdx] || '').trim().toLowerCase()
              + '|' + _monthKey(rows[i][monIdx]);
    if (key === '|') continue; // skip fully-empty rows
    (groups[key] = groups[key] || []).push(i + 1);
  }

  // For each group with duplicates, pick the keeper and delete the rest
  const toDelete = [];
  Object.values(groups).forEach(rowNums => {
    if (rowNums.length < 2) return;
    // prefer a locked row as the keeper
    let keeper = rowNums[0];
    for (const rn of rowNums) {
      if (lockIdx >= 0 && String(rows[rn - 1][lockIdx]) === 'true') { keeper = rn; break; }
    }
    rowNums.forEach(rn => { if (rn !== keeper) toDelete.push(rn); });
  });

  // Delete from bottom up so row numbers remain valid
  toDelete.sort((a, b) => b - a).forEach(rn => sheet.deleteRow(rn));
  SpreadsheetApp.flush();
  const msg = 'Removed ' + toDelete.length + ' duplicate row(s).';
  Logger.log(msg);
  return msg;
}

// ── ONE-TIME HEADER REPAIR ───────────────────────────────────
// Removes blank/empty header columns (e.g. the corrupted empty columns 26-30)
// left behind by repeated column auto-appends across deployments.
// Call via URL: ...exec?action=repairHeader
function repairReportsHeader() {
  const sheet = getSS().getSheetByName('Reports');
  const data  = sheet.getDataRange().getValues();
  if (!data.length) return 'Empty sheet.';
  const hdr = data[0];
  // Indices (0-based) of columns whose header is blank
  const blankCols = [];
  hdr.forEach((h, i) => { if (String(h == null ? '' : h).trim() === '') blankCols.push(i); });
  if (!blankCols.length) return 'No blank columns to remove.';
  // Delete from rightmost to leftmost so indices stay valid (1-based for API)
  blankCols.sort((a, b) => b - a).forEach(ci => sheet.deleteColumn(ci + 1));
  SpreadsheetApp.flush();
  return 'Removed ' + blankCols.length + ' blank column(s): indices ' + blankCols.join(', ');
}

function lockReport(data) {
  const sheet = getSS().getSheetByName('Reports');
  if (!sheet) return { success: false };
  const rows = sheet.getDataRange().getValues();
  const h = rows[0];
  const ngoIdx    = h.indexOf('ngo');
  const monthIdx  = h.indexOf('month');
  let lockedIdx   = h.indexOf('report_locked');
  if (lockedIdx < 0) {
    lockedIdx = h.length;
    sheet.getRange(1, lockedIdx + 1).setValue('report_locked');
  }
  const dNgo   = String(data.ngo   || '').trim().toLowerCase();
  const dMonth = String(data.month || '').trim().toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    const sNgo   = String(rows[i][ngoIdx]   || '').trim().toLowerCase();
    const sMonth = String(rows[i][monthIdx] || '').trim().toLowerCase();
    if (sNgo === dNgo && sMonth === dMonth) {
      sheet.getRange(i + 1, lockedIdx + 1).setValue('true');
      return { success: true };
    }
  }
  return { success: false, error: 'Report not found' };
}


// ── DRIVE FOLDER HELPERS ─────────────────────────────────────

// Returns (or creates) the NGO's subfolder inside the parent Drive folder
function getOrCreateNGOFolder(ngoName) {
  const parent  = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const safeName = ngoName.trim();
  const iter    = parent.getFoldersByName(safeName);
  if (iter.hasNext()) return iter.next();
  const f = parent.createFolder(safeName);
  f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return f;
}

// Saves a formatted report as a Google Doc inside the NGO folder
function saveReportDoc(r, ngoFolder) {
  const title = 'Report_' + (r.month || '').replace(/[^a-zA-Z0-9]/g, '_')
              + '_' + new Date().getTime();
  const doc  = DocumentApp.create(title);
  const body = doc.getBody();

  // Header
  body.appendParagraph('Monthly KPI Progress Report')
      .setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph('Samagra Shiksha, Secondary, Uttar Pradesh, PMU')
      .setHeading(DocumentApp.ParagraphHeading.HEADING3);

  body.appendParagraph('');

  // Basic info table
  const infoTable = body.appendTable([
    ['Organisation', r.ngo || '—'],
    ['Month',        r.month || '—'],
    ['Submitted',    new Date().toLocaleDateString('en-IN')],
    ['Progress',     (r.status || '0') + '%']
  ]);
  infoTable.setBorderColor('#cccccc');

  body.appendParagraph('');

  // KPI Numbers
  body.appendParagraph('Key Performance Indicators')
      .setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendTable([
    ['Schools Covered',    String(r.schools  || 0)],
    ['Students Reached',   String(r.students || 0)],
    ['Girls Reached',      String(r.girls    || 0)],
    ['Teachers Trained',   String(r.teachers || 0)],
    ['Community Meetings', String(r.meetings || 0)],
    ['Events Conducted',   String(r.events   || 0)],
    ['SC/ST Students',     String(r.scst     || 0)],
    ['Divyang Students',   String(r.divyang  || 0)],
    ['Dropout Cases',      String(r.dropout  || 0)]
  ]).setBorderColor('#cccccc');

  body.appendParagraph('');

  // Narrative sections
  const sections = [
    ['Key Monthly Indicator (KMI)', r.kmi],
    ['Achievements',                r.achieve],
    ['Challenges',                  r.challenges],
    ['Support Required',            r.support],
    ['Plans for Next Month',        r.plans]
  ];
  sections.forEach(([heading, content]) => {
    if (!content) return;
    body.appendParagraph(heading).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    body.appendParagraph(content || '—');
    body.appendParagraph('');
  });

  // Footer
  body.appendParagraph(
    'Generated by PMU Dashboard  |  ' + new Date().toLocaleString('en-IN') +
    '  |  For official use only'
  ).setItalic(true);

  doc.saveAndClose();

  // Move the doc into the NGO's Drive folder
  const file = DriveApp.getFileById(doc.getId());
  ngoFolder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);  // remove from root
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return {
    docId:  doc.getId(),
    docUrl: 'https://docs.google.com/document/d/' + doc.getId() + '/edit'
  };
}

// ── UPLOAD PHOTO TO DRIVE ────────────────────────────────────
// Saves photo inside NGO folder → Month subfolder
function uploadPhoto(data) {
  const ngoFolder = getOrCreateNGOFolder(data.ngo || 'Unknown_NGO');
  const monthName = (data.month || 'Photos').replace(/[^a-zA-Z0-9]/g, '_');

  let sub;
  const existing = ngoFolder.getFoldersByName(monthName);
  sub = existing.hasNext() ? existing.next() : ngoFolder.createFolder(monthName);
  sub.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

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

// ── PROJECTS ────────────────────────────────────────────────
// Projects sheet: project_id|ngo|component|task_name|description|target_schools|target_students|target_girls|target_teachers|target_meetings|target_events|start_date|end_date|status|created_on
function saveProject(data) {
  const ss = getSS();
  let sheet = ss.getSheetByName('Projects');
  if (!sheet) {
    sheet = ss.insertSheet('Projects');
    sheet.appendRow(['project_id','ngo','component','task_name','description',
      'target_schools','target_students','target_girls','target_teachers',
      'target_meetings','target_events','start_date','end_date','status','created_on',
      'sub_activities','task_dist','task_schools']);
  } else {
    const hRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    if (!hRow.includes('sub_activities')) sheet.getRange(1, hRow.length+1).setValue('sub_activities');
    if (!hRow.includes('task_dist'))    sheet.getRange(1, sheet.getLastColumn()+1).setValue('task_dist');
    if (!hRow.includes('task_schools')) sheet.getRange(1, sheet.getLastColumn()+1).setValue('task_schools');
  }

  // UPDATE existing row if project_id provided
  if (data.project_id) {
    const rows = sheet.getDataRange().getValues();
    const h = rows[0];
    const pidIdx    = h.indexOf('project_id');
    const lockedIdx = h.indexOf('locked');
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][pidIdx]) !== String(data.project_id)) continue;
      // Never update a locked task
      if (lockedIdx >= 0 && String(rows[i][lockedIdx]) === 'true') return { success: true, project_id: data.project_id, skipped: true };
      const set = (col, val) => { const ci = h.indexOf(col); if(ci>=0) sheet.getRange(i+1,ci+1).setValue(val); };
      set('component',     data.component   || '');
      set('task_name',     data.task_name   || '');
      set('description',   data.description || '');
      set('sub_activities',data.sub_activities || '[]');
      set('start_date',    data.start_date  || '');
      set('end_date',      data.end_date    || '');
      set('task_dist',     data.task_dist   || '');
      set('task_schools',  data.task_schools|| '');
      set('status',        'active');
      return { success: true, project_id: data.project_id };
    }
  }

  // INSERT new row
  const id = new Date().getTime();
  sheet.appendRow([
    id, data.ngo, data.component, data.task_name, data.description||'',
    +data.target_schools||0, +data.target_students||0, +data.target_girls||0,
    +data.target_teachers||0, +data.target_meetings||0, +data.target_events||0,
    data.start_date||'', data.end_date||'', 'active',
    new Date().toLocaleDateString('en-IN'),
    data.sub_activities || '[]',
    data.task_dist    || '',
    data.task_schools || ''
  ]);
  return { success: true, project_id: id };
}

function getProjects(data) {
  const ss = getSS();
  const sheet = ss.getSheetByName('Projects');
  if (!sheet) return { success: true, data: [] };
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return { success: true, data: [] };
  const headers = rows[0];
  let projects = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
  // Filter by NGO if requested (non-admin); 'all' means return everything
  if (data.ngo && data.ngo !== 'all') projects = projects.filter(p => p.ngo === data.ngo);
  return { success: true, data: projects };
}

// Mark all UNLOCKED projects for an NGO as deleted (called before re-saving tasks)
function deleteUnlockedProjects(data) {
  const sheet = getSS().getSheetByName('Projects');
  if (!sheet) return { success: true };
  const rows = sheet.getDataRange().getValues();
  const h = rows[0];
  const ngoIdx    = h.indexOf('ngo');
  const statusIdx = h.indexOf('status');
  const lockedIdx = h.indexOf('locked');
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][ngoIdx] !== data.ngo) continue;
    if (rows[i][statusIdx] === 'deleted') continue;
    const isLocked = lockedIdx >= 0 && String(rows[i][lockedIdx]) === 'true';
    if (!isLocked) sheet.getRange(i + 1, statusIdx + 1).setValue('deleted');
  }
  return { success: true };
}

// Mark a single unlocked project as deleted by project_id
function deleteProject(data) {
  if (!data.project_id) return { success: false, error: 'project_id required' };
  const sheet = getSS().getSheetByName('Projects');
  if (!sheet) return { success: false, error: 'No Projects sheet' };
  const rows = sheet.getDataRange().getValues();
  const h = rows[0];
  const pidIdx    = h.indexOf('project_id');
  const statusIdx = h.indexOf('status');
  const lockedIdx = h.indexOf('locked');
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][pidIdx]) !== String(data.project_id)) continue;
    if (lockedIdx >= 0 && String(rows[i][lockedIdx]) === 'true')
      return { success: false, error: 'Cannot delete a locked activity.' };
    sheet.getRange(i + 1, statusIdx + 1).setValue('deleted');
    return { success: true };
  }
  return { success: false, error: 'Project not found' };
}

// Lock a project so it can never be edited or deleted via the UI
function lockProject(data) {
  const sheet = getSS().getSheetByName('Projects');
  if (!sheet) return { success: false, error: 'No Projects sheet' };
  const rows = sheet.getDataRange().getValues();
  const h = rows[0];
  const pidIdx = h.indexOf('project_id');
  // Ensure 'locked' column exists
  let lockedIdx = h.indexOf('locked');
  if (lockedIdx < 0) {
    lockedIdx = h.length;
    sheet.getRange(1, lockedIdx + 1).setValue('locked');
  }
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][pidIdx]) === String(data.project_id)) {
      sheet.getRange(i + 1, lockedIdx + 1).setValue('true');
      return { success: true };
    }
  }
  return { success: false, error: 'Project not found' };
}

// Unlock ALL tasks in a component for an NGO (admin only)
function unlockProjectsByComponent(data) {
  const sheet = getSS().getSheetByName('Projects');
  if (!sheet) return { success: false, error: 'No Projects sheet' };
  const rows = sheet.getDataRange().getValues();
  const h = rows[0];
  const ngoIdx    = h.indexOf('ngo');
  const compIdx   = h.indexOf('component');
  const statusIdx = h.indexOf('status');
  const lockedIdx = h.indexOf('locked');
  if (lockedIdx < 0) return { success: false, error: 'No locked column' };
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][ngoIdx] !== data.ngo) continue;
    if (rows[i][compIdx] !== data.component) continue;
    if (rows[i][statusIdx] === 'deleted') continue;
    sheet.getRange(i + 1, lockedIdx + 1).setValue('false');
    count++;
  }
  return { success: true, count };
}

// Unlock a project (admin only) so NGO can edit/delete it again
function unlockProject(data) {
  const sheet = getSS().getSheetByName('Projects');
  if (!sheet) return { success: false, error: 'No Projects sheet' };
  const rows = sheet.getDataRange().getValues();
  const h = rows[0];
  const pidIdx    = h.indexOf('project_id');
  const lockedIdx = h.indexOf('locked');
  if (lockedIdx < 0) return { success: false, error: 'No locked column' };
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][pidIdx]) === String(data.project_id)) {
      sheet.getRange(i + 1, lockedIdx + 1).setValue('false');
      return { success: true };
    }
  }
  return { success: false, error: 'Project not found' };
}

// ── SAVE NEW NGO PROFILE ─────────────────────────────────────
function saveProfile(data) {
  const ss = getSS();

  // 1. Add to Users sheet (if not already there), and update org name for all users sharing old org
  const uSheet = ss.getSheetByName('Users');
  const uRows  = uSheet.getDataRange().getValues();
  let userExists = false;
  let oldOrg = '';
  for (let i = 1; i < uRows.length; i++) {
    if (String(uRows[i][0]).trim().toLowerCase() === String(data.email).trim().toLowerCase()) {
      userExists = true;
      oldOrg = String(uRows[i][4] || '').trim();
      break;
    }
  }
  if (!userExists) {
    uSheet.appendRow([data.email, data.password || '', 'ngo', data.name, data.org]);
  } else if (data.org && oldOrg && oldOrg !== data.org) {
    // Org name changed — update ALL users who had the old org name
    for (let i = 1; i < uRows.length; i++) {
      if (String(uRows[i][4] || '').trim() === oldOrg) {
        uSheet.getRange(i + 1, 5).setValue(data.org);
      }
    }
  } else if (data.org && !oldOrg) {
    // Org was empty — just update this user's org
    for (let i = 1; i < uRows.length; i++) {
      if (String(uRows[i][0]).trim().toLowerCase() === String(data.email).trim().toLowerCase()) {
        uSheet.getRange(i + 1, 5).setValue(data.org);
        break;
      }
    }
  }

  // 2. Add / update NGO in NGOs sheet
  const nSheet = ss.getSheetByName('NGOs');
  // Ensure extended columns have headers (col 15–24)
  const hRow = nSheet.getRange(1, 1, 1, 24).getValues()[0];
  const extHeaders = ['phone','desig','org_type','prog','desc','budget_target','start_date','created_on','blocks','schools_list'];
  extHeaders.forEach((h, idx) => {
    if (!hRow[14 + idx]) nSheet.getRange(1, 15 + idx).setValue(h);
  });

  const nRows  = nSheet.getDataRange().getValues();
  for (let i = 1; i < nRows.length; i++) {
    if (nRows[i][1] === data.org) {
      nSheet.getRange(i + 1, 3).setValue(data.theme      || '');
      nSheet.getRange(i + 1, 4).setValue(data.person     || data.name);
      nSheet.getRange(i + 1, 5).setValue(data.dist       || '');
      nSheet.getRange(i + 1, 15).setValue(data.phone     || '');
      nSheet.getRange(i + 1, 16).setValue(data.desig     || '');
      nSheet.getRange(i + 1, 17).setValue(data.org_type  || '');
      nSheet.getRange(i + 1, 21).setValue(data.start_date|| '');
      nSheet.getRange(i + 1, 23).setValue(data.blocks    || '');
      nSheet.getRange(i + 1, 24).setValue(data.schools   || '');
      return { success: true, action: 'updated' };
    }
  }

  // New NGO row — x/y defaults to centre of map (admin can update later in Sheet)
  const newId = nRows.length;
  nSheet.appendRow([
    newId, data.org, data.theme || '', data.person || data.name,
    data.dist || '', 300, 300, 0, 0, 0, 0, 0, '', '',
    data.phone || '', data.desig || '', data.org_type || '',
    data.prog || '', data.desc || '', 0,
    data.start_date || '', new Date().toLocaleDateString('en-IN'),
    data.blocks || '', data.schools || ''
  ]);
  return { success: true, action: 'created' };
}

// ── FORGOT PASSWORD ──────────────────────────────────────────
// Generates a 6-char temp password, saves it, and emails the user
function forgotPassword(data) {
  if (!data.email) return { success: false, error: 'Email required' };
  const sheet = getSS().getSheetByName('Users');
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === data.email.trim().toLowerCase()) {
      // Generate temp password: NGO@ + 4 random digits
      const temp = 'NGO@' + Math.floor(1000 + Math.random() * 9000);
      sheet.getRange(i + 1, 2).setValue(temp);    // save new password
      sheet.getRange(i + 1, 6).setValue('');       // force password change on next login
      return { success: true, temp };
    }
  }
  return { success: false, error: 'Email not found in system' };
}

// ── ADMIN: Get all NGO partners ──
// org + email from Users sheet (positional), status from NGO_List (login source of truth)
function getAdminPartners() {
  const ss = getSS();

  // Build status map from NGO_List (same source isNGOActive() uses)
  const statusMap  = {};
  const listSheet  = ss.getSheetByName('NGO_List');
  if (listSheet) {
    const lRows = listSheet.getDataRange().getValues();
    for (let i = 1; i < lRows.length; i++) {
      const name   = String(lRows[i][1]||'').trim().toLowerCase();
      const status = String(lRows[i][2]||'active').trim().toLowerCase();
      if (name) statusMap[name] = status;
    }
  }

  const usersSheet = ss.getSheetByName('Users');
  if (!usersSheet) return { success: true, data: [] };

  const uRows    = usersSheet.getDataRange().getValues();
  const seen     = new Set();
  const partners = [];
  for (let i = 1; i < uRows.length; i++) {
    const email = String(uRows[i][0]||'').trim();
    const role  = String(uRows[i][2]||'').toLowerCase();
    const org   = String(uRows[i][4]||'').trim();
    if (role === 'admin') continue;
    if (!org || seen.has(org.toLowerCase())) continue;
    seen.add(org.toLowerCase());
    partners.push({
      org,
      email,
      status: statusMap[org.toLowerCase()] || 'active'
    });
  }
  return { success: true, data: partners };
}

// ── ADMIN: Set NGO active/inactive status ──
// Updates Users sheet (login access) + NGO_List status column
function setNGOStatus(data) {
  const ngo    = String(data.ngo||'').trim();
  const status = String(data.status||'').trim().toLowerCase();
  if (!ngo || !status) return { success: false, error: 'NGO name and status required' };

  const ss = getSS();

  // Update Users sheet — status column (auto-created if missing)
  const usersSheet = ss.getSheetByName('Users');
  if (usersSheet) {
    const uRows = usersSheet.getDataRange().getValues();
    const uH    = uRows[0];
    let sIdx = uH.indexOf('status');
    if (sIdx < 0) { sIdx = uH.length; usersSheet.getRange(1, sIdx+1).setValue('status'); }
    for (let i = 1; i < uRows.length; i++) {
      if (String(uRows[i][4]||'').trim().toLowerCase() === ngo.toLowerCase()) { // col 4 = org
        usersSheet.getRange(i+1, sIdx+1).setValue(status);
      }
    }
  }

  // Sync to NGO_List for isNGOActive() login check
  const listSheet = ss.getSheetByName('NGO_List');
  if (listSheet) {
    const lRows = listSheet.getDataRange().getValues();
    const lH    = lRows[0];
    let   lsIdx = lH.indexOf('status');
    if (lsIdx < 0) { lsIdx = lH.length; listSheet.getRange(1, lsIdx+1).setValue('status'); }
    for (let i = 1; i < lRows.length; i++) {
      if (String(lRows[i][1]||'').trim().toLowerCase() === ngo.toLowerCase()) {
        listSheet.getRange(i+1, lsIdx+1).setValue(status);
        break;
      }
    }
  }

  return { success: true };
}

// ── PERMISSION TEST — run this once manually to authorize MailApp ──
function authorizeMailPermission() {
  MailApp.sendEmail({
    to: Session.getActiveUser().getEmail(),
    subject: 'Samagra NGO Portal — Mail Permission Test',
    body: 'Mail permission authorized successfully. You can delete this email.'
  });
  Logger.log('Mail sent OK to: ' + Session.getActiveUser().getEmail());
}

// ══════════════════════════════════════════════════════════════
// AUTO MONTHLY EMAILS & TRIGGERS
// ══════════════════════════════════════════════════════════════

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const PORTAL_URL  = 'https://samsecup.dataimpact.in/';

// ── Helpers ──────────────────────────────────────────────────

// Normalize month value (handles ISO date strings or "April 2026" format)
function normalizeMonthLabel(val) {
  if (!val) return '';
  const s = String(val).trim();
  if (/^[A-Za-z]/.test(s)) return s; // already "April 2026"
  try {
    const d = new Date(s);
    if (!isNaN(d)) return MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear();
  } catch(e) {}
  return s;
}

// Get all active NGO users: [{email, name, org}]
// Reads by position: col 0=email, 2=role, 3=name, 4=org (same as login)
function getActiveNGOUsers() {
  const sheet = getSS().getSheetByName('Users');
  if (!sheet) return [];
  const rows  = sheet.getDataRange().getValues();
  const users = [];
  for (let i = 1; i < rows.length; i++) {
    const email = String(rows[i][0]||'').trim();
    const role  = String(rows[i][2]||'').toLowerCase();
    const name  = String(rows[i][3]||'').trim();
    const org   = String(rows[i][4]||'').trim();
    if (role === 'admin') continue;
    if (!email || !org) continue;
    if (!isNGOActive(org)) continue;
    users.push({ email, name: name || org, org });
  }
  return users;
}

// Check if a report is locked for NGO + monthLabel
function isReportLocked(repRows, repHeaders, org, monthLabel) {
  const ngoIdx    = repHeaders.indexOf('ngo');
  const monthIdx  = repHeaders.indexOf('month');
  const lockedIdx = repHeaders.indexOf('report_locked');
  for (let i = 1; i < repRows.length; i++) {
    if (String(repRows[i][ngoIdx]).trim() !== org) continue;
    if (normalizeMonthLabel(repRows[i][monthIdx]) !== monthLabel) continue;
    return String(repRows[i][lockedIdx]).toLowerCase() === 'true';
  }
  return false; // no report found = not locked
}

// ── 1. 30th of month: Remind NGOs that have NOT yet submitted their report ──
function sendMonthEndReminders() {
  const today      = new Date();
  const monthLabel = MONTH_NAMES[today.getMonth()] + ' ' + today.getFullYear();

  const ss         = getSS();
  const repSheet   = ss.getSheetByName('Reports');
  const repRows    = repSheet ? repSheet.getDataRange().getValues() : [[]];
  const repHeaders = repRows[0] || [];
  const ngoIdx     = repHeaders.indexOf('ngo');
  const monthIdx   = repHeaders.indexOf('month');
  const lockedIdx  = repHeaders.indexOf('report_locked');

  function isSubmitted(org) {
    for (let i = 1; i < repRows.length; i++) {
      if (String(repRows[i][ngoIdx]||'').trim() !== org) continue;
      if (normalizeMonthLabel(repRows[i][monthIdx]) !== monthLabel) continue;
      return String(repRows[i][lockedIdx]||'').toLowerCase() === 'true';
    }
    return false;
  }

  const users = getActiveNGOUsers();
  const done  = new Set();
  let sent = 0;
  const recipients = [];

  users.forEach(u => {
    if (done.has(u.org)) return;
    done.add(u.org);
    if (isSubmitted(u.org)) return;   // already submitted — skip

    try {
      MailApp.sendEmail({
        to: u.email,
        subject: `Action Required: Submit your ${monthLabel} Report — Samagra Shiksha`,
        htmlBody: `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #dde3ee;border-radius:10px;overflow:hidden">
  <div style="background:#1A3C6E;padding:18px 24px">
    <h2 style="color:#fff;margin:0;font-size:16px">Samagra Shiksha — NGO Partner Portal</h2>
    <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:12px">Madhyamik Shiksha Vibhag, Uttar Pradesh | PMU</p>
  </div>
  <div style="padding:24px">
    <p style="font-size:14px;color:#1a1a2e">Dear <strong>${u.name || u.org}</strong>,</p>
    <p style="font-size:14px;color:#444;line-height:1.6">
      This is a reminder that your <strong>${monthLabel}</strong> Monthly Report for
      <strong>${u.org}</strong> has not been submitted yet.
    </p>
    <div style="background:#fff3e0;border-left:4px solid #E24B4A;border-radius:6px;padding:14px 16px;margin:16px 0">
      <p style="margin:0;font-size:14px;color:#b71c1c;font-weight:700">
        ⚠️ Please submit your report today. It will not reach the PMU until submitted.
      </p>
    </div>
    <div style="text-align:center;margin:24px 0">
      <a href="${PORTAL_URL}?action=submit" style="background:#1A3C6E;color:#fff;padding:12px 32px;border-radius:8px;
        text-decoration:none;font-size:15px;font-weight:700;display:inline-block">Submit Report →</a>
    </div>
    <p style="font-size:12px;color:#888;border-top:1px solid #eee;padding-top:14px;margin-top:14px">
      For help, contact your PMU coordinator.<br>
      Samagra Shiksha, Secondary, Uttar Pradesh | PMU Office
    </p>
  </div>
</div>`
      });
      sent++;
      recipients.push(u.org + ' <' + u.email + '>');
      Logger.log('Reminder → ' + u.email + ' (' + u.org + ')');
    } catch(e) {
      Logger.log('Email failed for ' + u.email + ': ' + e.message);
    }
  });

  Logger.log('Month-end reminders sent to ' + sent + ' pending NGOs.');
  return { sent: sent, month: monthLabel, recipients: recipients };
}


// ── 2. One-time setup: monthly reminder trigger ───────────────
// Run ONCE manually: Extensions → Apps Script → select setupMonthlyTriggers → Run
function setupMonthlyTriggers() {
  // Remove existing trigger for sendMonthEndReminders
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'sendMonthEndReminders') ScriptApp.deleteTrigger(t);
  });

  // 30th of every month at 10 AM — pending-report reminder
  ScriptApp.newTrigger('sendMonthEndReminders')
    .timeBased()
    .onMonthDay(30)
    .atHour(10)
    .create();

  Logger.log('Trigger set: sendMonthEndReminders on 30th at 10 AM');
}
