-- MEEGO AI news alerts: every minute the bot checks for 🔴 USD news due in ~2 minutes
-- (prediction + news signal) and for news signals that hit SL (recovery setup).
do $$ begin perform cron.unschedule('meego-news'); exception when others then null; end $$;
select cron.schedule('meego-news', '* * * * *', $cron$
  select net.http_post(
    url := (select value from public.app_settings where key = 'telegram_url'),
    body := '{"event":"news"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-meego-secret', (select value from public.app_settings where key = 'telegram_secret'))
  );
$cron$);
