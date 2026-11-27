//+------------------------------------------------------------------+
//|                                                  MEEGO_AI_EA.mq5 |
//|  Copies MEEGO AI signals (Telegram bot @MeegoAISignalBot) to MT5. |
//|  Get your key by sending /ea to the bot.                          |
//+------------------------------------------------------------------+
#property copyright "MEEGO AI"
#property version   "1.33"
#property description "Copies MEEGO AI gold signals into MT5: draws the zone, enters while price is in it, TP1/TP2/TP3,"
#property description "locks profit (+50 pips: SL +20, +100 pips: closes half, SL +50), removes a zone once it is no longer valid."
#property description "Tools > Options > Expert Advisors > Allow WebRequest for the MEEGO URL first."

#include <Trade\Trade.mqh>

input string InpKey           = "";        // MEEGO EA key (send /ea in the bot)
input string InpSymbol        = "XAUUSD";  // Your broker's gold symbol (found by itself if this one does not exist)
input double InpFixedLot      = 0.01;      // Lot of every layer, whatever the balance (0 = use the risk % instead)
input int    InpLayers        = 3;         // Layers per signal (1-10), TP1/TP2/TP3 in turn
input double InpLayerStepPips = 10;        // Zone signals: each next layer this many pips deeper in the zone (0 = all at once)
input double InpRiskPct       = 1.0;       // Risk per signal (% of balance), only when the fixed lot is 0
input double InpMaxLot        = 1.0;       // Max total lot per signal
input bool   InpScalping      = true;      // Copy Scalping signals
input bool   InpIntraday      = true;      // Copy Intraday signals
input bool   InpSwing         = true;      // Copy Swing signals (Ultimate plan)
input bool   InpSop           = true;      // Copy PR SOP signals (enters only when the dashboard is ready)
input bool   InpNews          = true;      // Copy News signals
input bool   InpRecovery      = true;      // Copy Recovery setups (after a news SL)
input int    InpMaxSignals    = 3;         // Max signals open at the same time
input int    InpMaxAgeMin     = 15;        // Skip market signals older than this (minutes)
input bool   InpMinLotIfSmall = false;     // Use the minimum lot when the risk lot is too small
input double InpBEPips        = 100;       // At this profit (pips): close half (0 = off)
input double InpLock1At       = 50;        // At this profit (pips) ...
input double InpLock1         = 20;        // ... move the SL to lock this profit (pips, 0 = off)
input double InpLock2At       = 100;       // At this profit (pips) ...
input double InpLock2         = 50;        // ... move the SL to lock this profit (pips, 0 = off)
input double InpZoneTolPips   = 10;        // Entry allowed this far outside the zone (pips)
input double InpMinSLPips     = 20;        // Don't enter when the SL is closer than this (pips)
input bool   InpZoneLimit     = true;      // Price outside the zone: place limit orders at the zone
input bool   InpDrawZone      = true;      // Draw the zone as a shaded box
input int    InpZoneShade     = 30;        // Box strength (10 = faint, 100 = solid)
input bool   InpMapZones      = true;      // Draw the bot's current S&D zones (M15, H1, H4)
input bool   InpMapLevels     = true;      // Draw the bot's current SNR lines (M15, H1, H4, D1): red above price, blue below
input int    InpPollSec       = 30;        // Check for signals every N seconds
input long   InpMagic         = 771905;    // Magic number
input int    InpSlippage      = 50;        // Max slippage (points)
input string InpUrl           = "https://euoqlrwlzxzszgzqhakv.supabase.co/functions/v1/telegram"; // MEEGO feed URL

CTrade trade;
bool   g_hedging = true;
string g_status  = "starting...";
string g_sym     = "";   // the gold symbol actually traded

struct Sig
  {
   string id, id8, kind, news, sym, order, status;
   int    dir, pending, tpHit;
   double entry, sl, tp1, tp2, tp3, slNow, expireH;
   long   time, filled;   // milliseconds (UTC)
   double zLo, zHi, lifeH; // zone (0 = no zone) and how many hours the trade may stay open
   int    ready;           // 0 = the bot says wait (PR SOP dashboard not lined up yet)
   string setup;           // "SNR" = breakout + retest of a level, "" = supply / demand zone
   double level;           // SNR: the broken level
   long   bt, lvFrom;      // SNR: breakout time and first touch of the level (ms UTC, 0 = unknown)
  };
Sig      g_sigs[];
struct MapZ { int tf, dir; double lo, hi; long t; };
struct MapL { int tf, n; double v; long t; };
MapZ     g_mz[];
MapL     g_ml[];
datetime g_fetched = 0;   // last time the feed was read (local clock)
ulong    g_work    = 0;
#define  PIP 0.1

//+------------------------------------------------------------------+
// The symbol from the Inputs; if the broker doesn't have it: the chart's symbol when it is XAUUSD with a suffix, else the first XAUUSD... symbol
string FindGold()
  {
   string want = InpSymbol;
   StringTrimLeft(want);
   StringTrimRight(want);
   if(want != "" && SymbolSelect(want, true))
      return(want);
   if(StringFind(_Symbol, "XAUUSD") == 0)
      return(_Symbol);
   for(int i = 0; i < SymbolsTotal(false); i++)
     {
      string n = SymbolName(i, false);
      if(StringFind(n, "XAUUSD") == 0 && SymbolInfoInteger(n, SYMBOL_TRADE_MODE) == SYMBOL_TRADE_MODE_FULL && SymbolSelect(n, true))
         return(n);
     }
   return("");
  }
//+------------------------------------------------------------------+
int OnInit()
  {
   if(InpKey == "")
      Alert("MEEGO AI EA: paste your EA key in the Inputs (send /ea in the bot to get it).");
   g_sym = FindGold();
   if(g_sym == "")
     {
      Alert("MEEGO AI EA: symbol '" + InpSymbol + "' not found. Set your broker's gold symbol in the Inputs.");
      return(INIT_PARAMETERS_INCORRECT);
     }
   if(g_sym != InpSymbol)
      Print("MEEGO AI EA: using gold symbol " + g_sym);
   g_hedging = (AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING);
   if(!g_hedging)
      Print("MEEGO AI EA: netting account - each signal opens ONE position (TP2) instead of three.");
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpSlippage);
   trade.SetTypeFillingBySymbol(g_sym);
   ObjectsDeleteAll(0, "MEEGO_ZT_");   // zone lines of older versions
   ObjectsDeleteAll(0, "MEEGO_ZB_");
   EventSetTimer(MathMax(10, InpPollSec));
   OnTimer();
   return(INIT_SUCCEEDED);
  }
void OnDeinit(const int reason) { EventKillTimer(); Comment(""); ObjectsDeleteAll(0, "MEEGO_Z"); ObjectsDeleteAll(0, "MEEGO_M_"); }
void OnTick()
  {
   if(g_sym == "" || GetTickCount64() - g_work < 1000) return;   // at most once a second
   Work();
  }

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
   int nf    = ArraySize(f);
   s.zLo     = nf > 20 ? StringToDouble(f[19]) : 0;
   s.zHi     = nf > 20 ? StringToDouble(f[20]) : 0;
   s.lifeH   = nf > 21 ? StringToDouble(f[21]) : 0;
   s.ready   = nf > 22 ? (int)StringToInteger(f[22]) : 1;
   s.setup   = nf > 23 ? f[23] : "";
   s.level   = nf > 24 ? StringToDouble(f[24]) : 0;
   s.bt      = nf > 25 ? StringToInteger(f[25]) : 0;
   s.lvFrom  = nf > 26 ? StringToInteger(f[26]) : 0;
   if(s.zHi < s.zLo) { double z = s.zLo; s.zLo = s.zHi; s.zHi = z; }
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
   if(s.kind == "SOP")         return(InpSop);
   return(false);
  }

string Tag(string id8, int part) { return("MEEGO|" + id8 + "|" + IntegerToString(part)); }
string IdOf(string comment)       { return(StringFind(comment, "MEEGO|") == 0 ? StringSubstr(comment, 6, 8) : ""); }
string GvDone(string id8)         { return("MEEGO_" + id8); }
string GvBE(string id8)           { return("MEEGO_B_" + id8); }   // 1 = half closed
string GvEnd(string id8)          { return("MEEGO_E_" + id8); }   // server time when the trade must be closed
string GvLay(string id8, string w) { return("MEEGO_" + w + "_" + id8); }   // instant zone ladder: N layers done, P last price, M layers wanted, Q lot
string GvBroken(string id8)       { return("MEEGO_X_" + id8); }   // server time when the zone stopped being valid
bool   HasZone(Sig &s)            { return(s.zLo > 0 && s.zHi > s.zLo); }

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
   double tv = SymbolInfoDouble(g_sym, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tv <= 0) tv = SymbolInfoDouble(g_sym, SYMBOL_TRADE_TICK_VALUE);
   double ts = SymbolInfoDouble(g_sym, SYMBOL_TRADE_TICK_SIZE);
   if(tv <= 0 || ts <= 0 || dist <= 0) return(0);
   double risk = AccountInfoDouble(ACCOUNT_BALANCE) * InpRiskPct / 100.0;
   return(MathMin(risk / (dist / ts * tv), InpMaxLot));
  }
double NormLot(double v)
  {
   double st = SymbolInfoDouble(g_sym, SYMBOL_VOLUME_STEP);
   if(st <= 0) st = 0.01;
   return(NormalizeDouble(MathFloor(v / st + 1e-9) * st, 2));
  }

//+------------------------------------------------------------------+
// Open a new signal in layers: at market, as limit orders of a limit signal, or (zoneLimit > 0) as limit orders at the zone
bool OpenSignal(Sig &s, double zoneLimit = 0)
  {
   int    dg  = (int)SymbolInfoInteger(g_sym, SYMBOL_DIGITS);
   double ask = SymbolInfoDouble(g_sym, SYMBOL_ASK), bid = SymbolInfoDouble(g_sym, SYMBOL_BID);
   if(ask <= 0 || bid <= 0) return(false);
   bool limit = (zoneLimit > 0 || (s.order == "limit" && s.pending == 1));
   double lp = zoneLimit > 0 ? zoneLimit : s.entry;
   if(limit && ((s.dir > 0 && ask <= lp) || (s.dir < 0 && bid >= lp))) limit = false; // already at a better price
   double mkt = (s.dir > 0 ? ask : bid);
   // market signals without a zone keep the same distances from your broker's price; zones and limit orders use the signal's prices
   double delta = (limit || s.order == "limit" || HasZone(s)) ? 0.0 : mkt - s.entry;
   double sl = NormalizeDouble(s.sl + delta, dg);
   double ref = limit ? lp : mkt;
   if((ref - sl) * s.dir <= 0) { Print("MEEGO AI EA: skip ", s.id8, " - price already past the SL"); return(false); }
   if(MathAbs(ref - sl) < InpMinSLPips * PIP) return(false);     // too close to the SL for now

   bool three = (s.tp2 > 0 && s.tp3 > 0);
   int  layers = g_hedging ? (int)MathMax(1, MathMin(10, InpLayers)) : 1;
   double minL = SymbolInfoDouble(g_sym, SYMBOL_VOLUME_MIN), part;
   if(InpFixedLot > 0)
      part = MathMax(minL, NormLot(MathMin(InpFixedLot, InpMaxLot / layers)));
   else
     {
      double total = RiskLot(MathAbs(ref - sl));
      layers = (int)MathMax(1, MathMin(layers, MathFloor(total / minL + 1e-9)));   // fewer layers when the risk lot is small
      part = NormLot(total / layers);
      if(part < minL)
        {
         if(!InpMinLotIfSmall)
           {
            Print("MEEGO AI EA: skip ", s.id8, " - balance too small for ", DoubleToString(InpRiskPct, 2), "% risk (needs ", DoubleToString(minL, 2), " lot)");
            GlobalVariableSet(GvDone(s.id8), 3);
            return(false);
           }
         part = minL;
        }
     }
   double lots[10], tps[10];
   int parts = layers;
   for(int i = 0; i < parts; i++)
     {
      lots[i] = part;
      int k = (parts == 1) ? 1 : i % 3;                          // one layer: TP2
      tps[i] = !three ? s.tp1 : (k == 0 ? s.tp1 : k == 1 ? s.tp2 : s.tp3);
     }

   // zone signals with limit orders: one limit order every InpLayerStepPips, deeper in the zone.
   // instant zone signals: one layer now at the market, the next ones at market each time the price goes InpLayerStepPips deeper (AddLayers)
   bool   spread = HasZone(s) && InpLayerStepPips > 0 && parts > 1 && limit;
   bool   ladder = HasZone(s) && InpLayerStepPips > 0 && parts > 1 && !limit;
   double far = s.dir > 0 ? MathMin(s.zLo, s.entry) : MathMax(s.zHi, s.entry);
   int ok = 0;
   for(int i = 0; i < (ladder ? 1 : parts); i++)
     {
      bool   lim = limit;
      double at = ref;
      if(spread && i > 0)
        {
         at = ref - s.dir * i * InpLayerStepPips * PIP;
         if((at - far) * s.dir < 0) at = far;                      // not past the far edge of the zone
         if(MathAbs(at - sl) < InpMinSLPips * PIP) continue;      // too close to the SL
         lim = MathAbs(at - ref) >= 1 * PIP || limit;            // at the price already: like the first layer
        }
      double tp = NormalizeDouble(tps[i] + delta, dg);
      if((tp - at) * s.dir <= 0) continue; // this TP is already behind the price
      string c = Tag(s.id8, i + 1);
      bool r;
      if(lim)
        {
         double price = NormalizeDouble(at, dg);
         r = (s.dir > 0) ? trade.BuyLimit(lots[i], price, g_sym, sl, tp, ORDER_TIME_GTC, 0, c)
                         : trade.SellLimit(lots[i], price, g_sym, sl, tp, ORDER_TIME_GTC, 0, c);
        }
      else
         r = (s.dir > 0) ? trade.Buy(lots[i], g_sym, 0, sl, tp, c)
                         : trade.Sell(lots[i], g_sym, 0, sl, tp, c);
      if(r && (trade.ResultRetcode() == TRADE_RETCODE_DONE || trade.ResultRetcode() == TRADE_RETCODE_PLACED || trade.ResultRetcode() == TRADE_RETCODE_DONE_PARTIAL)) ok++;
      else Print("MEEGO AI EA: order failed for ", s.id8, " part ", i + 1, ": ", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription());
     }
   if(ok > 0)
     {
      GlobalVariableSet(GvDone(s.id8), 1);
      if(s.lifeH > 0) GlobalVariableSet(GvEnd(s.id8), (double)TimeCurrent() + s.lifeH * 3600.0);
      if(ladder)
        {
         GlobalVariableSet(GvLay(s.id8, "N"), 1);
         GlobalVariableSet(GvLay(s.id8, "P"), mkt);
         GlobalVariableSet(GvLay(s.id8, "M"), parts);
         GlobalVariableSet(GvLay(s.id8, "Q"), part);
        }
      Print("MEEGO AI EA: opened ", s.kind, " ", (s.dir > 0 ? "BUY" : "SELL"), (limit ? " LIMIT " : " "), s.id8, " parts ", ok);
     }
   return(ok > 0);
  }

//+------------------------------------------------------------------+
// Follow the signal: remove pending orders when it ends; close positions only when it was closed by the time limit.
// SL, TP and breakeven are handled here in MT5 (see ManageBE), not by the bot.
void Manage(Sig &s)
  {
   bool ended   = (s.status != "running");
   double age   = (double)TimeGMT() - s.time / 1000.0;
   bool expired = (s.pending == 1 && age > s.expireH * 3600.0) || (s.lifeH > 0 && s.pending != 1 && age > s.lifeH * 3600.0);
   if(HasZone(s) && s.tpHit > 0) expired = true;                 // TP1 reached without us: the zone orders are too late
   if(HasZone(s) && (s.status == "running" || HasAny(s.id8)) && ZoneBroken(s) > 0) expired = true;   // the zone is broken: no limit orders left in it
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong t = OrderGetTicket(i);
      if(t == 0 || OrderGetInteger(ORDER_MAGIC) != InpMagic || IdOf(OrderGetString(ORDER_COMMENT)) != s.id8) continue;
      if(ended || expired) trade.OrderDelete(t);
     }
   if(s.status != "closed" && s.status != "cancelled") return;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t != 0 && PositionGetInteger(POSITION_MAGIC) == InpMagic && IdOf(PositionGetString(POSITION_COMMENT)) == s.id8) trade.PositionClose(t);
     }
  }

// Positions of one signal, the nearest TP first
int Tickets(string id8, ulong &tk[])
  {
   double d[];
   ArrayResize(tk, 0);
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0 || PositionGetInteger(POSITION_MAGIC) != InpMagic || IdOf(PositionGetString(POSITION_COMMENT)) != id8) continue;
      double dist = MathAbs(PositionGetDouble(POSITION_TP) - PositionGetDouble(POSITION_PRICE_OPEN));
      int n = ArraySize(tk), k = n;
      ArrayResize(tk, n + 1);
      ArrayResize(d, n + 1);
      while(k > 0 && d[k - 1] > dist) { tk[k] = tk[k - 1]; d[k] = d[k - 1]; k--; }
      tk[k] = t;
      d[k] = dist;
     }
   return(ArraySize(tk));
  }

// Half of what is open: half of every position when the lots allow it, otherwise whole positions with the nearest TP
void CloseHalf(ulong &tk[])
  {
   double minL = SymbolInfoDouble(g_sym, SYMBOL_VOLUME_MIN), total = 0;
   bool   each = true;
   int    n = ArraySize(tk);
   for(int i = 0; i < n; i++)
      if(PositionSelectByTicket(tk[i]))
        {
         double v = PositionGetDouble(POSITION_VOLUME), h = NormLot(v / 2.0);
         total += v;
         if(h < minL || v - h < minL - 1e-9) each = false;
        }
   if(each)
     {
      for(int i = 0; i < n; i++)
         if(PositionSelectByTicket(tk[i])) trade.PositionClosePartial(tk[i], NormLot(PositionGetDouble(POSITION_VOLUME) / 2.0));
      return;
     }
   double left = total / 2.0 + 1e-9;
   for(int i = 0; i < n - 1; i++)                 // always keep the last one
      if(PositionSelectByTicket(tk[i]))
        {
         double v = PositionGetDouble(POSITION_VOLUME);
         if(v > left) break;
         if(trade.PositionClose(tk[i])) left -= v;
        }
  }

// At +InpBEPips: close half. At +InpLock1At / +InpLock2At: SL moves into profit by InpLock1 / InpLock2 pips (never back).
// Also closes trades whose time is up.
void ManageBE()
  {
   int    dg = (int)SymbolInfoInteger(g_sym, SYMBOL_DIGITS);
   double pt = SymbolInfoDouble(g_sym, SYMBOL_POINT);
   double gap = MathMax(5 * PIP, (SymbolInfoInteger(g_sym, SYMBOL_TRADE_STOPS_LEVEL) + 5) * pt);   // the SL must stay this far from the price
   bool   canTrade = TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED);
   string seen = "";
   string ids[];
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0 || PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      string id = IdOf(PositionGetString(POSITION_COMMENT));
      if(id == "" || StringFind(seen, id) >= 0) continue;
      seen += id + ",";
      int n = ArraySize(ids);
      ArrayResize(ids, n + 1);
      ids[n] = id;
     }
   for(int k = 0; k < ArraySize(ids); k++)
     {
      ulong tk[];
      int n = Tickets(ids[k], tk);
      if(n == 0) continue;
      if(GlobalVariableCheck(GvEnd(ids[k])) && (double)TimeCurrent() >= GlobalVariableGet(GvEnd(ids[k])))
        {
         for(int i = 0; i < n; i++) trade.PositionClose(tk[i]);
         Print("MEEGO AI EA: time limit, closed ", ids[k]);
         continue;
        }
      if(!canTrade || !PositionSelectByTicket(tk[0])) continue;
      double bid = SymbolInfoDouble(g_sym, SYMBOL_BID), ask = SymbolInfoDouble(g_sym, SYMBOL_ASK);
      bool   buy = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      double gain = (buy ? bid - PositionGetDouble(POSITION_PRICE_OPEN) : PositionGetDouble(POSITION_PRICE_OPEN) - ask) / PIP;
      if(InpBEPips > 0 && gain >= InpBEPips && !GlobalVariableCheck(GvBE(ids[k])))
        {
         GlobalVariableSet(GvBE(ids[k]), 1);      // set first, so half is never closed twice
         CloseHalf(tk);
         Print("MEEGO AI EA: +", DoubleToString(gain, 0), " pips, closed half of ", ids[k]);
         n = Tickets(ids[k], tk);
        }
      double lock = -1;
      if(InpLock2 > 0 && gain >= InpLock2At)      lock = InpLock2;
      else if(InpLock1 > 0 && gain >= InpLock1At) lock = InpLock1;
      if(lock < 0) continue;
      for(int i = 0; i < n; i++)
        {
         if(!PositionSelectByTicket(tk[i])) continue;
         double open = PositionGetDouble(POSITION_PRICE_OPEN), cur = PositionGetDouble(POSITION_SL), tp = PositionGetDouble(POSITION_TP);
         double sl = NormalizeDouble(open + (buy ? lock : -lock) * PIP, dg);
         if(cur != 0 && (buy ? cur >= sl - pt / 2 : cur <= sl + pt / 2)) continue;   // already there or better
         if(buy ? sl > bid - gap : sl < ask + gap) continue;                       // too close to the price for now
         if(trade.PositionModify(tk[i], sl, tp))
            Print("MEEGO AI EA: +", DoubleToString(gain, 0), " pips, SL of ", ids[k], " to ", DoubleToString(sl, dg), " (locks +", DoubleToString(lock, 0), " pips)");
        }
     }
  }

//+------------------------------------------------------------------+
// a and b mixed: k = 0 gives b, 1 gives a (looks see-through when b is the chart background)
color Mix(color a, color b, double k)
  {
   int r = (int)MathRound((a & 0xFF) * k + (b & 0xFF) * (1 - k)), g = (int)MathRound(((a >> 8) & 0xFF) * k + ((b >> 8) & 0xFF) * (1 - k)),
       bl = (int)MathRound(((a >> 16) & 0xFF) * k + ((b >> 16) & 0xFF) * (1 - k));
   return((color)(r | (g << 8) | (bl << 16)));
  }
// Filled box behind the candles, from the signal to a little past the last candle
void DrawBox(string name, datetime t1, double lo, double hi, color c, string text)
  {
   datetime t2 = TimeCurrent() + 15 * PeriodSeconds();
   if(ObjectFind(0, name) < 0)
     {
      ObjectCreate(0, name, OBJ_RECTANGLE, 0, t1, hi, t2, lo);
      ObjectSetInteger(0, name, OBJPROP_FILL, true);
      ObjectSetInteger(0, name, OBJPROP_BACK, true);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
     }
   double k = MathMax(10, MathMin(100, InpZoneShade)) / 100.0;
   ObjectSetInteger(0, name, OBJPROP_COLOR, Mix(c, (color)ChartGetInteger(0, CHART_COLOR_BACKGROUND), k));
   ObjectSetString(0, name, OBJPROP_TEXT, text);
   ObjectSetString(0, name, OBJPROP_TOOLTIP, text);
   ObjectMove(0, name, 0, t1, hi);
   ObjectMove(0, name, 1, t2, lo);
  }
// Horizontal line from the signal to the right edge
void DrawRay(string name, datetime t1, double price, color c, int width, ENUM_LINE_STYLE style, string text, datetime t2 = 0)
  {
   bool ray = (t2 == 0);
   if(ray) t2 = t1 + 60;
   if(ObjectFind(0, name) < 0)
     {
      ObjectCreate(0, name, OBJ_TREND, 0, t1, price, t2, price);
      ObjectSetInteger(0, name, OBJPROP_RAY_RIGHT, ray);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
     }
   ObjectSetInteger(0, name, OBJPROP_COLOR, c);
   ObjectSetInteger(0, name, OBJPROP_WIDTH, width);
   ObjectSetInteger(0, name, OBJPROP_STYLE, style);
   ObjectSetString(0, name, OBJPROP_TEXT, text);
   ObjectSetString(0, name, OBJPROP_TOOLTIP, text);
   ObjectMove(0, name, 0, t1, price);
   ObjectMove(0, name, 1, t2, price);
  }
// Text on the chart, above (support) or below (resistance) the line, at the signal
void DrawLabel(string name, datetime t, double price, color c, string text, bool above)
  {
   if(ObjectFind(0, name) < 0)
     {
      ObjectCreate(0, name, OBJ_TEXT, 0, t, price);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
      ObjectSetInteger(0, name, OBJPROP_FONTSIZE, 9);
      ObjectSetString(0, name, OBJPROP_FONT, "Arial Bold");
     }
   ObjectSetInteger(0, name, OBJPROP_ANCHOR, above ? ANCHOR_LEFT_LOWER : ANCHOR_LEFT_UPPER);
   ObjectSetInteger(0, name, OBJPROP_COLOR, c);
   ObjectSetString(0, name, OBJPROP_TEXT, text);
   ObjectMove(0, name, 0, t, price);
  }
// The zone box (SNR: the level line, blue = support, red = resistance) and the entry line stay while the zone is valid and the signal is running or its trade is open
void DrawZones()
  {
   string keep = "";
   if(InpDrawZone && _Symbol == g_sym)
      for(int i = 0; i < ArraySize(g_sigs); i++)
        {
         if(!HasZone(g_sigs[i]) || !Wanted(g_sigs[i]) || (g_sigs[i].status != "running" && !HasAny(g_sigs[i].id8)) || !ZoneValid(g_sigs[i])) continue;
         color  c = g_sigs[i].dir > 0 ? clrMediumSeaGreen : clrTomato;
         string t = "MEEGO " + g_sigs[i].kind + (g_sigs[i].dir > 0 ? " demand" : " supply") + " zone " + DoubleToString(g_sigs[i].zLo, 2) + " - " + DoubleToString(g_sigs[i].zHi, 2);
         long   off = (long)MathRound(((double)TimeTradeServer() - (double)TimeGMT()) / 1800.0) * 1800;   // server clock - UTC
         datetime t1 = (datetime)(g_sigs[i].time / 1000 + off);
         if(g_sigs[i].setup == "SNR" && g_sigs[i].level > 0)
           {
            bool sup = g_sigs[i].dir > 0;   // a broken resistance is support now (BUY), a broken support is resistance (SELL)
            string nm = (sup ? "RBS " : "SBR ") + DoubleToString(g_sigs[i].level, 2);   // resistance became support / support became resistance
            // old role (resistance for RBS) from the first touch to the breakout, new role from the breakout on
            datetime tb = g_sigs[i].bt > 0 ? (datetime)(g_sigs[i].bt / 1000 + off) : t1;
            if(g_sigs[i].bt > 0 && g_sigs[i].lvFrom > 0 && g_sigs[i].lvFrom < g_sigs[i].bt)
              {
               DrawRay("MEEGO_ZO_" + g_sigs[i].id8, (datetime)(g_sigs[i].lvFrom / 1000 + off), g_sigs[i].level, sup ? clrRed : clrDodgerBlue, 3, STYLE_SOLID,
                       "MEEGO SNR " + (sup ? "resistance " : "support ") + DoubleToString(g_sigs[i].level, 2) + " before the breakout", tb);
               DrawLabel("MEEGO_ZP_" + g_sigs[i].id8, (datetime)(g_sigs[i].lvFrom / 1000 + off), g_sigs[i].level, sup ? clrRed : clrDodgerBlue, sup ? "RESISTANCE" : "SUPPORT", !sup);
              }
            DrawRay("MEEGO_ZL_" + g_sigs[i].id8, tb, g_sigs[i].level, sup ? clrDodgerBlue : clrRed, 3, STYLE_SOLID,
                    "MEEGO SNR " + g_sigs[i].kind + " " + nm + (sup ? " (resistance broken, back to retest it)" : " (support broken, back to retest it)"));
            DrawLabel("MEEGO_ZN_" + g_sigs[i].id8, tb, g_sigs[i].level, sup ? clrDodgerBlue : clrRed, nm + (sup ? " SUPPORT" : " RESISTANCE"), sup);
           }
         else
            DrawBox("MEEGO_ZR_" + g_sigs[i].id8, t1, g_sigs[i].zLo, g_sigs[i].zHi, c, t);
         DrawRay("MEEGO_ZE_" + g_sigs[i].id8, t1, g_sigs[i].entry, clrWhite, 1, STYLE_DOT, "MEEGO " + g_sigs[i].kind + " entry " + DoubleToString(g_sigs[i].entry, 2));
         keep += g_sigs[i].id8 + ",";
        }
   for(int i = ObjectsTotal(0) - 1; i >= 0; i--)
     {
      string nm = ObjectName(0, i);
      if(StringFind(nm, "MEEGO_Z") == 0 && StringFind(keep, StringSubstr(nm, 9)) < 0) ObjectDelete(0, nm);
     }
   ChartRedraw();
  }

string TfName(int m) { return(m >= 1440 ? "D1" : m >= 60 ? "H" + IntegerToString(m / 60) : "M" + IntegerToString(m)); }
// The bot's zone map: S&D zones as faint boxes, SNR levels as dotted lines (red above price = resistance, blue below = support)
void DrawMap()
  {
   ObjectsDeleteAll(0, "MEEGO_M_");
   if(_Symbol != g_sym) return;
   long   off = (long)MathRound(((double)TimeTradeServer() - (double)TimeGMT()) / 1800.0) * 1800;
   double bid = SymbolInfoDouble(g_sym, SYMBOL_BID);
   color  bg  = (color)ChartGetInteger(0, CHART_COLOR_BACKGROUND);
   double k   = MathMax(10, MathMin(100, InpZoneShade)) / 100.0 * 0.6;
   if(InpMapZones)
      for(int i = 0; i < ArraySize(g_mz); i++)
        {
         string nm = "MEEGO_M_Z" + IntegerToString(i), t = "S&D " + TfName(g_mz[i].tf) + (g_mz[i].dir > 0 ? " demand " : " supply ") + DoubleToString(g_mz[i].lo, 2) + " - " + DoubleToString(g_mz[i].hi, 2);
         datetime t1 = (datetime)(g_mz[i].t / 1000 + off), t2 = TimeCurrent() + 15 * PeriodSeconds();
         ObjectCreate(0, nm, OBJ_RECTANGLE, 0, t1, g_mz[i].hi, t2, g_mz[i].lo);
         ObjectSetInteger(0, nm, OBJPROP_FILL, true);
         ObjectSetInteger(0, nm, OBJPROP_BACK, true);
         ObjectSetInteger(0, nm, OBJPROP_SELECTABLE, false);
         ObjectSetInteger(0, nm, OBJPROP_HIDDEN, true);
         ObjectSetInteger(0, nm, OBJPROP_COLOR, Mix(g_mz[i].dir > 0 ? clrMediumSeaGreen : clrTomato, bg, k));
         ObjectSetString(0, nm, OBJPROP_TOOLTIP, t);
         DrawLabel("MEEGO_M_T" + IntegerToString(i), t1, g_mz[i].dir > 0 ? g_mz[i].lo : g_mz[i].hi, g_mz[i].dir > 0 ? clrMediumSeaGreen : clrTomato, TfName(g_mz[i].tf) + (g_mz[i].dir > 0 ? " DEMAND" : " SUPPLY"), g_mz[i].dir < 0);
        }
   if(InpMapLevels)
      for(int i = 0; i < ArraySize(g_ml); i++)
        {
         bool   res = (bid > 0 && g_ml[i].v > bid);
         color  c = res ? clrRed : clrDodgerBlue;
         string nm = "MEEGO_M_L" + IntegerToString(i), t = "SNR " + TfName(g_ml[i].tf) + (res ? " resistance " : " support ") + DoubleToString(g_ml[i].v, 2) + " (" + IntegerToString(g_ml[i].n) + "x)";
         // a full-width horizontal line: its price shows on the price scale, the hover text says what it is
         ObjectCreate(0, nm, OBJ_HLINE, 0, 0, g_ml[i].v);
         ObjectSetInteger(0, nm, OBJPROP_COLOR, c);
         ObjectSetInteger(0, nm, OBJPROP_STYLE, STYLE_DASH);
         ObjectSetInteger(0, nm, OBJPROP_WIDTH, g_ml[i].tf >= 60 ? 2 : 1);
         ObjectSetInteger(0, nm, OBJPROP_BACK, true);
         ObjectSetInteger(0, nm, OBJPROP_SELECTABLE, false);
         ObjectSetInteger(0, nm, OBJPROP_HIDDEN, true);
         ObjectSetString(0, nm, OBJPROP_TEXT, TfName(g_ml[i].tf) + (res ? " R" : " S"));
         ObjectSetString(0, nm, OBJPROP_TOOLTIP, t);
        }
   ChartRedraw();
  }

// May a zone signal be entered now? 1 = yes, 0 = wait, -1 = never (the move is over)
int ZoneState(Sig &s)
  {
   double ask = SymbolInfoDouble(g_sym, SYMBOL_ASK), bid = SymbolInfoDouble(g_sym, SYMBOL_BID);
   double p = s.dir > 0 ? ask : bid, tol = InpZoneTolPips * PIP;
   if(p <= 0) return(0);
   if(s.tpHit > 0 || (s.sl - p) * s.dir >= 0 || (p - s.tp1) * s.dir >= 0) return(-1);          // TP1 or SL already reached
   if(s.lifeH > 0 && (double)TimeGMT() - s.time / 1000.0 > s.lifeH * 3600.0) return(-1);
   // the zone, stretched to the signal's entry when the bot entered just outside it
   double lo = MathMin(s.zLo, s.entry) - tol, hi = MathMax(s.zHi, s.entry) + tol;
   return(p >= lo && p <= hi ? 1 : 0);
  }

// When the zone stopped being valid (server time, 0 = still valid): a finished candle closed beyond its far edge after the signal.
// Candles: M5 for Scalping, H1 for Swing, M15 for the rest.
datetime ZoneBroken(Sig &s)
  {
   if(!HasZone(s)) return(0);
   if(GlobalVariableCheck(GvBroken(s.id8))) return((datetime)GlobalVariableGet(GvBroken(s.id8)));
   ENUM_TIMEFRAMES tf = s.kind == "Scalping" ? PERIOD_M5 : s.kind == "Swing" ? PERIOD_H1 : PERIOD_M15;
   long off = (long)MathRound(((double)TimeTradeServer() - (double)TimeGMT()) / 1800.0) * 1800;   // server clock - UTC
   datetime from = (datetime)(s.time / 1000 + off), now = TimeTradeServer();
   double far = s.dir > 0 ? MathMin(s.zLo, s.entry) : MathMax(s.zHi, s.entry);   // the zone, stretched to the entry when the bot entered just outside it
   MqlRates r[];
   int n = CopyRates(g_sym, tf, from, now, r), sec = PeriodSeconds(tf);
   for(int i = 0; i < n; i++)
     {
      if(r[i].time < from || r[i].time + sec > now) continue;          // before the signal, or not finished yet
      if((r[i].close - far) * s.dir < 0)
        {
         datetime at = r[i].time + sec;
         GlobalVariableSet(GvBroken(s.id8), (double)at);
         Print("MEEGO AI EA: ", s.kind, " ", (s.dir > 0 ? "demand" : "supply"), " zone ", DoubleToString(s.zLo, 2), "-", DoubleToString(s.zHi, 2), " of ", s.id8,
               " is no longer valid since ", TimeToString(at, TIME_DATE | TIME_MINUTES), " (", EnumToString(tf), " closed ", (s.dir > 0 ? "below" : "above"), " it): box removed, no new entry");
         return(at);
        }
     }
   return(0);
  }
// Zone still worth showing: not broken, TP1 not reached, SL not reached, time not up
bool ZoneValid(Sig &s)
  {
   if(ZoneBroken(s) > 0 || s.tpHit > 0) return(false);
   if(s.lifeH > 0 && (double)TimeGMT() - s.time / 1000.0 > s.lifeH * 3600.0) return(false);
   double p = s.dir > 0 ? SymbolInfoDouble(g_sym, SYMBOL_BID) : SymbolInfoDouble(g_sym, SYMBOL_ASK);
   return(p <= 0 || (p - s.sl) * s.dir > 0);
  }

// Instant zone signals: one more layer at market each time the price is InpLayerStepPips deeper than the last layer, while still in the zone
void AddLayers()
  {
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)) return;
   int dg = (int)SymbolInfoInteger(g_sym, SYMBOL_DIGITS);
   for(int i = 0; i < ArraySize(g_sigs); i++)
     {
      Sig s = g_sigs[i];
      if(s.status != "running" || !GlobalVariableCheck(GvLay(s.id8, "N"))) continue;
      int n = (int)GlobalVariableGet(GvLay(s.id8, "N")), m = (int)GlobalVariableGet(GvLay(s.id8, "M"));
      if(n >= m || !ZoneValid(s)) continue;
      ulong tk[];
      if(Tickets(s.id8, tk) == 0) continue;                                   // nothing open any more
      double p = s.dir > 0 ? SymbolInfoDouble(g_sym, SYMBOL_ASK) : SymbolInfoDouble(g_sym, SYMBOL_BID);
      double last = GlobalVariableGet(GvLay(s.id8, "P")), far = s.dir > 0 ? MathMin(s.zLo, s.entry) : MathMax(s.zHi, s.entry);
      if(p <= 0 || (last - p) * s.dir < InpLayerStepPips * PIP) continue;      // not deep enough yet
      if((p - far) * s.dir < 0) continue;                                     // out of the zone
      if((p - s.sl) * s.dir < InpMinSLPips * PIP) continue;                   // too close to the SL
      int k = n % 3;
      double tp = (s.tp2 > 0 && s.tp3 > 0) ? (k == 0 ? s.tp1 : k == 1 ? s.tp2 : s.tp3) : s.tp1;
      if((tp - p) * s.dir <= 0) continue;
      double lot = GlobalVariableGet(GvLay(s.id8, "Q")), sl = NormalizeDouble(s.sl, dg);
      string c = Tag(s.id8, n + 1);
      bool r = s.dir > 0 ? trade.Buy(lot, g_sym, 0, sl, NormalizeDouble(tp, dg), c) : trade.Sell(lot, g_sym, 0, sl, NormalizeDouble(tp, dg), c);
      if(r && (trade.ResultRetcode() == TRADE_RETCODE_DONE || trade.ResultRetcode() == TRADE_RETCODE_DONE_PARTIAL))
        {
         GlobalVariableSet(GvLay(s.id8, "N"), n + 1);
         GlobalVariableSet(GvLay(s.id8, "P"), p);
         Print("MEEGO AI EA: layer ", n + 1, " of ", m, " for ", s.id8, " at ", DoubleToString(p, dg), " (", DoubleToString(InpLayerStepPips, 0), " pips deeper)");
        }
      else
        {
         GlobalVariableSet(GvLay(s.id8, "N"), m);                             // stop trying for this signal
         Print("MEEGO AI EA: layer ", n + 1, " failed for ", s.id8, ": ", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription());
        }
     }
  }

// Algo trading on, and no failed order in the last 20 seconds
bool TradeOk(Sig &s)
  {
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)) return(false);
   return(!GlobalVariableCheck("MEEGO_T_" + s.id8) || TimeLocal() - (datetime)GlobalVariableGet("MEEGO_T_" + s.id8) >= 20);
  }
// Entries and trade management, every second
void Work()
  {
   g_work = GetTickCount64();
   ManageBE();
   if(TimeLocal() - g_fetched > 120) return;      // no fresh signals: manage only
   AddLayers();
   int open = OpenSignalCount();
   for(int i = 0; i < ArraySize(g_sigs); i++)
     {
      Sig s = g_sigs[i];
      if(s.status != "running" || GlobalVariableCheck(GvDone(s.id8))) continue;
      if(HasAny(s.id8)) { GlobalVariableSet(GvDone(s.id8), 1); continue; }
      if(s.ready == 0) continue;                       // PR SOP: wait until the bot says the dashboard is ready
      bool pendingLimit = (s.order == "limit" && s.pending == 1);
      if(HasZone(s) && !pendingLimit)
        {
         int z = ZoneBroken(s) > 0 ? -1 : ZoneState(s);
         if(z < 0) { GlobalVariableSet(GvDone(s.id8), 2); continue; }
         if(z == 0)
           {
            // price has left the zone in the trade's direction: wait for it with limit orders at the edge of the zone
            double mk = s.dir > 0 ? SymbolInfoDouble(g_sym, SYMBOL_ASK) : SymbolInfoDouble(g_sym, SYMBOL_BID), edge = s.dir > 0 ? s.zHi : s.zLo;
            if(!InpZoneLimit || pendingLimit || (mk - edge) * s.dir <= 0 || open >= InpMaxSignals || !TradeOk(s)) continue;
            if(OpenSignal(s, edge)) { open++; Print("MEEGO AI EA: limit orders at the zone edge ", DoubleToString(edge, 2), " for ", s.id8); }
            else GlobalVariableSet("MEEGO_T_" + s.id8, (double)TimeLocal());
            continue;
           }
        }
      else
        {
         long since = (s.filled > 0 ? s.filled : s.time) / 1000;
         if(!pendingLimit && (long)TimeGMT() - since > InpMaxAgeMin * 60) { GlobalVariableSet(GvDone(s.id8), 2); continue; } // too late to copy
        }
      if(open >= InpMaxSignals || !TradeOk(s)) continue;
      if(OpenSignal(s)) open++;
      else GlobalVariableSet("MEEGO_T_" + s.id8, (double)TimeLocal());
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
      Work();
      return;
     }
   string body = CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8);
   string lines[];
   int n = StringSplit(body, '\n', lines);
   if(n < 1 || StringFind(lines[0], "OK|") != 0)
     {
      Comment("MEEGO AI EA: " + (n > 0 ? lines[0] : "no answer") + " (HTTP " + IntegerToString(code) + ")");
      Work();
      return;
     }
   ArrayResize(g_sigs, 0);
   ArrayResize(g_mz, 0);
   ArrayResize(g_ml, 0);
   for(int i = 1; i < n; i++)
     {
      string line = lines[i];
      StringTrimRight(line);
      if(StringFind(line, "Z|") == 0 || StringFind(line, "L|") == 0)
        {
         string f[];
         int    nf = StringSplit(line, '|', f);
         if(f[0] == "Z" && nf >= 6)
           {
            int k = ArraySize(g_mz); ArrayResize(g_mz, k + 1);
            g_mz[k].tf = (int)StringToInteger(f[1]); g_mz[k].dir = (int)StringToInteger(f[2]);
            g_mz[k].lo = StringToDouble(f[3]); g_mz[k].hi = StringToDouble(f[4]); g_mz[k].t = StringToInteger(f[5]);
           }
         if(f[0] == "L" && nf >= 5)
           {
            int k = ArraySize(g_ml); ArrayResize(g_ml, k + 1);
            g_ml[k].tf = (int)StringToInteger(f[1]); g_ml[k].v = StringToDouble(f[2]); g_ml[k].n = (int)StringToInteger(f[3]); g_ml[k].t = StringToInteger(f[4]);
           }
         continue;
        }
      Sig s;
      if(!ParseSig(line, s) || !Wanted(s)) continue;
      int k = ArraySize(g_sigs);
      ArrayResize(g_sigs, k + 1);
      g_sigs[k] = s;
      Manage(s);
     }
   g_fetched = TimeLocal();
   Work();
   DrawZones();
   DrawMap();
   int waiting = 0;
   int sopWait = 0;
   for(int i = 0; i < ArraySize(g_sigs); i++)
      if(g_sigs[i].status == "running" && !GlobalVariableCheck(GvDone(g_sigs[i].id8))) { waiting++; if(g_sigs[i].ready == 0) sopWait++; }
   g_status = "connected - " + IntegerToString(ArraySize(g_sigs)) + " signals in feed - " + IntegerToString(waiting) + " waiting for entry" + (sopWait > 0 ? " (" + IntegerToString(sopWait) + " PR SOP: dashboard not ready)" : "") + " - " + IntegerToString(OpenSignalCount()) + " open - checked " + TimeToString(TimeLocal(), TIME_MINUTES | TIME_SECONDS);
   string lotTxt = InpFixedLot > 0 ? IntegerToString(InpLayers) + " x " + DoubleToString(InpFixedLot, 2) + " lot" : "risk " + DoubleToString(InpRiskPct, 2) + "%";
   Comment("MEEGO AI EA 1.33 (" + g_sym + ", " + lotTxt + (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED) ? "" : ", ALGO TRADING IS OFF") + "): " + g_status);
  }
//+------------------------------------------------------------------+
