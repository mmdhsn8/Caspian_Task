export interface TelegramSendResult {
  listingId: string;
  success: boolean;
  messageId: number | null;
  attempts: number;
  error: string | null;
}

export interface TelegramNotificationSummary {
  requested: number;
  sent: number;
  failed: number;
  skipped: number;
  retries: number;
  retryDelayMs: number;
  retriedListings: number;
  maxAttemptsUsed: number;
  results: TelegramSendResult[];
}
