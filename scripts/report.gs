/**
 * Updates the monthly report at the bottom of the sheet.
 * This function should be called after adding or updating bookings.
 */
function updateMonthlyReport(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return; // Only header or empty

  const headers = data[0];
  const colIndex = {
    type: headers.indexOf('Тип фотосесії'),
    photographer: headers.indexOf('Фотограф'),
    payment: headers.indexOf('Оплата'),
    deposit: headers.indexOf('Завдаток'),
    photographerPayment: headers.indexOf('Оплата фотографу'),
    paymentMethod: headers.indexOf('Спосіб оплати'),
    id: headers.indexOf('ID')
  };

  // 1. Stats containers
  const typeCounts = {};
  const photographerPayments = {}; // Dynamics: { "Name": total }
  const methodTotals = {};       // Dynamics: { "method": total }
  let totalDeposit = 0;

  // 2. Iterate through data (skipping headers and previous report)
  let lastBookingRow = 1;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const idValue = String(row[colIndex.id] || '').trim();
    
    // Stop if we hit the report marker
    if (idValue === 'ЗВІТ') {
      break;
    }

    // Check if the row is effectively empty (no ID, no Date, no Client Name)
    const dateValue = String(row[headers.indexOf('Дата фотосесії')] || '').trim();
    const clientValue = String(row[headers.indexOf('ПІ клієнта')] || '').trim();
    
    if (!idValue && !dateValue && !clientValue) {
      // Potentially skip row if it's just a blank space between entries
      // but if we are at the end, break.
      // For now, let's just continue if there's any data in other columns
      if (row.every(cell => String(cell).trim() === '')) break;
    }

    lastBookingRow = i + 1;

    // Type of photoshoot
    const type = String(row[colIndex.type] || '').trim();
    if (type) {
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    }

    // Photographer payments
    const photographer = String(row[colIndex.photographer] || '').trim();
    const pPayment = parseFloat(row[colIndex.photographerPayment]) || 0;
    if (photographer) {
      photographerPayments[photographer] = (photographerPayments[photographer] || 0) + pPayment;
    }

    // Payment methods
    const method = String(row[colIndex.paymentMethod] || '').trim();
    const payment = parseFloat(row[colIndex.payment]) || 0;
    if (method) {
      methodTotals[method] = (methodTotals[method] || 0) + payment;
    }

    // Deposit
    const deposit = parseFloat(row[colIndex.deposit]) || 0;
    totalDeposit += deposit;
  }

  // 3. Clear existing report area below lastBookingRow
  const reportStartRow = lastBookingRow + 2;
  const maxRows = sheet.getMaxRows();
  if (maxRows >= reportStartRow) {
    const clearRange = sheet.getRange(reportStartRow, 1, maxRows - reportStartRow + 1, 5);
    clearRange.clearContent();
    clearRange.setBackground(null);
    clearRange.setFontWeight('normal');
    clearRange.setBorder(false, false, false, false, false, false);
    // Unmerge any previously merged cells in this area
    try {
      clearRange.breakApart();
    } catch (e) {
      // Ignore if no merged cells
    }
  }

  // 4. Write new report
  let currentRow = reportStartRow;
  
  /** 
   * Helper to write a row with merged label (A-C) and value (D)
   */
  const writeReportRow = (label, value, isHeader = false) => {
    const labelRange = sheet.getRange(currentRow, 1, 1, 3);
    labelRange.merge().setValue(label);
    if (isHeader) {
      labelRange.setFontWeight('bold');
    }
    
    if (value !== undefined) {
      const valueCell = sheet.getRange(currentRow, 4);
      valueCell.setValue(value);
      if (isHeader) valueCell.setFontWeight('bold');
    }
    currentRow++;
  };

  // Header "ЗВІТ"
  const mainHeader = sheet.getRange(currentRow, 1, 1, 4);
  mainHeader.merge().setValue('ЗВІТ').setFontWeight('bold').setBackground('#f3f3f3').setHorizontalAlignment('center');
  currentRow += 2;

  // Section 1: Types
  writeReportRow('Типи фотосесій:', undefined, true);
  for (const [type, count] of Object.entries(typeCounts)) {
    writeReportRow(type, count);
  }
  currentRow++;

  // Section 2: Photographers
  writeReportRow('Оплата фотографам:', undefined, true);
  for (const [name, total] of Object.entries(photographerPayments)) {
    writeReportRow(name, total);
  }
  currentRow++;

  // Section 3: Payment Methods
  writeReportRow('Способи оплати:', undefined, true);
  for (const [method, total] of Object.entries(methodTotals)) {
    writeReportRow(method, total);
  }
  currentRow++;

  // Section 4: Total Deposit
  writeReportRow('Загальний завдаток (сайт):', totalDeposit, true);
  
  // Styling the report area
  const reportRange = sheet.getRange(reportStartRow, 1, currentRow - reportStartRow, 4);
  reportRange.setBorder(true, true, true, true, true, true);
}

/**
 * Automatically runs on the 1st of every month to generate a report for the previous month.
 */
function runMonthlyReportAutomation() {
  const now = new Date();
  // Set to the last day of the previous month
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth(), 0);
  
  // Format matches 'uk-UA' month long + year numeric
  const monthYear = prevMonthDate.toLocaleString('uk-UA', {
    month: 'long',
    year: 'numeric',
  });

  console.log('Running monthly report for: ' + monthYear);
  updateMonthlyReport(monthYear);
}

/**
 * Run this function ONCE in the Apps Script editor to set up the automatic trigger.
 */
function setupMonthlyTrigger() {
  // Clear any existing triggers for this function to avoid duplicates
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runMonthlyReportAutomation') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Create a new trigger for the 1st day of every month at 1:00 AM
  ScriptApp.newTrigger('runMonthlyReportAutomation')
    .timeBased()
    .onMonthDay(1)
    .atHour(1)
    .create();
    
  console.log('✅ Monthly trigger scheduled successfully for the 1st of every month at 1:00 AM.');
}

/**
 * Main entrance for web app trigger (keeps real-time updates if needed)
 */
function doPost(e) {
  const params = JSON.parse(e.postData.contents);
  if (params['X-API-KEY'] !== 'YOUR_SECRET_API_KEY') {
    return ContentService.createTextOutput('Unauthorized').setMimeType(ContentService.MimeType.TEXT);
  }
  
  if (params.sheetName) {
    updateMonthlyReport(params.sheetName);
  }
  
  return ContentService.createTextOutput('Success').setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Функція для ручного тестування звіту.
 * Просто впишіть назву потрібного листа нижче і натисніть "Run".
 */
function manualTestReport() {
  const sheetName = "лютий 2026"; // Впишіть назву вашого листа тут (напр. "лютий 2026")
  console.log('Тестування звіту для листа: ' + sheetName);
  updateMonthlyReport(sheetName);
}
