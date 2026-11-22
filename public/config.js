// MEEGO AI settings. Fill these in from Supabase → Project Settings → API.
// The anon key is meant to be public: your data is protected by the database rules.
window.MEEGO_CONFIG = {
  SUPABASE_URL: "https://euoqlrwlzxzszgzqhakv.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1b3Fscndsenh6c3pnenFoYWt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzNTUwMzQsImV4cCI6MjExMDkzMTAzNH0.LSWeyWgfwzNpHxfBSMy0l8vr367hucz5ZxLMsp2t3AI",
  // Edge Function addresses (the last part of each function's URL in Supabase → Edge Functions)
  AI_FUNCTION: "clever-action",
  CANDLES_FUNCTION: "swift-task",
  // Telegram bot username from @BotFather (without @), e.g. "MeegoAIBot"
  TELEGRAM_BOT: "",
  // Support contact shown on the sign-in screen (optional)
  SUPPORT_TEXT: "Need an account? Contact the MEEGO admin."
};
