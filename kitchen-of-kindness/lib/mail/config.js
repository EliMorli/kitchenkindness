// Shared settings for the Mail tab and the mail sync.

export const MAIL_MODEL = 'claude-opus-5-5';

// Gmail folders (labels) the sync files emails into. No '&' in names: IMAP
// uses it as an escape character in mailbox names.
export const LABEL_ROOT = 'Kitchen of Kindness';
export const LABELS = {
  applications: `${LABEL_ROOT}/New Applications`,
  approved: `${LABEL_ROOT}/Approved`,
  declined: `${LABEL_ROOT}/Declined`,
  volunteers: `${LABEL_ROOT}/Volunteers`,
  donations: `${LABEL_ROOT}/Donations`,
  questions: `${LABEL_ROOT}/Questions and Other`,
  newsletters: `${LABEL_ROOT}/Newsletters and Ads`
};

// Claude's topic for an email that isn't a request -> its folder.
export const TOPIC_FOLDER = {
  volunteering: 'volunteers',
  donation: 'donations',
  vendor_or_newsletter: 'newsletters',
  spam: 'newsletters'
};

// Automated mail that goes to "Newsletters and Ads" without Claude. No-reply
// notifications, auto-replies and bounces stay in the inbox.
export const NEWSLETTER_REASONS = ['mailing-list', 'bulk'];

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
  firstRunDays: 30, // the first check after connecting reads (and files) this far back
  replyCooldownDays: 7,
  staleClaimMinutes: 10,
  claimCheckHours: 24, // Sent Mail can't be checked this long -> "unclear", admin can resend
  autoReplyMaxHours: 48, // no "we'll get back to you" after this
  unthreadedAfterMinutes: 15, // reply without threading if the email still isn't saved
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
