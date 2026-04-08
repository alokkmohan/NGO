# Google Workspace Setup Guide
## Samagra UP Secondary — NGO Partner Portal

Follow these steps **once** to connect the portal to Google Sheets and Drive.

---

## Step 1 — Create Google Sheet (Database)

1. Go to [sheets.google.com](https://sheets.google.com) → **Blank spreadsheet**
2. Name it: `Samagra NGO Portal DB`
3. Create **3 sheets** (tabs at the bottom):

### Sheet: `Users`
| email | password | role | name | org |
|-------|----------|------|------|-----|
| admin@pmu.up.gov.in | your_password | admin | PMU Administrator | PMU |

> Add one row per user. Role must be `admin` or `ngo`.

### Sheet: `NGOs`
Add this header row exactly:
```
id | name | theme | person | dist | x | y | schools | students | girls | teachers | progress | month | kmi
```
> Fill NGO rows below the header. `x` and `y` are map coordinates (leave 300,300 for new NGOs — admin can adjust later).

### Sheet: `Reports`
Add this header row exactly:
```
id | ngo | month | schools | students | girls | teachers | meetings | events | scst | divyang | budget | dropout | tasks | status | kmi | achieve | challenges | support | plans | photos_count | photos_folder | submitted
```
> Leave empty — reports will be added automatically when NGOs submit.

4. Copy the **Spreadsheet ID** from the URL:
   `https://docs.google.com/spreadsheets/d/**SPREADSHEET_ID**/edit`

---

## Step 2 — Create Google Drive Folder (Photo Storage)

1. Go to [drive.google.com](https://drive.google.com) → **New → Folder**
2. Name it: `NGO Portal Photos`
3. Open the folder → copy the **Folder ID** from the URL:
   `https://drive.google.com/drive/folders/**FOLDER_ID**`

---

## Step 3 — Set Up Google Apps Script

1. Go to [script.google.com](https://script.google.com) → **New project**
2. Name it: `Samagra NGO Backend`
3. Delete the default `Code.gs` content
4. Paste the entire contents of `Code.gs` (from this repository)
5. Replace the two constants at the top:
   ```js
   const SHEET_ID        = 'your_spreadsheet_id_here';
   const DRIVE_FOLDER_ID = 'your_drive_folder_id_here';
   ```
6. Click **Deploy → New deployment**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Click **Deploy** → authorise permissions when prompted
8. Copy the **Web App URL** (looks like `https://script.google.com/macros/s/ABC.../exec`)

---

## Step 4 — Connect Portal to Apps Script

1. Open `index.html` in a text editor
2. Find this line near the top of the `<script>` section:
   ```js
   const SCRIPT_URL = 'YOUR_APPS_SCRIPT_URL_HERE';
   ```
3. Replace `YOUR_APPS_SCRIPT_URL_HERE` with your Web App URL
4. Save and push to GitHub

---

## Step 5 — Test

1. Open the portal (GitHub Pages or local)
2. Login with the admin email/password you added in the Users sheet
3. The portal will load NGO data from your Sheet
4. Submit a test report — check that it appears in the Reports sheet
5. Upload a photo — check that it appears in Google Drive → `NGO Portal Photos`

---

## Managing Data

### Add a new NGO (as Admin)
Add a row to the **NGOs** sheet directly. The portal will show it on next login.

### Add a new user / NGO login
Add a row to the **Users** sheet:
```
ngo@partnerorg.org | their_password | ngo | Nodal Person Name | NGO Org Name
```

### Change admin password
Edit the password cell in the **Users** sheet.

### View all submitted reports
Open the **Reports** sheet — every submission appears here with timestamp.

### View uploaded photos
Open Google Drive → `NGO Portal Photos` → subfolder per NGO per month.

---

## Notes
- No server or hosting cost — runs entirely on Google's free tier
- Apps Script free quota: 6 min/day execution, 20,000 reads/day (sufficient for this scale)
- For large deployments (100+ NGOs), consider upgrading to Google Workspace
