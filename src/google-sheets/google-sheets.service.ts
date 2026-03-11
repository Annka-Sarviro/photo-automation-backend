import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GoogleSpreadsheet,
  GoogleSpreadsheetWorksheet,
  GoogleSpreadsheetRow,
} from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { GOOGLE_SHEET_COLUMNS } from '../common/constants.js';
import { BookingData } from '../common/interfaces.js';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

interface IConfig {
  get(key: string): unknown;
}

@Injectable()
export class GoogleSheetsService implements OnModuleInit {
  private doc!: GoogleSpreadsheet;

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
  ) {}

  async onModuleInit() {
    const config = this.configService as unknown as IConfig;
    const serviceAccountEmail = (
      config.get('GOOGLE_SERVICE_ACCOUNT_EMAIL') as string
    ).trim();

    const spreadsheetId = (config.get('GOOGLE_SHEETS_ID') as string).trim();

    const rawKey = config.get('GOOGLE_SERVICE_ACCOUNT_KEY') as string;

    if (!serviceAccountEmail || !rawKey || !spreadsheetId) {
      console.error('Google Sheets configuration is missing');
      return;
    }

    // Newlines in env vars can be tricky. We handle escaped \n and also remove potential wrapped quotes.
    let serviceAccountKey = rawKey
      .replace(/\\n/g, '\n')
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1');

    // Check if the key is actually the whole JSON string
    if (serviceAccountKey.startsWith('{')) {
      try {
        const json = JSON.parse(serviceAccountKey) as Record<string, unknown>;
        if (typeof json.private_key === 'string') {
          serviceAccountKey = json.private_key;
          console.log('✅ Extracted private_key from JSON string');
        }
      } catch {
        console.warn(
          '⚠️ Service account key starts with { but is not valid JSON',
        );
      }
    }

    // Final check for format
    if (!serviceAccountKey.includes('-----BEGIN PRIVATE KEY-----')) {
      console.warn(
        '⚠️ GOOGLE_SERVICE_ACCOUNT_KEY is missing header! Check your env vars.',
      );
    }

    console.log(
      `🔑 Key check: length=${serviceAccountKey.length}, startsWith="${serviceAccountKey.substring(0, 15)}..."`,
    );

    const auth = new JWT({
      email: serviceAccountEmail,
      key: serviceAccountKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    try {
      this.doc = new GoogleSpreadsheet(spreadsheetId, auth);
      await this.doc.loadInfo();
      console.log('✅ Google Sheets connection established');
    } catch (error) {
      console.error(
        '❌ Failed to connect to Google Sheets:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  async ensureMonthlySheet(date: string): Promise<GoogleSpreadsheetWorksheet> {
    const bookingDate = new Date(date);
    const monthYear = bookingDate.toLocaleString('uk-UA', {
      month: 'long',
      year: 'numeric',
    });

    let sheet = this.doc.sheetsByTitle[monthYear];
    if (!sheet) {
      sheet = await this.doc.addSheet({
        title: monthYear,
        headerValues: GOOGLE_SHEET_COLUMNS,
      });
    } else {
      // Check if headers match, if not, we might need to update them
      try {
        await sheet.loadHeaderRow();
        // If number of columns doesn't match, or the first column is not ID, reset headers
        if (
          sheet.headerValues.length !== GOOGLE_SHEET_COLUMNS.length ||
          sheet.headerValues[0] !== 'ID'
        ) {
          console.log(`🔄 Updating headers for sheet: ${monthYear}`);
          await sheet.setHeaderRow(GOOGLE_SHEET_COLUMNS);
        }
      } catch (e) {
        console.warn('Could not update headers for existing sheet:', e);
      }
    }
    return sheet;
  }

  async upsertBooking(booking: BookingData, oldDate?: string) {
    if (!booking.id || !booking.date) return;

    const manualFields: Partial<BookingData> = {};

    // First, find and remove this booking ID from relevant sheets to prevent duplicates
    // We only need to check the current date's sheet and the old date's sheet (if provided).
    const sheetsToCheck = new Set<string>();

    const currentDateStr = new Date(booking.date).toLocaleString('uk-UA', {
      month: 'long',
      year: 'numeric',
    });
    sheetsToCheck.add(currentDateStr);

    if (oldDate) {
      const oldDateStr = new Date(oldDate).toLocaleString('uk-UA', {
        month: 'long',
        year: 'numeric',
      });
      sheetsToCheck.add(oldDateStr);
    }

    for (const sheetTitle of sheetsToCheck) {
      const sheet = this.doc.sheetsByTitle[sheetTitle];
      if (!sheet) continue;

      try {
        const rows = await sheet.getRows();
        const existingRow = rows.find(
          (r: GoogleSpreadsheetRow) =>
            String(r.get('ID')) === String(booking.id),
        );
        if (existingRow) {
          // CAPTURE manual fields before deleting
          manualFields.balance = existingRow.get('Залишок') as string;
          manualFields.retouched =
            existingRow.get('Відретушовані фото') === true ||
            existingRow.get('Відретушовані фото') === 'TRUE';
          manualFields.type = existingRow.get('Тип фотосесії') as string;
          manualFields.tariff = existingRow.get('Тариф') as string;
          manualFields.deposit = existingRow.get('Завдаток') as string;
          manualFields.payment = existingRow.get('Оплата') as string;
          manualFields.source = existingRow.get('Звідки дізнались') as string;
          manualFields.alreadyBeen = existingRow.get(
            'Чи вже були на фотосесії',
          ) as string;
          manualFields.photoCount = existingRow.get('К-ть фото') as string;
          manualFields.photographer = existingRow.get('Фотограф') as string;
          manualFields.extraPhotographer = existingRow.get(
            'Екстра Фотограф',
          ) as string;
          manualFields.photographerPayment = existingRow.get(
            'Оплата фотографу',
          ) as string;
          manualFields.publicationAllowed = existingRow.get(
            'Публікація чи дозволена',
          ) as string;
          manualFields.paymentMethod = existingRow.get(
            'Спосіб оплати',
          ) as string;
          manualFields.galleryLink = existingRow.get('Посилання') as string;
          manualFields.sendGallery =
            existingRow.get('Відправка посилання') === true ||
            existingRow.get('Відправка посилання') === 'TRUE';

          await existingRow.delete();
          console.log(
            `🗑️ Removed old/duplicate booking ${booking.id} from sheet "${sheet.title}" and captured manual fields.`,
          );
        }
      } catch (e) {
        console.warn(
          `Could not check sheet "${sheet.title}" for duplicates:`,
          e,
        );
      }
    }

    // Apply preserved manual fields if they exist and are not empty
    if (manualFields.balance) booking.balance = manualFields.balance;
    if (manualFields.retouched !== undefined)
      booking.retouched = manualFields.retouched;
    if (manualFields.type) booking.type = manualFields.type;
    if (manualFields.tariff) booking.tariff = manualFields.tariff;
    if (manualFields.deposit !== undefined && manualFields.deposit !== '')
      booking.deposit = manualFields.deposit;
    if (manualFields.payment) booking.payment = manualFields.payment;
    if (manualFields.source) booking.source = manualFields.source;
    if (manualFields.alreadyBeen)
      booking.alreadyBeen = manualFields.alreadyBeen;
    if (manualFields.photoCount) booking.photoCount = manualFields.photoCount;
    if (manualFields.photographer)
      booking.photographer = manualFields.photographer;
    if (manualFields.extraPhotographer)
      booking.extraPhotographer = manualFields.extraPhotographer;
    if (manualFields.photographerPayment)
      booking.photographerPayment = manualFields.photographerPayment;
    if (manualFields.publicationAllowed)
      booking.publicationAllowed = manualFields.publicationAllowed;
    if (manualFields.paymentMethod)
      booking.paymentMethod = manualFields.paymentMethod;
    if (manualFields.galleryLink)
      booking.galleryLink = manualFields.galleryLink;
    if (manualFields.sendGallery !== undefined)
      booking.sendGallery = manualFields.sendGallery;

    const targetSheet = await this.ensureMonthlySheet(booking.date);
    const rowData = this.mapToRow(booking);

    // Always add a new row after cleaning up everywhere else
    await targetSheet.addRow(rowData);
    console.log(
      `✅ Added booking ${booking.id} to sheet "${targetSheet.title}"`,
    );

    // Always sync retouched status to GAS to ensure checkbox is initialized
    await this.triggerAutoSort(
      targetSheet.title,
      booking.id,
      !!booking.retouched,
    );
  }

  async deleteBooking(booking: Partial<BookingData>) {
    if (!booking.date) return;
    const sheet = await this.ensureMonthlySheet(booking.date);
    const rows = await sheet.getRows();

    const index = rows.findIndex(
      (r: GoogleSpreadsheetRow) => String(r.get('ID')) === String(booking.id),
    );

    if (index !== -1) {
      await rows[index].delete();
    }
  }

  private mapToRow(
    booking: BookingData,
  ): Record<string, string | number | boolean> {
    return {
      ID: booking.id || '',
      Залишок: booking.balance,
      'Дата фотосесії': booking.date,
      'Година фотосесії': booking.time,
      'Відретушовані фото': booking.retouched ? 'TRUE' : 'FALSE',
      'Тип фотосесії': booking.type,
      Тариф: booking.tariff,
      Завдаток: booking.deposit,
      Оплата: booking.payment,
      'Звідки дізнались': booking.source,
      'Чи вже були на фотосесії': booking.alreadyBeen,
      'К-ть фото': booking.photoCount,
      Фотограф: booking.photographer,
      'Екстра Фотограф': booking.extraPhotographer,
      'Оплата фотографу': booking.photographerPayment,
      'Публікація чи дозволена': booking.publicationAllowed,
      'Спосіб оплати': booking.paymentMethod,
      Посилання: booking.galleryLink,
      'Відправка посилання':
        booking.sendGallery === true || booking.sendGallery === 'TRUE'
          ? 'TRUE'
          : 'FALSE',
      'ПІ клієнта': booking.clientName,
      'Номер телефону': booking.phone,
      'Ел пошта': booking.email,
      Місто: booking.city,
      'Статус та помилки': booking.status || '',
    };
  }

  async updateBookingStatus(
    id?: string,
    date?: string,
    status?: string,
    email?: string,
  ) {
    try {
      if (!date) {
        console.warn('⚠️ Cannot update status: date is missing');
        return;
      }
      const sheet = await this.ensureMonthlySheet(date);
      const rows = await sheet.getRows();

      let row = rows.find(
        (r: GoogleSpreadsheetRow) => id && String(r.get('ID')) === String(id),
      );

      // Fallback to finding by email if ID not found or not provided
      if (!row && email) {
        row = rows.find(
          (r: GoogleSpreadsheetRow) => String(r.get('Ел пошта')) === email,
        );
        if (row) {
          console.log(`ℹ️ Found row for ${email} using email fallback`);
        }
      }

      if (row) {
        row.set('Статус та помилки', status || '');
        await row.save();
        console.log(`✅ Status updated for booking ${id || email}: ${status}`);
      } else {
        console.warn(
          `⚠️ Could not find booking (id:${id}, email:${email}) to update status`,
        );
      }
    } catch (error) {
      console.error(
        `❌ Error updating status for booking ${id || email}:`,
        error,
      );
    }
  }

  async triggerAutoSort(
    sheetName: string,
    bookingId?: string | number,
    retouched?: boolean,
  ) {
    const url = this.configService.get<string>(
      'GOOGLE_SCRIPT_SORT_URL',
    ) as string;
    const apiKey = this.configService.get<string>(
      'GOOGLE_SCRIPT_API_KEY',
    ) as string;

    const data = {
      'X-API-KEY': apiKey,
      sheetName: sheetName,
      id: bookingId,
      retouched: retouched,
    };

    try {
      await firstValueFrom(this.httpService.post(url, data));
      console.log(`✅ Запит на сортування аркуша "${sheetName}" відправлено`);
    } catch (error) {
      console.error(
        '❌ Помилка тригера:',
        error instanceof Error ? error.message : error,
      );
    }
  }
}
