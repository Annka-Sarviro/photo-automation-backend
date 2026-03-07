/** ─── КОНФІГУРАЦІЯ ──────────────────────────────────────────────────────────── */
const props = PropertiesService.getScriptProperties().getProperties();

const CONFIG = {
    BACKEND_URL: props.BACKEND_URL || '',
    API_KEY: props.API_SECRET_KEY || '',
    DEBOUNCE_MS: 5000,
    CACHE_TTL: 25,
};

/**
 * Returns a map of column header names to their 1‑based column indices for the given sheet.
 * The first row is expected to contain the headers exactly as defined in the backend constants.
 */
function getColumnMap(sheet) {
    const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const map = {};
    headerRow.forEach((name, idx) => {
        if (name) {
            map[name.toString().trim()] = idx + 1; // 1‑based index
        }
    });
    return map;
}

/**
 * Головний обробник подій редагування
 */
function onSheetEdit(e) {
    console.log("--- ТРИГЕР onSheetEdit Запущено ---");
    if (!e || !e.range) return;

    const range = e.range;
    const sheet = range.getSheet();
    const col = range.getColumn();
    const row = range.getRow();
    const value = range.getValue();

    // Build a dynamic column map for this sheet (header row based)
    const COL = getColumnMap(sheet);


    if (row <= 1) return;

    // Читаємо рядок один раз
    const lastCol = Math.max(col, COL['Ел пошта'], COL['Посилання']);
    const rowData = sheet.getRange(row, 1, 1, lastCol).getValues()[0];

    const clientEmail = rowData[COL['Ел пошта'] - 1];
    const clientName = rowData[COL['ПІ клієнта'] - 1];
    const bookingId = rowData[COL['ID'] - 1];
    const bookingDate = rowData[COL['Дата фотосесії'] - 1];


    // ── ЛОГІКА: Відправка посилання на галерею за чекбоксом ────────
    if (col === COL['Відправка посилання'] && (value === true || value === 'TRUE')) {
        const oldValue = e.oldValue;
        // Перевіряємо, чи змінилося з false/порожньо на true (щоб не слати при знятті)
        const wasEmptyOrFalse = !oldValue || oldValue === 'false' || oldValue === false || oldValue === 'FALSE';

        if (wasEmptyOrFalse) {
            const galleryLink = rowData[COL['Посилання'] - 1] ? rowData[COL['Посилання'] - 1].toString().trim() : '';

            if (galleryLink !== '') {
                if (!isValidEmail(clientEmail)) {
                    console.warn(`Рядок ${row}: Email невалідний, пропускаємо.`);
                    return;
                }

                sendWebhook({
                    id: bookingId,
                    date: bookingDate,
                    clientName,
                    email: clientEmail,
                    galleryLink: galleryLink,
                    eventType: 'gallery_link'
                });
                sheet.getRange(row, COL['Статус та помилки']).setValue("лист відправлено 1");
            } else {
                console.warn(`Рядок ${row}: Посилання на галерею порожнє, не відправляємо.`);
                // Опціонально можна зняти чекбокс назад, якщо посилання немає
                range.setValue(false);
            }
        }
    }

    // ── ЛОГІКА: Відретушовані фото ──
    if (col === COL['Відретушовані фото'] && (value === true || value === 'TRUE')) {
        if (isValidEmail(clientEmail)) {
            sendWebhook({
                id: bookingId,
                date: bookingDate,
                clientName,
                email: clientEmail,
                retouched: true,
                eventType: 'retouched'
            });
            sheet.getRange(row, COL['Статус та помилки']).setValue("лист відправлено 2");
        }
    }

    // ── ЛОГІКА: Сортування ──
    if (col === COL['Дата фотосесії'] || col === COL['Година фотосесії']) {
        if (rowData[COL['Дата фотосесії'] - 1] && rowData[COL['Година фотосесії'] - 1]) {
            const cache = CacheService.getScriptCache();
            const lockKey = `sort_lock_${sheet.getName()}`;
            const editTs = Date.now().toString();

            cache.put(lockKey, editTs, CONFIG.CACHE_TTL);
            Utilities.sleep(CONFIG.DEBOUNCE_MS);

            if (cache.get(lockKey) === editTs) {
                autoSortSheet(sheet);
            }
        }
    }
    if (col === COL['Дата фотосесії'] || col === COL['Година фотосесії'] || col === COL['Відретушовані фото'] || col === COL['Відправка посилання']) {
        fixCheckbox(sheet, row);
    }
}

/**
 * HTTP: ЗАПИТ ВІД БЕКЕНДУ (doPost)
 */
function doPost(e) {
    try {
        const postData = JSON.parse(e.postData.contents);

        // БЕЗПЕКА: Перевірка ключа
        const incomingKey = postData['X-API-KEY'] || e.parameter['api_key'];
        if (incomingKey !== CONFIG.API_KEY) {
            return jsonResponse({ status: 'error', message: 'Unauthorized' });
        }

        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const sheet = postData.sheetName ? ss.getSheetByName(postData.sheetName) : ss.getActiveSheet();
        if (!sheet) return jsonResponse({ status: 'error', message: 'Sheet not found' });

        // 1. Спочатку виконуємо сортування
        autoSortSheet(sheet);

        const COL = getColumnMap(sheet);

        // 2. ЛОГІКА ВИПРАВЛЕННЯ ЧЕКБОКСА ЗА ID
        const idToFind = postData.id; // Бекенд має передавати "id" у JSON

        if (idToFind && COL['ID']) {
            const lastRow = sheet.getLastRow();
            // Отримуємо всі ID з колонки ID
            const ids = sheet.getRange(1, COL['ID'], lastRow).getValues();

            let targetRow = -1;
            // Шукаємо рядок з потрібним ID
            for (let i = lastRow - 1; i >= 0; i--) {
                if (ids[i][0].toString() === idToFind.toString()) {
                    targetRow = i + 1;
                    break;
                }
            }

            // 3. Якщо рядок знайдено — примусово ставимо чекбокс
            if (targetRow !== -1 && postData.hasOwnProperty('retouched') && postData.retouched !== undefined && COL['Відретушовані фото']) {
                const cell = sheet.getRange(targetRow, COL['Відретушовані фото']);

                // РАДИКАЛЬНИЙ ФІКС: очищуємо текст і ставимо графічний елемент
                cell.clearContent();
                cell.clearDataValidations();
                cell.setNumberFormat('General');
                cell.insertCheckboxes();

                // Встановлюємо стан (за замовчуванням false, або що прийшло з бекенду)
                const isRetouched = postData.retouched === true || postData.retouched === 'true';
                cell.setValue(isRetouched);

                console.log(`ID ${idToFind} знайдено в рядку ${targetRow}. Чекбокс оновлено станом: ${isRetouched}`);
            }

            // 4. Ініціалізація чекбокса "Відправка посилання"
            if (targetRow !== -1 && COL['Відправка посилання']) {
                const cell = sheet.getRange(targetRow, COL['Відправка посилання']);
                const val = cell.getValue();
                if (val !== true && val !== false) {
                    cell.insertCheckboxes();
                    cell.setValue(false);
                }
            } else if (targetRow === -1) {
                console.warn(`Запис з ID ${idToFind} не знайдено після сортування.`);
            }
        }

        return jsonResponse({ status: 'success', sheet: sheet.getName() });
    } catch (err) {
        console.error("Помилка doPost: " + err.toString());
        return jsonResponse({ status: 'error', message: err.toString() });
    }
}
/**
 * СОРТУВАННЯ (З LockService)
 */
function autoSortSheet(sheet) {
    const lock = LockService.getScriptLock();
    try {
        if (!lock.tryLock(10000)) return; // Чекаємо 10 сек

        const COL = getColumnMap(sheet);
        if (!COL['Дата фотосесії'] || !COL['Година фотосесії']) return;

        const lastRow = sheet.getLastRow();
        if (lastRow <= 1) return;

        // Нормалізація дат
        const dateRange = sheet.getRange(2, COL['Дата фотосесії'], lastRow - 1, 1);
        const dateValues = dateRange.getValues().map(([val]) => {
            if (typeof val === 'string' && val.includes('.')) {
                const p = val.split('.');
                const d = new Date(p[2], p[1] - 1, p[0]);
                return isNaN(d.getTime()) ? [val] : [d];
            }
            return [val];
        });

        dateRange.setValues(dateValues);
        sheet.getRange(2, COL['Дата фотосесії'], lastRow - 1, 1).setNumberFormat('dd.mm.yyyy');
        sheet.getRange(2, COL['Година фотосесії'], lastRow - 1, 1).setNumberFormat('HH:mm:ss');

        const dataRange = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
        dataRange.sort([
            { column: COL['Дата фотосесії'], ascending: true },
            { column: COL['Година фотосесії'], ascending: true },
        ]);
    } catch (e) {
        console.error("Sort error: " + e.message);
    } finally {
        lock.releaseLock();
    }
}

/**
 * НАДСИЛАННЯ ВЕБХУКА (Тут Headers ПРАЦЮЮТЬ)
 */
function sendWebhook(payload) {
    console.log("--- ТРИГЕР ЗАПУЩЕНО ---");
    const options = {
        method: 'post',
        contentType: 'application/json',
        headers: {
            'X-API-KEY': CONFIG.API_KEY,
            'ngrok-skip-browser-warning': 'true'
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
    };
    const baseUrl = CONFIG.BACKEND_URL.trim().replace(/\/$/, "");
    const fullUrl = baseUrl + "/webhooks/sheets/update";
    console.log('Sending webhook to:', fullUrl);
    try {
        const response = UrlFetchApp.fetch(fullUrl, options);
        console.log(`[${payload.eventType}] Status: ${response.getResponseCode()}`);
    } catch (err) {
        console.error(`Webhook error: ${err}`);
    }
}

function isValidEmail(email) {
    if (!email) return false;
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email.toString().trim());
}

function jsonResponse(data) {
    return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Оптимізоване форматування одного конкретного чекбокса
 */
function fixCheckbox(sheet, row) {
    if (row <= 1) return;
    const COL = getColumnMap(sheet);
    if (!COL['Відретушовані фото'] && !COL['Відправка посилання']) return;

    // Fix Retouched checkbox
    if (COL['Відретушовані фото']) {
        const cell = sheet.getRange(row, COL['Відретушовані фото']);
        const val = cell.getValue();
        ensureCheckbox(cell, val);
    }

    // Fix Send Gallery checkbox
    if (COL['Відправка посилання']) {
        const cell = sheet.getRange(row, COL['Відправка посилання']);
        const val = cell.getValue();
        ensureCheckbox(cell, val);
    }
}

/**
 * Допоміжна функція для вставки чекбокса та збереження булевого значення
 */
function ensureCheckbox(cell, val) {
    let boolVal = false;
    if (typeof val === 'string') {
        boolVal = (val.toLowerCase().trim() === 'true');
    } else {
        boolVal = Boolean(val);
    }
    cell.clearDataValidations();
    cell.insertCheckboxes();
    cell.setValue(boolVal);
}