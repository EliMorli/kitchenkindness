// Shared settings for the Mail tab and the mail sync.

export const MAIL_MODEL = 'claude-opus-5-5';

export const LABEL_ROOT = 'Kitchen Requests';
export const LABELS = {
  pending: `${LABEL_ROOT}/Pending`,
  approved: `${LABEL_ROOT}/Approved`,
  declined: `${LABEL_ROOT}/Declined`
};

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];

export const LIMITS = {
  bodyChars: 20000,
  sourceBytes: 2_000_000,
  messagesPerRun: 25,
  aiPerRun: 9,
  aiConcurrency: 3,
  labelsPerRun: 30,
  sendsPerRun: 20,
  sendAttempts: 3,
  aiAttempts: 3,
  firstRunDays: 7,
  replyCooldownDays: 7,
  staleClaimMinutes: 10,
  runDeadlineMs: 45_000,
  lockSeconds: 75
};

export const DEFAULT_TEMPLATES = {
  auto_reply_body:
    "Hi {name},\n\nThank you so much for your email. We'll get back to you as soon as possible.\n\nWith warmth,\nKitchen of Kindness",
  approval_body:
    'Hi {name},\n\nGood news: the household at {address} has been added to the Kitchen of Kindness delivery list. ' +
    'Meals will be delivered on {days}.\n\nIf anything changes (address, phone, number of people), just reply to this email.\n\n' +
    'With warmth,\nKitchen of Kindness'
};

export const TEMPLATE_HELP = {
  auto_reply_body: '{name} = the sender’s first name',
  approval_body: '{name} = first name, {address}, {days}, {family_id}'
};

export const FROM_NAME = 'Kitchen of Kindness';
