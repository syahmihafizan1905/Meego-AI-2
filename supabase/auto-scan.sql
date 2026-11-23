-- MEEGO AI auto setups: wake the bot every 5 minutes to watch TP/SL and look for new setups.
do $$ begin perform cron.unschedule('meego-scan'); exception when others then null; end $$;
select cron.schedule('meego-scan', '*/5 * * * *', $cron$
  select net.http_post(
    url := (select value from public.app_settings where key = 'telegram_url'),
    body := '{"event":"scan"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-meego-secret', (select value from public.app_settings where key = 'telegram_secret'))
  );
$cron$);
