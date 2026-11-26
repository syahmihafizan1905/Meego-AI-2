//+------------------------------------------------------------------+
//|                                                  MEEGO_AI_EA.mq5 |
//|  Copies MEEGO AI signals (Telegram bot @MeegoAISignalBot) to MT5. |
//|  Get your key by sending /ea to the bot.                          |
//+------------------------------------------------------------------+
#property copyright "MEEGO AI"
#property version   "1.30"
#property description "Copies MEEGO AI gold signals into MT5: draws the zone, enters while price is in it, TP1/TP2/TP3,"
#property description "closes half and moves SL to entry at +100 pips, lot size from your risk %."
#property description "Tools > Options > Expert Advisors > Allow WebRequest for the MEEGO URL first."

#include <Trade\Trade.mqh>

input string InpKey           = "";        // MEEGO EA key (send /ea in the bot)
input string InpSymbol        = "XAUUSD";  // Your broker's gold symbol (found by itself if this one does not exist)
input double InpFixedLot      = 0.01;      // Lot of every layer, whatever the balance (0 = use the risk % instead)
input int    InpLayers        = 3;         // Layers per signal (1-10), TP1/TP2/TP3 in turn
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
input double InpBEPips        = 100;       // At this profit (pips): close half and SL to entry (0 = off)
input double InpZoneTolPips   = 10;        // Entry allowed this far outside the zone (pips)
input double InpMinSLPips     = 20;        // Don't enter when the SL is closer than this (pips)
input bool   InpZoneLimit     = true;      // Price outside the zone: place limit orders at the zone
input bool   InpDrawZone      = true;      // Draw the zone with horizontal lines
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
  };
Sig      g_sigs[];
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
   EventSetTimer(MathMax(10, InpPollSec));
   OnTimer();
   return(INIT_SUCCEEDED);
  }
void OnDeinit(const int reason) { EventKillTimer(); Comment(""); ObjectsDeleteAll(0, "MEEGO_Z"); }
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
string GvBE(string id8)           { return("MEEGO_B_" + id8); }   // 1 = half closed, 2 = SL at entry too
string GvEnd(string id8)          { return("MEEGO_E_" + id8); }   // server time when the trade must be closed
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

   int ok = 0;
   for(int i = 0; i < parts; i++)
     {
      double tp = NormalizeDouble(tps[i] + delta, dg);
      if((tp - ref) * s.dir <= 0) continue; // this TP is already behind the price
      string c = Tag(s.id8, i + 1);
      bool r;
      if(limit)
        {
         double price = NormalizeDouble(lp, dg);
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

// At +InpBEPips: close half and move the SL of the rest to entry. Also closes trades whose time is up.
void ManageBE()
  {
   int    dg = (int)SymbolInfoInteger(g_sym, SYMBOL_DIGITS);
   double pt = SymbolInfoDouble(g_sym, SYMBOL_POINT), bid = SymbolInfoDouble(g_sym, SYMBOL_BID), ask = SymbolInfoDouble(g_sym, SYMBOL_ASK);
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
      if(InpBEPips <= 0 || !PositionSelectByTicket(tk[0])) continue;
      int stage = GlobalVariableCheck(GvBE(ids[k])) ? (int)GlobalVariableGet(GvBE(ids[k])) : 0;
      if(stage >= 2) continue;
      bool   buy  = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      double open = PositionGetDouble(POSITION_PRICE_OPEN), gain = buy ? bid - open : open - ask;
      if(stage == 0)
        {
         if(gain < InpBEPips * PIP || !TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)) continue;
         GlobalVariableSet(GvBE(ids[k]), 1);      // set first, so half is never closed twice
         CloseHalf(tk);
         Print("MEEGO AI EA: +", DoubleToString(gain / PIP, 0), " pips, closed half of ", ids[k]);
         n = Tickets(ids[k], tk);
        }
      bool all = true;
      for(int i = 0; i < n; i++)
        {
         if(!PositionSelectByTicket(tk[i])) continue;
         double e = NormalizeDouble(PositionGetDouble(POSITION_PRICE_OPEN), dg), cur = PositionGetDouble(POSITION_SL), tp = PositionGetDouble(POSITION_TP);
         if(cur != 0 && (buy ? cur >= e - pt / 2 : cur <= e + pt / 2)) continue;   // already at entry or better
         if(!(buy ? e < bid : e > ask) || !trade.PositionModify(tk[i], e, tp)) all = false;
        }
      if(all) GlobalVariableSet(GvBE(ids[k]), 2);
     }
  }

//+------------------------------------------------------------------+
void DrawLine(string name, double price, color c, string text)
  {
   if(ObjectFind(0, name) < 0)
     {
      ObjectCreate(0, name, OBJ_HLINE, 0, 0, price);
      ObjectSetInteger(0, name, OBJPROP_COLOR, c);
      ObjectSetInteger(0, name, OBJPROP_STYLE, STYLE_DASH);
      ObjectSetInteger(0, name, OBJPROP_WIDTH, 1);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
      ObjectSetString(0, name, OBJPROP_TEXT, text);
      ObjectSetString(0, name, OBJPROP_TOOLTIP, text);
     }
   ObjectSetDouble(0, name, OBJPROP_PRICE, price);
  }
// Zone lines stay while the signal is running or its trade is open
void DrawZones()
  {
   string keep = "";
   if(InpDrawZone && _Symbol == g_sym)
      for(int i = 0; i < ArraySize(g_sigs); i++)
        {
         if(!HasZone(g_sigs[i]) || !Wanted(g_sigs[i]) || (g_sigs[i].status != "running" && !HasAny(g_sigs[i].id8))) continue;
         color  c = g_sigs[i].dir > 0 ? clrMediumSeaGreen : clrTomato;
         string t = "MEEGO " + g_sigs[i].kind + (g_sigs[i].dir > 0 ? " demand" : " supply") + " zone";
         DrawLine("MEEGO_ZT_" + g_sigs[i].id8, g_sigs[i].zHi, c, t + " top");
         DrawLine("MEEGO_ZB_" + g_sigs[i].id8, g_sigs[i].zLo, c, t + " bottom");
         keep += g_sigs[i].id8 + ",";
        }
   for(int i = ObjectsTotal(0) - 1; i >= 0; i--)
     {
      string nm = ObjectName(0, i);
      if(StringFind(nm, "MEEGO_Z") == 0 && StringFind(keep, StringSubstr(nm, 9)) < 0) ObjectDelete(0, nm);
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
         int z = ZoneState(s);
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
   for(int i = 1; i < n; i++)
     {
      string line = lines[i];
      StringTrimRight(line);
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
   int waiting = 0;
   int sopWait = 0;
   for(int i = 0; i < ArraySize(g_sigs); i++)
      if(g_sigs[i].status == "running" && !GlobalVariableCheck(GvDone(g_sigs[i].id8))) { waiting++; if(g_sigs[i].ready == 0) sopWait++; }
   g_status = "connected - " + IntegerToString(ArraySize(g_sigs)) + " signals in feed - " + IntegerToString(waiting) + " waiting for entry" + (sopWait > 0 ? " (" + IntegerToString(sopWait) + " PR SOP: dashboard not ready)" : "") + " - " + IntegerToString(OpenSignalCount()) + " open - checked " + TimeToString(TimeLocal(), TIME_MINUTES | TIME_SECONDS);
   string lotTxt = InpFixedLot > 0 ? IntegerToString(InpLayers) + " x " + DoubleToString(InpFixedLot, 2) + " lot" : "risk " + DoubleToString(InpRiskPct, 2) + "%";
   Comment("MEEGO AI EA 1.30 (" + g_sym + ", " + lotTxt + (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED) ? "" : ", ALGO TRADING IS OFF") + "): " + g_status);
  }
//+------------------------------------------------------------------+
