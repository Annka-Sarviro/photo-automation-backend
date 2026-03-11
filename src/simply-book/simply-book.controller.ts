import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import {
  SimplyBookService,
  SimplyBookWebhookPayload,
} from './simply-book.service.js';
import { GoogleSheetsService } from '../google-sheets/google-sheets.service.js';
import { BookingData } from '../common/interfaces.js';

@Controller('webhooks/simplybook')
export class SimplyBookController {
  constructor(
    private simplyBookService: SimplyBookService,
    private googleSheetsService: GoogleSheetsService,
  ) {}

  @Post()
  @HttpCode(200)
  async handleWebhook(@Body() payload: SimplyBookWebhookPayload) {
    console.log('Received SimplyBook webhook:', payload);

    const notificationType = payload.notification_type || '';
    const bookingId = payload.booking_id;

    if (!bookingId) {
      console.warn('Webhook received without booking_id');
      return { status: 'ignored', reason: 'no_booking_id' };
    }

    try {
      if (notificationType === 'cancel') {
        // For cancellation, we might only need the ID, but mapToBooking needs a record
        // Create a dummy record with just the ID for deletion
        const dummyBooking: BookingData = {
          id: String(bookingId),
          date: '',
          time: '',
          retouched: false,
          type: '',
          tariff: '',
          deposit: '0',
          balance: '',
          payment: '',
          source: '',
          alreadyBeen: '',
          photoCount: '',
          photographer: '',
          extraPhotographer: '',
          photographerPayment: '',
          publicationAllowed: '',
          paymentMethod: '',
          galleryLink: '',
          clientName: '',
          phone: '',
          email: '',
          city: '',
        };

        // Run deletion asynchronously
        this.googleSheetsService
          .deleteBooking(dummyBooking)
          .then(() =>
            console.log(
              `Booking ${bookingId} cancelled and removed from sheets.`,
            ),
          )
          .catch((e) =>
            console.error(
              `Error deleting cancelled booking ${bookingId}:`,
              e,
            ),
          );
      } else if (
        notificationType === 'create' ||
        notificationType === 'change'
      ) {
        // Extract old start date if available (for 'change' events)
        let oldStartDate: string | undefined;
        if (
          notificationType === 'change' &&
          payload.old_data &&
          (payload.old_data as any).start_datetime
        ) {
          oldStartDate = (payload.old_data as any).start_datetime.split(' ')[0];
        } else if (
          notificationType === 'change' &&
          payload.old_data &&
          (payload.old_data as any).start_date
        ) {
          oldStartDate = (payload.old_data as any).start_date.split(' ')[0];
        }

        // Run upsert asynchronously
        this.simplyBookService
          .getBookingDetails(bookingId)
          .then((fullBooking) =>
            this.googleSheetsService.upsertBooking(fullBooking, oldStartDate),
          )
          .then(() =>
            console.log(
              `Booking ${bookingId} ${notificationType}d and synced to sheets.`,
            ),
          )
          .catch((e) =>
            console.error(
              `Failed to sync booking ${bookingId} to sheets:`,
              e,
            ),
          );
      } else {
        console.log(`Ignored unknown notification type: ${notificationType}`);
      }
    } catch (error) {
      console.error(
        `Failed to process webhook for booking ${bookingId}:`,
        error,
      );
      // Still return 200 to SimplyBook to avoid retries if we can't handle it
    }

    return { status: 'success' };
  }

  @Post('migration/start')
  @HttpCode(200)
  async startMigration(@Body() body: { from?: string; to?: string }) {
    try {
      // Set default range: from start of 2026 to 90 days ahead
      const fromDate = body.from || '2026-01-01';
      const future = new Date();
      future.setDate(future.getDate() + 90);
      const toDate = body.to || future.toISOString().split('T')[0];

      console.log(`Starting migration for period: ${fromDate} to ${toDate}`);

      const bookings = await this.simplyBookService.getBookings(
        fromDate,
        toDate,
      );

      console.log(`Found ${bookings.length} bookings to migrate.`);

      for (const booking of bookings) {
        await this.googleSheetsService.upsertBooking(booking);
      }

      return {
        status: 'success',
        message: 'Migration completed successfully',
        count: bookings.length,
        period: { from: fromDate, to: toDate },
      };
    } catch (error) {
      console.error('Migration failed:', error);
      return {
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Unknown error during migration',
      };
    }
  }

  @Post('migration/by-ids')
  @HttpCode(200)
  async migrateByIds(@Body() body: { ids: (string | number)[] }) {
    if (!body.ids || !Array.isArray(body.ids)) {
      return {
        status: 'error',
        message: 'ids array is required and must be an array',
      };
    }

    try {
      console.log(`Starting migration for ${body.ids.length} specific IDs.`);
      const migratedIds: (string | number)[] = [];
      const failedIds: { id: string | number; error: string }[] = [];

      for (const id of body.ids) {
        try {
          const booking = await this.simplyBookService.getBookingDetails(id);
          await this.googleSheetsService.upsertBooking(booking);
          migratedIds.push(id);
        } catch (error) {
          console.error(`Failed to migrate booking ${id}:`, error);
          failedIds.push({
            id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      return {
        status: 'success',
        message: 'Specific IDs migration finished',
        totalProcessed: body.ids.length,
        migratedCount: migratedIds.length,
        failedCount: failedIds.length,
        migratedIds,
        failedIds,
      };
    } catch (error) {
      console.error('Migration by IDs failed:', error);
      return {
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Unknown error during migration',
      };
    }
  }
}
