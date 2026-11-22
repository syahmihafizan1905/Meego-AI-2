"""Build public/index.html from the MEEGO app source (app.html).

Run from the project folder:  python tools/build.py
It wraps the app in a full web page (title, app icon, install manifest) and adds
the website bridge (login, database, AI, live prices)."""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = io.open(os.path.join(ROOT, "src", "app.html"), encoding="utf-8").read()

def rep(old, new):
    global src
    if src.count(old) != 1:
        sys.exit(f"build: anchor not found exactly once: {old[:70]!r}")
    src = src.replace(old, new)

# live market prices from the server instead of demo candles
rep('    }else useDemo();',
    '    }else if(window.MEEGO_MARKET){try{const m=await window.MEEGO_MARKET(S.sym);S.data=m.data;S.price=m.price;'
    'setNotice("ok","Live market data · updated "+new Date(m.at).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"}))}'
    'catch(e){useDemo((e&&e.message?e.message+" ":"")+"Showing demo data.")}}else useDemo();')
rep('  if(S.source!=="live"||!S.mcp){const data={};TFS.forEach(tf=>data[tf]=demoCandles(sym,tf));return computeForPair(sym,data,null)}',
    '  if(S.source!=="live"||!S.mcp){if(window.MEEGO_MARKET){const m=await window.MEEGO_MARKET(sym);return computeForPair(sym,m.data,m.price)}'
    'const data={};TFS.forEach(tf=>data[tf]=demoCandles(sym,tf));return computeForPair(sym,data,null)}')

# the website has no MetaTrader connection: reword the demo notice
demo_old = "Choose <b>MT5</b> for real data from MetaTrader 5."
if demo_old not in src:
    sys.exit("build: demo notice text not found")
src = src.replace(demo_old, "Live prices appear once the price service is connected.")

head = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#081327">
<meta name="description" content="MEEGO AI: market signals, economic news and AI analysis.">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="MEEGO AI">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="stylesheet" href="gate.css">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font-size:14px}img{max-width:100%}[hidden]{display:none!important}</style>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
<script src="config.js"></script>
<script src="shim.js"></script>
</head>
<body>
"""
tail = """
<script>if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));</script>
</body>
</html>
"""
out = os.path.join(ROOT, "public", "index.html")
io.open(out, "w", encoding="utf-8").write(head + src + tail)
print("built", out)
