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
    else if (action === 'saveProject')   result = saveProject(p);
    else if (action === 'getProjects')   result = getProjects(p);
    else if (action === 'submitReport')  result = submitReport({ report: JSON.parse(p.report) });
    // legacy — kept for backward compat
    else if (action === 'login')          result = login(p);
    else if (action === 'changePassword') result = changePassword(p);
    else result = { error: 'Unknown action' };
    return respond(result, p.callback);
  } catch (err) {
    return respond({ error: err.message }, e.parameter.callback);
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

    // Check NGO active status
    if (!isNGOActive(org)) {
      return { success: false, error: 'Your organisation is currently inactive. Please contact PMU Admin.' };
    }

    // Ensure OTP columns exist (col 7 = otp, col 8 = otp_expiry)
    const hRow = sheet.getRange(1, 1, 1, 8).getValues()[0];
    if (!hRow[6]) sheet.getRange(1, 7).setValue('otp');
    if (!hRow[7]) sheet.getRange(1, 8).setValue('otp_expiry');

    // Generate 6-digit OTP
    const otp    = String(Math.floor(100000 + Math.random() * 900000));
    const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    sheet.getRange(i + 1, 7).setValue(otp);
    sheet.getRange(i + 1, 8).setValue(expiry);

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
          'Login at: https://alokkmohan.github.io/NGO/\n\n' +
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
function isNGOProfileDone(orgName) {
  const sheet = getSS().getSheetByName('NGOs');
  if (!sheet) return false;
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]).trim().toLowerCase() === orgName.trim().toLowerCase()) {
      const phone = String(rows[i][14] || '').trim();
      const dist  = String(rows[i][4]  || '').trim();
      return phone !== '' || dist !== '';
    }
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
// NGOs sheet columns: id|name|theme|person|dist|x|y|schools|students|girls|teachers|progress|month|kmi
function getNGOs() {
  const sheet = getSS().getSheetByName('NGOs');
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
//   scst|divyang|budget|dropout|tasks_readable|tasks_json|status|kmi|achieve|challenges|
//   support|plans|photos_count|photos_folder|submitted|equipment|training|machine|donation|other_support
function getReports() {
  const sheet = getSS().getSheetByName('Reports');
  const rows  = sheet.getDataRange().getValues();
  if (rows.length < 2) return { success: true, data: [] };
  const headers = rows[0];
  const data    = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    // App reads 'tasks' — serve tasks_json if available, else tasks_readable
    if (!obj['tasks'] && obj['tasks_json']) obj['tasks'] = obj['tasks_json'];
    if (!obj['tasks'] && obj['tasks_readable']) obj['tasks'] = '[]'; // fallback
    return obj;
  });
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

// ── SUBMIT REPORT ────────────────────────────────────────────
function submitReport(data) {
  const ss     = getSS();
  const rSheet = ss.getSheetByName('Reports');
  const r      = data.report;

  // Ensure header row has tasks_readable and tasks_json columns
  const hRow = rSheet.getRange(1, 1, 1, rSheet.getLastColumn()).getValues()[0];
  if (!hRow.includes('tasks_readable')) {
    // First time: rename old 'tasks' header to 'tasks_readable', add 'tasks_json' next to it
    const taskColIdx = hRow.indexOf('tasks');
    if (taskColIdx >= 0) {
      rSheet.getRange(1, taskColIdx + 1).setValue('tasks_readable');
      // Insert new column for tasks_json after tasks_readable
      rSheet.insertColumnAfter(taskColIdx + 1);
      rSheet.getRange(1, taskColIdx + 2).setValue('tasks_json');
    }
  }

  const readableText = tasksToReadable(r.tasks);

  rSheet.appendRow([
    new Date().getTime(),
    r.ngo, r.month,
    r.schools  || 0, r.students  || 0, r.girls   || 0, r.teachers || 0,
    r.meetings || 0, r.events    || 0, r.scst     || 0, r.divyang  || 0,
    0, r.dropout || 0,
    readableText,      // tasks_readable — human friendly
    r.tasks    || '',  // tasks_json    — raw JSON for app
    r.status   || '',
    r.kmi      || '', r.achieve  || '', r.challenges || '',
    r.support  || '', r.plans    || '',
    r.photos_count  || 0,
    r.photos_folder || '',
    new Date().toLocaleDateString('en-IN'),
    r.equipment || '', r.training || '', r.machine || '',
    r.donation  || '', r.other_support || ''
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

// ── PROJECTS ────────────────────────────────────────────────
// Projects sheet: project_id|ngo|component|task_name|description|target_schools|target_students|target_girls|target_teachers|target_meetings|target_events|start_date|end_date|status|created_on
function saveProject(data) {
  const ss = getSS();
  let sheet = ss.getSheetByName('Projects');
  if (!sheet) {
    sheet = ss.insertSheet('Projects');
    sheet.appendRow(['project_id','ngo','component','task_name','description',
      'target_schools','target_students','target_girls','target_teachers',
      'target_meetings','target_events','start_date','end_date','status','created_on','sub_activities']);
  } else {
    // Ensure sub_activities column exists
    const hRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    if (!hRow.includes('sub_activities')) {
      sheet.getRange(1, hRow.length + 1).setValue('sub_activities');
    }
  }
  const id = new Date().getTime();
  sheet.appendRow([
    id, data.ngo, data.component, data.task_name, data.description||'',
    +data.target_schools||0, +data.target_students||0, +data.target_girls||0,
    +data.target_teachers||0, +data.target_meetings||0, +data.target_events||0,
    data.start_date||'', data.end_date||'', 'active',
    new Date().toLocaleDateString('en-IN'),
    data.sub_activities || '[]'
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
  // Filter by NGO if requested (non-admin)
  if (data.ngo) projects = projects.filter(p => p.ngo === data.ngo);
  return { success: true, data: projects };
}

// ── SAVE NEW NGO PROFILE ─────────────────────────────────────
function saveProfile(data) {
  const ss = getSS();

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
      // Send email
      try {
        MailApp.sendEmail({
          to: rows[i][0],
          subject: 'Samagra UP NGO Portal — Password Reset',
          body: `Dear ${rows[i][3] || 'Partner'},\n\nYour password has been reset.\n\nTemporary Password: ${temp}\n\nPlease login and change your password immediately.\n\nLogin at: https://alokkmohan.github.io/NGO/\n\n— PMU Team, Samagra UP Secondary Education Programme`
        });
      } catch(e) {
        // Email failed — still return temp password so admin can share manually
        return { success: true, temp, emailSent: false };
      }
      return { success: true, emailSent: true };
    }
  }
  return { success: false, error: 'Email not found in system' };
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
