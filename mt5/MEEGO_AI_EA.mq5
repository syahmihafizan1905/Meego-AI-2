//+------------------------------------------------------------------+
//|                                                  MEEGO_AI_EA.mq5 |
//|  Copies MEEGO AI signals (Telegram bot @MeegoAISignalBot) to MT5. |
//|  Get your key by sending /ea to the bot.                          |
//+------------------------------------------------------------------+
#property copyright "MEEGO AI"
#property version   "1.00"
#property description "Copies MEEGO AI gold signals into MT5: entry or limit order, SL, TP1/TP2/TP3,"
#property description "SL to entry after TP1 and to TP1 after TP2, lot size from your risk %."
#property description "Tools > Options > Expert Advisors > Allow WebRequest for the MEEGO URL first."

#include <Trade\Trade.mqh>

input string InpKey           = "";        // MEEGO EA key (send /ea in the bot)
input string InpSymbol        = "XAUUSD";  // Your broker's gold symbol (XAUUSD, XAUUSDm, GOLD...)
input double InpRiskPct       = 1.0;       // Risk per signal (% of balance)
input double InpMaxLot        = 1.0;       // Max total lot per signal
input bool   InpScalping      = true;      // Copy Scalping signals
input bool   InpIntraday      = true;      // Copy Intraday signals
input bool   InpSwing         = true;      // Copy Swing signals (Ultimate plan)
input bool   InpNews          = true;      // Copy News signals
input bool   InpRecovery      = true;      // Copy Recovery setups (after a news SL)
input int    InpMaxSignals    = 3;         // Max signals open at the same time
input int    InpMaxAgeMin     = 15;        // Skip market signals older than this (minutes)
input bool   InpMinLotIfSmall = false;     // Use the minimum lot when the risk lot is too small
input int    InpPollSec       = 30;        // Check for signals every N seconds
input long   InpMagic         = 771905;    // Magic number
input int    InpSlippage      = 50;        // Max slippage (points)
input string InpUrl           = "https://euoqlrwlzxzszgzqhakv.supabase.co/functions/v1/telegram"; // MEEGO feed URL

CTrade trade;
bool   g_hedging = true;
string g_status  = "starting...";

struct Sig
  {
   string id, id8, kind, news, sym, order, status;
   int    dir, pending, tpHit;
   double entry, sl, tp1, tp2, tp3, slNow, expireH;
   long   time, filled;   // milliseconds (UTC)
  };

//+------------------------------------------------------------------+
int OnInit()
  {
   if(InpKey == "")
      Alert("MEEGO AI EA: paste your EA key in the Inputs (send /ea in the bot to get it).");
   if(!SymbolSelect(InpSymbol, true))
     {
      Alert("MEEGO AI EA: symbol '" + InpSymbol + "' not found. Set your broker's gold symbol in the Inputs.");
      return(INIT_PARAMETERS_INCORRECT);
     }
   g_hedging = (AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING);
   if(!g_hedging)
      Print("MEEGO AI EA: netting account - each signal opens ONE position (TP2) instead of three.");
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpSlippage);
   trade.SetTypeFillingBySymbol(InpSymbol);
   EventSetTimer(MathMax(10, InpPollSec));
   OnTimer();
   return(INIT_SUCCEEDED);
  }
void OnDeinit(const int reason) { EventKillTimer(); Comment(""); }
void OnTick() {}

//+------------------------------------------------------------------+
bool ParseSig(string line, Sig &s)
  {
   string f[];
   if(StringSplit(line, '|', f) < 19 || f[0] != "S")
      return(false);
   s.id      = f[1];
   s.id8     = StringSubstr(f[1], 0, 8);
   s.kind    = f[2];
   s.news    = f[3];
   s.sym     = f[4];
   s.dir     = (int)StringToInteger(f[5]);
   s.order   = f[6];
   s.status  = f[7];
   s.pending = (int)StringToInteger(f[8]);
   s.entry   = StringToDouble(f[9]);
   s.sl      = StringToDouble(f[10]);
   s.tp1     = StringToDouble(f[11]);
   s.tp2     = StringToDouble(f[12]);
   s.tp3     = StringToDouble(f[13]);
   s.tpHit   = (int)StringToInteger(f[14]);
   s.slNow   = StringToDouble(f[15]);
   s.time    = StringToInteger(f[16]);
   s.expireH = StringToDouble(f[17]);
   s.filled  = StringToInteger(f[18]);
   return(s.dir != 0 && s.entry > 0 && s.sl > 0 && s.tp1 > 0);
  }

bool Wanted(Sig &s)
  {
   if(s.sym != "XAUUSD")       return(false);
   if(s.news == "pre")         return(InpNews);
   if(s.news == "recovery")    return(InpRecovery);
   if(s.kind == "Scalping")    return(InpScalping);
   if(s.kind == "Intraday")    return(InpIntraday);
   if(s.kind == "Swing")       return(InpSwing);
   return(false);
  }

string Tag(string id8, int part) { return("MEEGO|" + id8 + "|" + IntegerToString(part)); }
string IdOf(string comment)       { return(StringFind(comment, "MEEGO|") == 0 ? StringSubstr(comment, 6, 8) : ""); }
string GvDone(string id8)         { return("MEEGO_" + id8); }
string GvDelta(string id8)        { return("MEEGO_D_" + id8); }

// How many different signals have open positions or pending orders
int OpenSignalCount()
  {
   string seen = "";
   int c = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0 || PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      string id = IdOf(PositionGetString(POSITION_COMMENT));
      if(id == "" || StringFind(seen, id) >= 0) continue;
      seen += id + ",";
      c++;
     }
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong t = OrderGetTicket(i);
      if(t == 0 || OrderGetInteger(ORDER_MAGIC) != InpMagic) continue;
      string id = IdOf(OrderGetString(ORDER_COMMENT));
      if(id == "" || StringFind(seen, id) >= 0) continue;
      seen += id + ",";
      c++;
     }
   return(c);
  }

bool HasAny(string id8)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t != 0 && PositionGetInteger(POSITION_MAGIC) == InpMagic && IdOf(PositionGetString(POSITION_COMMENT)) == id8) return(true);
     }
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong t = OrderGetTicket(i);
      if(t != 0 && OrderGetInteger(ORDER_MAGIC) == InpMagic && IdOf(OrderGetString(ORDER_COMMENT)) == id8) return(true);
     }
   return(false);
  }

// Lot for a stop distance (price units) so that a full SL loses InpRiskPct of the balance
double RiskLot(double dist)
  {
   double tv = SymbolInfoDouble(InpSymbol, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tv <= 0) tv = SymbolInfoDouble(InpSymbol, SYMBOL_TRADE_TICK_VALUE);
   double ts = SymbolInfoDouble(InpSymbol, SYMBOL_TRADE_TICK_SIZE);
   if(tv <= 0 || ts <= 0 || dist <= 0) return(0);
   double risk = AccountInfoDouble(ACCOUNT_BALANCE) * InpRiskPct / 100.0;
   return(MathMin(risk / (dist / ts * tv), InpMaxLot));
  }
double NormLot(double v)
  {
   double st = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_STEP);
   if(st <= 0) st = 0.01;
   return(NormalizeDouble(MathFloor(v / st + 1e-9) * st, 2));
  }

//+------------------------------------------------------------------+
// Open a new signal: 3 positions (TP1/TP2/TP3) or one, market or limit
bool OpenSignal(Sig &s)
  {
   int    dg  = (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS);
   double ask = SymbolInfoDouble(InpSymbol, SYMBOL_ASK), bid = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
   if(ask <= 0 || bid <= 0) return(false);
   bool limit = (s.order == "limit" && s.pending == 1);
   if(limit && ((s.dir > 0 && ask <= s.entry) || (s.dir < 0 && bid >= s.entry))) limit = false; // already at a better price
   double mkt = (s.dir > 0 ? ask : bid);
   // market signals keep the same distances from your broker's price; limit orders use the signal's prices
   double delta = (limit || s.order == "limit") ? 0.0 : mkt - s.entry;
   double sl = NormalizeDouble(s.sl + delta, dg);
   double ref = limit ? s.entry : mkt;
   if((ref - sl) * s.dir <= 0) { Print("MEEGO AI EA: skip ", s.id8, " - price already past the SL"); return(false); }

   bool three = (s.tp2 > 0 && s.tp3 > 0);
   double total = RiskLot(MathAbs(ref - sl));
   double minL = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MIN);
   double lots[3];
   double tps[3];
   int parts = 0;
   double part = NormLot(total / 3.0);
   if(three && g_hedging && part >= minL)
     {
      parts = 3;
      lots[0] = part; lots[1] = part; lots[2] = part;
      tps[0] = s.tp1; tps[1] = s.tp2; tps[2] = s.tp3;
     }
   else
     {
      double one = NormLot(total);
      if(one < minL)
        {
         if(!InpMinLotIfSmall)
           {
            Print("MEEGO AI EA: skip ", s.id8, " - balance too small for ", DoubleToString(InpRiskPct, 2), "% risk (needs ", DoubleToString(minL, 2), " lot)");
            GlobalVariableSet(GvDone(s.id8), 3);
            return(false);
           }
         one = minL;
        }
      parts = 1;
      lots[0] = one;
      tps[0] = three ? s.tp2 : s.tp1;
     }

   int ok = 0;
   for(int i = 0; i < parts; i++)
     {
      double tp = NormalizeDouble(tps[i] + delta, dg);
      if((tp - ref) * s.dir <= 0) continue; // this TP is already behind the price
      string c = Tag(s.id8, parts == 3 ? i + 1 : 9);
      bool r;
      if(limit)
        {
         double price = NormalizeDouble(s.entry, dg);
         r = (s.dir > 0) ? trade.BuyLimit(lots[i], price, InpSymbol, sl, tp, ORDER_TIME_GTC, 0, c)
                         : trade.SellLimit(lots[i], price, InpSymbol, sl, tp, ORDER_TIME_GTC, 0, c);
        }
      else
         r = (s.dir > 0) ? trade.Buy(lots[i], InpSymbol, 0, sl, tp, c)
                         : trade.Sell(lots[i], InpSymbol, 0, sl, tp, c);
      if(r && (trade.ResultRetcode() == TRADE_RETCODE_DONE || trade.ResultRetcode() == TRADE_RETCODE_PLACED || trade.ResultRetcode() == TRADE_RETCODE_DONE_PARTIAL)) ok++;
      else Print("MEEGO AI EA: order failed for ", s.id8, " part ", i + 1, ": ", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription());
     }
   if(ok > 0)
     {
      GlobalVariableSet(GvDone(s.id8), 1);
      GlobalVariableSet(GvDelta(s.id8), delta);
      Print("MEEGO AI EA: opened ", s.kind, " ", (s.dir > 0 ? "BUY" : "SELL"), (limit ? " LIMIT " : " "), s.id8, " parts ", ok);
     }
   return(ok > 0);
  }

//+------------------------------------------------------------------+
// Follow the signal: cancel/close when it ends, SL to entry after TP1, SL to TP1 after TP2
void Manage(Sig &s)
  {
   int    dg    = (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS);
   double pt    = SymbolInfoDouble(InpSymbol, SYMBOL_POINT);
   double delta = GlobalVariableCheck(GvDelta(s.id8)) ? GlobalVariableGet(GvDelta(s.id8)) : 0.0;
   bool ended   = (s.status != "running");
   bool expired = (s.pending == 1 && ((long)TimeGMT() - s.time / 1000) > (long)(s.expireH * 3600.0));

   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong t = OrderGetTicket(i);
      if(t == 0 || OrderGetInteger(ORDER_MAGIC) != InpMagic || IdOf(OrderGetString(ORDER_COMMENT)) != s.id8) continue;
      if(ended || expired) trade.OrderDelete(t);
     }

   double bid = SymbolInfoDouble(InpSymbol, SYMBOL_BID), ask = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
   bool   hasTps = (s.tp2 > 0 && s.tp3 > 0);
   double tp1 = s.tp1 + delta, tp2 = s.tp2 + delta;
   bool hit1 = hasTps && (s.tpHit >= 1 || (s.dir > 0 ? bid >= tp1 : ask <= tp1));
   bool hit2 = hasTps && (s.tpHit >= 2 || (s.dir > 0 ? bid >= tp2 : ask <= tp2));

   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0 || PositionGetInteger(POSITION_MAGIC) != InpMagic || IdOf(PositionGetString(POSITION_COMMENT)) != s.id8) continue;
      if(ended) { trade.PositionClose(t); continue; }
      if(!hit1) continue;
      double open = PositionGetDouble(POSITION_PRICE_OPEN);
      double cur  = PositionGetDouble(POSITION_SL);
      double tp   = PositionGetDouble(POSITION_TP);
      double want = NormalizeDouble(hit2 ? tp1 : open, dg);
      bool better = (cur == 0) || (s.dir > 0 ? want > cur + pt / 2 : want < cur - pt / 2);
      bool valid  = (s.dir > 0 ? want < bid : want > ask);
      if(better && valid) trade.PositionModify(t, want, tp);
     }
  }

//+------------------------------------------------------------------+
void OnTimer()
  {
   if(InpKey == "") { Comment("MEEGO AI EA: paste your EA key in the Inputs (send /ea in the bot)."); return; }
   string url = InpUrl + "?ea=" + InpKey;
   char   data[], res[];
   string hdrs;
   ResetLastError();
   int code = WebRequest("GET", url, "", 10000, data, res, hdrs);
   if(code == -1)
     {
      int e = GetLastError();
      g_status = (e == 4014) ? "Allow WebRequest: Tools > Options > Expert Advisors > add https://euoqlrwlzxzszgzqhakv.supabase.co"
                             : "connection error " + IntegerToString(e);
      Comment("MEEGO AI EA: " + g_status);
      return;
     }
   string body = CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8);
   string lines[];
   int n = StringSplit(body, '\n', lines);
   if(n < 1 || StringFind(lines[0], "OK|") != 0)
     {
      Comment("MEEGO AI EA: " + (n > 0 ? lines[0] : "no answer") + " (HTTP " + IntegerToString(code) + ")");
      return;
     }
   int open = OpenSignalCount(), seen = 0, opened = 0;
   long nowS = (long)TimeGMT();
   for(int i = 1; i < n; i++)
     {
      string line = lines[i];
      StringTrimRight(line);
      Sig s;
      if(!ParseSig(line, s) || !Wanted(s)) continue;
      seen++;
      Manage(s);
      if(s.status != "running") continue;
      if(GlobalVariableCheck(GvDone(s.id8))) continue;
      if(HasAny(s.id8)) { GlobalVariableSet(GvDone(s.id8), 1); continue; }
      bool pendingLimit = (s.order == "limit" && s.pending == 1);
      long since = (s.filled > 0 ? s.filled : s.time) / 1000;
      if(!pendingLimit && nowS - since > InpMaxAgeMin * 60) { GlobalVariableSet(GvDone(s.id8), 2); continue; } // too late to copy
      if(open >= InpMaxSignals) continue;
      if(OpenSignal(s)) { open++; opened++; }
     }
   g_status = "connected · " + IntegerToString(seen) + " signals in feed · " + IntegerToString(open) + " open · checked " + TimeToString(TimeLocal(), TIME_MINUTES | TIME_SECONDS);
   Comment("MEEGO AI EA (" + InpSymbol + ", risk " + DoubleToString(InpRiskPct, 1) + "%): " + g_status);
  }
//+------------------------------------------------------------------+
