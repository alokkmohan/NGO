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
    else if (action === 'saveProject')          result = saveProject(p);
    else if (action === 'getProjects')          result = getProjects(p);
    else if (action === 'deleteUnlockedProjects') result = deleteUnlockedProjects(p);
    else if (action === 'lockProject')          result = lockProject(p);
    else if (action === 'lockReport')           result = lockReport(p);
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

// POST used for photo upload and saveProfile (large school list exceeds GET URL limit)
function doPost(e) {
  try {
    const data   = JSON.parse(e.postData.contents);
    const action = data.action;
    if (action === 'uploadPhoto')  return respond(uploadPhoto(data));
    if (action === 'saveProfile')  return respond(saveProfile(data));
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
          'Login at: https://samsecup.dataimpact.in/\n\n' +
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
  const ss = getSS();

  // Check NGOs sheet — must have person name AND district filled
  const ngoSheet = ss.getSheetByName('NGOs');
  if (!ngoSheet) return false;
  const ngoRows = ngoSheet.getDataRange().getValues();
  const h = ngoRows[0];
  const nameIdx   = h.indexOf('name');
  const personIdx = h.indexOf('person');
  const distIdx   = h.indexOf('dist');

  let hasPerson = false, hasDist = false;
  for (let i = 1; i < ngoRows.length; i++) {
    const rowName = nameIdx >= 0 ? String(ngoRows[i][nameIdx]||'') : String(ngoRows[i][1]||'');
    if (rowName.trim().toLowerCase() !== orgName.trim().toLowerCase()) continue;
    const person = personIdx >= 0 ? String(ngoRows[i][personIdx]||'') : String(ngoRows[i][14]||'');
    const dist   = distIdx   >= 0 ? String(ngoRows[i][distIdx]  ||'') : String(ngoRows[i][4] ||'');
    hasPerson = person.trim() !== '';
    hasDist   = dist.trim()   !== '';
    break;
  }
  if (!hasPerson || !hasDist) return false;

  // Check Projects sheet — must have at least one locked active task
  const projSheet = ss.getSheetByName('Projects');
  if (!projSheet) return false;
  const projRows = projSheet.getDataRange().getValues();
  const ph = projRows[0];
  const pNgoIdx    = ph.indexOf('ngo');
  const pStatusIdx = ph.indexOf('status');
  const pLockedIdx = ph.indexOf('locked');
  for (let i = 1; i < projRows.length; i++) {
    const pNgo    = pNgoIdx    >= 0 ? String(projRows[i][pNgoIdx]   ||'') : '';
    const pStatus = pStatusIdx >= 0 ? String(projRows[i][pStatusIdx]||'') : '';
    const pLocked = pLockedIdx >= 0 ? String(projRows[i][pLockedIdx]||'') : '';
    if (pNgo.trim().toLowerCase() !== orgName.trim().toLowerCase()) continue;
    if (pStatus === 'deleted') continue;
    if (pLocked.toLowerCase() === 'true') return true;
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
    // Ensure tasks_json is always a string for JSON.parse on client
    if (obj['tasks_json'] && typeof obj['tasks_json'] !== 'string') obj['tasks_json'] = JSON.stringify(obj['tasks_json']);
    // App reads 'tasks' — serve tasks_json if available, else fallback
    obj['tasks'] = obj['tasks_json'] || obj['tasks'] || '[]';
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

  // Ensure report_from / report_to columns exist
  const hRow2 = rSheet.getRange(1, 1, 1, rSheet.getLastColumn()).getValues()[0];
  if (!hRow2.includes('report_from')) rSheet.getRange(1, hRow2.length + 1).setValue('report_from');
  if (!hRow2.includes('report_to'))   rSheet.getRange(1, hRow2.length + 2).setValue('report_to');

  // Ensure report_locked column exists
  const hRow3 = rSheet.getRange(1, 1, 1, rSheet.getLastColumn()).getValues()[0];
  if (!hRow3.includes('report_locked')) rSheet.getRange(1, hRow3.length + 1).setValue('report_locked');

  // Check if report for this NGO+month already exists (update instead of insert)
  const allRows = rSheet.getDataRange().getValues();
  const hdr0 = allRows[0];
  const ngoIdx0    = hdr0.indexOf('ngo');
  const monthIdx0  = hdr0.indexOf('month');
  const lockedIdx0 = hdr0.indexOf('report_locked');
  let updateRow = -1;
  for (let i = 1; i < allRows.length; i++) {
    if (String(allRows[i][ngoIdx0]) === String(r.ngo) && String(allRows[i][monthIdx0]) === String(r.month)) {
      if (lockedIdx0 >= 0 && String(allRows[i][lockedIdx0]).toLowerCase() === 'true') {
        return { success: false, error: 'Report is locked and cannot be updated.' };
      }
      updateRow = i + 1; // 1-indexed sheet row
      break;
    }
  }

  const newRow = [
    updateRow > 0 ? allRows[updateRow-1][0] : new Date().getTime(), // keep original id if update
    r.ngo, r.month,
    r.schools  || 0, r.students  || 0, r.girls   || 0, r.teachers || 0,
    r.meetings || 0, r.events    || 0, r.scst     || 0, r.divyang  || 0,
    0, r.dropout || 0,
    readableText,
    r.tasks    || '',
    r.status   || '',
    r.kmi      || '', r.achieve  || '', r.challenges || '',
    r.support  || '', r.plans    || '',
    r.photos_count  || 0,
    r.photos_folder || '',
    new Date().toLocaleDateString('en-IN'),
    r.equipment || '', r.training || '', r.machine || '',
    r.donation  || '', r.other_support || '',
    r.report_from || '', r.report_to || '',
    'false' // report_locked
  ];

  if (updateRow > 0) {
    rSheet.getRange(updateRow, 1, 1, newRow.length).setValues([newRow]);
  } else {
    rSheet.appendRow(newRow);
  }

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

  // Save report as Google Doc in NGO's Drive folder
  let docUrl = '';
  try {
    const ngoFolder = getOrCreateNGOFolder(r.ngo);
    const docInfo   = saveReportDoc(r, ngoFolder);
    docUrl = docInfo.docUrl;

    // Write the doc URL back into the Reports sheet (last column)
    const lastRow = rSheet.getLastRow();
    const hdr = rSheet.getRange(1, 1, 1, rSheet.getLastColumn()).getValues()[0];
    let docCol = hdr.indexOf('drive_doc_url');
    if (docCol < 0) {
      docCol = hdr.length;
      rSheet.getRange(1, docCol + 1).setValue('drive_doc_url');
    }
    rSheet.getRange(lastRow, docCol + 1).setValue(docUrl);
  } catch (driveErr) {
    // Drive save failed — don't block report submission
    Logger.log('Drive save error: ' + driveErr.message);
  }

  return { success: true, docUrl: docUrl };
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
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][ngoIdx]) === String(data.ngo) && String(rows[i][monthIdx]) === String(data.month)) {
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
  body.appendParagraph('Samagra Shiksha, Secondary, Uttar Pradesh | PMU')
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
          body: `Dear ${rows[i][3] || 'Partner'},\n\nYour password has been reset.\n\nTemporary Password: ${temp}\n\nPlease login and change your password immediately.\n\nLogin at: https://samsecup.dataimpact.in/\n\n— PMU Team, Samagra UP Secondary Education Programme`
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
