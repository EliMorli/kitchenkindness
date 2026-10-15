-- Runs the mail sync (/api/mail/sync) every 5 minutes from Supabase, so the
-- app doesn't depend on Vercel's cron plan. Kept for reference.
--
-- The bearer secret is NOT in this file. Store it once in the Supabase SQL
-- editor (the same value as MAIL_CRON_SECRET in Vercel):
--   SELECT vault.create_secret('<MAIL_CRON_SECRET>', 'mail_cron_secret', 'Bearer for /api/mail/sync');
-- To change it later:
--   SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'mail_cron_secret'), '<new value>');
--
-- Pause: set Mode to Off in the Mail tab settings (the route then does
-- nothing), or SELECT cron.unschedule('kok-mail-sync');
-- Check recent calls: SELECT * FROM net._http_response ORDER BY created DESC LIMIT 10;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.schedule('kok-mail-sync', '*/5 * * * *', '
  SELECT net.http_post(
    url := ''https://kitchenofkindness.app/api/mail/sync'',
    headers := jsonb_build_object(
      ''Content-Type'', ''application/json'',
      ''Authorization'', ''Bearer '' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''mail_cron_secret'')),
    body := ''{"source":"pg_cron"}''::jsonb,
    timeout_milliseconds := 55000)');

-- Keep the cron history small.
SELECT cron.schedule('kok-cron-cleanup', '23 4 * * *',
  'DELETE FROM cron.job_run_details WHERE end_time < now() - interval ''7 days''');
