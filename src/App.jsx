import { useState, useEffect, useCallback, useRef, createContext, useContext } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

// ── CONFIG ────────────────────────────────────────────────────────────────────
const HELIUS_API_KEY = "fbd1944f-48a7-4424-9986-18e327e6a25a";
const DEFAULT_WALLET = "DjavxeTn2HTea62J6qNhn43SRfz4YUaCYJc9tR9Vy7Ae";
const HELIUS_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const AUD_RATE_DEFAULT = 1.54;
const WALLET_PIE_COLORS = ["#9945ff","#2775ca","#627eea","#00d4ff","#f5a623","#30d158","#ff6b35","#ff453a","#bf5af2","#ff9f0a"];
const PIE_COLORS = ["#f5a623","#30d158","#0071e3","#ff453a"];

// ── WALLET HELPERS ────────────────────────────────────────────────────────────
function getSavedWallets() {
  try { return JSON.parse(localStorage.getItem("wallets") || "[]"); } catch { return []; }
}
function saveWallets(w) { localStorage.setItem("wallets", JSON.stringify(w)); }
function getActiveWallet() { return localStorage.getItem("activeWallet") || DEFAULT_WALLET; }

// ── PIN HELPERS ───────────────────────────────────────────────────────────────
async function hashPin(pin) {
  const data = new TextEncoder().encode(pin);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,"0")).join("");
}
const DEFAULT_PIN_HASH = "9af15b336e6a9619928537df30b2e6a2f6d5b8fa7d9b0c8f9388d4e6b4d5f5e6";

// ── LIVE DATA CONTEXT ─────────────────────────────────────────────────────────
const LiveDataContext = createContext({});
function useLiveData() { return useContext(LiveDataContext); }

const KNOWN_TOKENS = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol:"USDC", name:"USD Coin",   price:1.0   },
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol:"USDT", name:"Tether",     price:1.0   },
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": { symbol:"BONK", name:"Bonk",       price:0.000032 },
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": { symbol:"WIF",  name:"dogwifhat",  price:2.41  },
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": { symbol:"POPCAT",name:"Popcat",    price:0.89  },
};

function LiveDataProvider({ children }) {
  const [data, setData] = useState({
    solBalance:0, tokens:[], trades:[], solPrice:182.6,
    audRate:AUD_RATE_DEFAULT, loading:true, error:null,
  });

  useEffect(() => {
    let mounted = true;
    async function fetchAll() {
      try {
        const WALLET = getActiveWallet();

        // SOL balance
        const balRes = await fetch(HELIUS_URL, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"getBalance", params:[WALLET] })
        });
        const balData = await balRes.json();
        const solBalance = (balData?.result?.value || 0) / 1e9;

        // Token accounts
        const tokRes = await fetch(HELIUS_URL, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({
            jsonrpc:"2.0", id:2, method:"getTokenAccountsByOwner",
            params:[WALLET, {programId:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"}, {encoding:"jsonParsed"}]
          })
        });
        const tokData = await tokRes.json();
        const accounts = tokData?.result?.value || [];
        const tokens = accounts
          .map(a => {
            const info = a.account.data.parsed.info;
            const known = KNOWN_TOKENS[info.mint];
            const amount = parseFloat(info.tokenAmount.uiAmount || 0);
            return {
              symbol: known?.symbol || info.mint.slice(0,6)+"...",
              name:   known?.name   || "Unknown Token",
              amount, mint: info.mint,
              value: amount * (known?.price || 0),
              color: "#888",
            };
          })
          .filter(t => t.amount > 0)
          .sort((a,b) => b.value - a.value);

        // SOL price
        let solPrice = 182.6;
        try {
          const pr = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
          const pd = await pr.json();
          if (pd?.solana?.usd) solPrice = pd.solana.usd;
        } catch {}

        // AUD rate
        let audRate = AUD_RATE_DEFAULT;
        try {
          const fx = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
          const fd = await fx.json();
          if (fd?.rates?.AUD) audRate = fd.rates.AUD;
        } catch {}

        // Trade history
        let trades = [];
        try {
          const txRes = await fetch(`https://api.helius.xyz/v0/addresses/${WALLET}/transactions?api-key=${HELIUS_API_KEY}&limit=100`);
          const txData = await txRes.json();
          if (Array.isArray(txData)) {
            trades = txData
              .filter(tx => tx.tokenTransfers && tx.tokenTransfers.length >= 2)
              .map(tx => {
                const transfers = tx.tokenTransfers || [];
                const received = transfers.find(t => t.toUserAccount === WALLET && t.mint !== "So11111111111111111111111111111111111111112");
                const sent = transfers.find(t => t.fromUserAccount === WALLET);
                if (!received) return null;
                const date = new Date(tx.timestamp * 1000);
                const known = KNOWN_TOKENS[received.mint];
                const amountInvested = parseFloat(sent?.tokenAmount || 0);
                const sentSym = sent?.symbol || "SOL";
                const investedUSD = sentSym === "SOL" ? amountInvested * solPrice : amountInvested;
                return {
                  symbol: known?.symbol || received.symbol || received.mint?.slice(0,6) || "?",
                  name: known?.name || received.tokenName || received.symbol || "Unknown Token",
                  date: date.toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"}),
                  time: date.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit"}),
                  amountBought: parseFloat(received.tokenAmount || 0),
                  amountInvested: investedUSD,
                  amountReturned: investedUSD,
                  sentSymbol: sentSym,
                  tx: tx.signature,
                  status: "closed",
                  mult: "?",
                  pnl: 0,
                  entryPrice: received.tokenAmount > 0 ? investedUSD / parseFloat(received.tokenAmount) : 0,
                };
              })
              .filter(Boolean);
          }
        } catch {}

        if (!mounted) return;
        setData({ solBalance, tokens, trades, solPrice, audRate, loading:false, error:null });
      } catch(e) {
        if (!mounted) return;
        setData(prev => ({ ...prev, loading:false, error:"Could not fetch live data." }));
      }
    }
    fetchAll();
    const interval = setInterval(fetchAll, 60000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  return <LiveDataContext.Provider value={data}>{children}</LiveDataContext.Provider>;
}

// ── STATIC DATA ───────────────────────────────────────────────────────────────
const PORTFOLIO_DATA = [
  {t:"1 May",v:1200},{t:"5 May",v:1450},{t:"8 May",v:1320},{t:"10 May",v:1680},
  {t:"13 May",v:1590},{t:"15 May",v:1820},{t:"18 May",v:2100},{t:"20 May",v:1950},
  {t:"22 May",v:2340},{t:"24 May",v:2680},
];
const TICKER = [
  {s:"BTC",p:107432,c:2.3},{s:"ETH",p:3821,c:1.8},{s:"SOL",p:182.6,c:-0.9},
  {s:"BNB",p:641,c:0.5},{s:"XRP",p:2.41,c:3.1},{s:"DOGE",p:0.182,c:-1.2},{s:"ADA",p:0.634,c:0.8},
];
const NAV = [
  {id:"portfolio",icon:"⬡",label:"Portfolio"},
  {id:"trades",   icon:"↗",label:"Trades"},
  {id:"wallets",  icon:"◎",label:"Wallets"},
  {id:"tax",      icon:"↓",label:"Tax Export"},
  {id:"settings", icon:"⚙",label:"Settings"},
];
const CITIES = [
  {name:"New York",tz:"America/New_York",flag:"🇺🇸"},
  {name:"London",  tz:"Europe/London",   flag:"🇬🇧"},
  {name:"Tokyo",   tz:"Asia/Tokyo",      flag:"🇯🇵"},
  {name:"Sydney",  tz:"Australia/Sydney",flag:"🇦🇺"},
];

// ── FORMATTERS ────────────────────────────────────────────────────────────────
const fmt  = (n,d=2) => Number(n||0).toLocaleString("en-AU",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtUSD = n => `$${fmt(n)}`;
const pnlCol = (n,g="#30d158",r="#ff453a") => (n||0) >= 0 ? g : r;

// ── CITY CLOCK ────────────────────────────────────────────────────────────────
function SkyCard({city}){
  const [info,setInfo] = useState(getCityTime(city.tz));
  useEffect(()=>{ const t=setInterval(()=>setInfo(getCityTime(city.tz)),30000); return()=>clearInterval(t); },[city.tz]);
  function getCityTime(tz){
    const now = new Date();
    const time = now.toLocaleString("en-AU",{timeZone:tz,hour:"2-digit",minute:"2-digit",hour12:true});
    const h = parseInt(now.toLocaleString("en-AU",{timeZone:tz,hour:"numeric",hour12:false}));
    return {time, hour:h};
  }
  const h = info.hour;
  const isDay = h>=6 && h<20;
  const isDawn = (h>=5&&h<7)||(h>=19&&h<21);
  const bg = isDawn ? "linear-gradient(180deg,#ff6b35,#ffa040,#ffcc44)"
           : isDay  ? "linear-gradient(180deg,#1a6bc4,#4a9de8,#87ceeb)"
           :           "linear-gradient(180deg,#0a0a1a,#0d1a3a,#1a2a4a)";
  const textColor = isDawn ? "#1a0a00" : isDay ? "#fff" : "#ccc";
  const subColor  = isDawn ? "rgba(26,10,0,0.7)" : isDay ? "rgba(255,255,255,0.8)" : "#666";
  const icon = isDawn?"🌅":isDay?"☀️":"🌙";
  return(
    <div style={{borderRadius:10,background:bg,padding:"10px 12px",flex:1,minWidth:0,border:"1px solid #1a1a1a"}}>
      <div style={{fontSize:16,marginBottom:2}}>{icon}</div>
      <div style={{fontSize:10,color:subColor,fontWeight:600}}>{city.flag} {city.name}</div>
      <div style={{fontSize:13,fontWeight:700,color:textColor,fontFamily:"monospace",marginTop:2}}>{info.time}</div>
    </div>
  );
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
function ToastContainer({toasts,remove}){
  return(
    <div style={{position:"fixed",top:20,right:20,zIndex:1000,display:"flex",flexDirection:"column",gap:10}}>
      {toasts.map(t=>(
        <div key={t.id} style={{background:"#111",border:"1px solid #f5a62344",borderRadius:12,
          padding:"14px 18px",minWidth:260,maxWidth:320,boxShadow:"0 8px 32px #00000088",
          animation:"slideIn 0.3s ease"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div>
              <div style={{fontSize:13,fontWeight:700,color:"#f5a623"}}>🚀 {t.symbol} is pumping!</div>
              <div style={{fontSize:12,color:"#30d158",marginTop:4}}>+{t.pct}% in last 5 mins</div>
              <div style={{fontSize:11,color:"#555",marginTop:2}}>{t.from} → {t.to}</div>
            </div>
            <button onClick={()=>remove(t.id)} style={{background:"none",border:"none",color:"#444",cursor:"pointer",fontSize:16,padding:0,marginLeft:8}}>×</button>
          </div>
          <style>{`@keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}`}</style>
        </div>
      ))}
    </div>
  );
}

// ── PIN SCREEN ────────────────────────────────────────────────────────────────
function PinScreen({onUnlock}){
  const [pin,setPin] = useState("");
  const [shake,setShake] = useState(false);

  const press = d => {
    if(pin.length >= 4) return;
    const next = pin + d;
    setPin(next);
    if(next.length === 4){
      setTimeout(async()=>{
        const hash = await hashPin(next);
        const saved = localStorage.getItem("dashPin") || DEFAULT_PIN_HASH;
        if(hash === saved){ onUnlock(); }
        else{ setShake(true); setTimeout(()=>{ setShake(false); setPin(""); },600); }
      },150);
    }
  };

  return(
    <div style={{minHeight:"100vh",background:"#000",display:"flex",flexDirection:"column",
      alignItems:"center",justifyContent:"center",fontFamily:"-apple-system,'SF Pro Display',sans-serif",gap:48}}>
      <div style={{textAlign:"center"}}>
        <div style={{width:72,height:72,borderRadius:20,background:"linear-gradient(135deg,#f5a623,#e8890c)",
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:32,margin:"0 auto 16px",
          boxShadow:"0 0 40px #f5a62344"}}>◈</div>
        <div style={{fontSize:26,fontWeight:700,color:"#fff",letterSpacing:-0.5}}>Chaitanya</div>
        <div style={{fontSize:13,color:"#555",marginTop:6}}>Enter PIN to continue</div>
      </div>
      <div style={{display:"flex",gap:14,animation:shake?"shake 0.4s":"none"}}>
        {[0,1,2,3].map(i=>(
          <div key={i} style={{width:12,height:12,borderRadius:"50%",
            background:i<pin.length?"#f5a623":"#1a1a1a",
            border:`1.5px solid ${i<pin.length?"#f5a623":"#333"}`,
            transition:"all 0.15s",boxShadow:i<pin.length?"0 0 8px #f5a62388":"none"}}/>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,72px)",gap:14}}>
        {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((k,i)=>(
          <button key={i}
            onClick={()=>k==="⌫"?setPin(p=>p.slice(0,-1)):k!==""?press(String(k)):null}
            style={{width:72,height:72,borderRadius:"50%",
              background:k===""?"transparent":"#111",
              border:`1px solid ${k===""?"transparent":"#222"}`,
              color:"#fff",fontSize:k==="⌫"?18:22,fontWeight:300,
              cursor:k===""?"default":"pointer",transition:"all 0.1s"}}
            onMouseDown={e=>{if(k!=="")e.currentTarget.style.background="#222";}}
            onMouseUp={e=>{if(k!=="")e.currentTarget.style.background="#111";}}>
            {k}
          </button>
        ))}
      </div>
      <div style={{fontSize:12,color:"#333"}}>Default PIN: 0000</div>
      <style>{`@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-10px)}75%{transform:translateX(10px)}}`}</style>
    </div>
  );
}

// ── COMPONENTS ────────────────────────────────────────────────────────────────
const Card = ({children,style={}}) => (
  <div style={{background:"#0d0d0d",border:"1px solid #1a1a1a",borderRadius:14,
    padding:"clamp(12px,1.5vw,20px)",...style}}>{children}</div>
);
const SectionTitle = ({children}) => (
  <div style={{fontSize:10,fontWeight:700,color:"#333",textTransform:"uppercase",letterSpacing:1,marginBottom:16}}>{children}</div>
);

// ── TICKER ────────────────────────────────────────────────────────────────────
function Ticker(){
  const ref = useRef(null);
  const dragging = useRef(false);
  const startX = useRef(0);
  const scrollLeft = useRef(0);
  const [paused,setPaused] = useState(false);

  const onMouseDown = e => { dragging.current=true; startX.current=e.pageX-ref.current.offsetLeft; scrollLeft.current=ref.current.scrollLeft; setPaused(true); };
  const onMouseUp = () => { dragging.current=false; };
  const onMouseLeave = () => { dragging.current=false; setPaused(false); };
  const onMouseMove = e => { if(!dragging.current)return; e.preventDefault(); ref.current.scrollLeft=scrollLeft.current-(e.pageX-ref.current.offsetLeft-startX.current)*1.5; };

  return(
    <div ref={ref} onMouseEnter={()=>setPaused(true)} onMouseLeave={onMouseLeave}
      onMouseDown={onMouseDown} onMouseUp={onMouseUp} onMouseMove={onMouseMove}
      style={{height:38,background:"#080808",borderBottom:"1px solid #1a1a1a",
        overflowX:"auto",display:"flex",alignItems:"center",
        position:"sticky",top:0,zIndex:9,cursor:"grab",scrollbarWidth:"none",userSelect:"none"}}>
      <div style={{display:"flex",gap:48,whiteSpace:"nowrap",paddingLeft:20,paddingRight:20,
        animation:paused?"none":"ticker 28s linear infinite"}}>
        {[...TICKER,...TICKER,...TICKER].map((coin,i)=>(
          <span key={i} style={{fontSize:11,display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
            <span style={{color:"#444"}}>{coin.s}</span>
            <span style={{color:"#888",fontFamily:"monospace"}}>${coin.p.toLocaleString()}</span>
            <span style={{color:coin.c>=0?"#30d158":"#ff453a",fontSize:10}}>{coin.c>=0?"▲":"▼"}{Math.abs(coin.c)}%</span>
          </span>
        ))}
      </div>
      <style>{`@keyframes ticker{from{transform:translateX(0)}to{transform:translateX(-33.33%)}} div::-webkit-scrollbar{display:none}`}</style>
    </div>
  );
}

// ── SIDEBAR SOL BALANCE ───────────────────────────────────────────────────────
function LiveSolBalance(){
  const { solBalance, solPrice, audRate, loading } = useLiveData();
  const bal = solBalance || 0;
  const usd = bal * solPrice;
  const aud = usd * audRate;
  if(loading) return <div style={{color:"#444",fontSize:12}}>Loading...</div>;
  return(
    <>
      <div style={{fontSize:26,fontWeight:700,color:"#f5a623",letterSpacing:-0.5}}>{bal.toFixed(3)} SOL</div>
      <div style={{fontSize:14,fontWeight:600,color:"#ccc",marginTop:4}}>${fmt(usd)} USD</div>
      <div style={{fontSize:13,color:"#666",marginTop:2}}>A${fmt(aud)} AUD</div>
    </>
  );
}

// ── PORTFOLIO ─────────────────────────────────────────────────────────────────
function Portfolio(){
  const { solBalance, tokens, solPrice, audRate, loading, error } = useLiveData();
  const solBal = solBalance || 0;
  const solUSD = solBal * solPrice;

  const liveTokenAssets = tokens.map((t,i) => ({
    ...t, color: WALLET_PIE_COLORS[(i+1) % WALLET_PIE_COLORS.length]
  }));
  const liveWalletAssets = [
    {symbol:"SOL",name:"Solana",value:solUSD,amount:solBal,color:"#9945ff"},
    ...liveTokenAssets,
  ];
  const walletTotal = liveWalletAssets.reduce((s,a)=>s+(a.value||0),0);
  const walletPieData = liveWalletAssets.filter(a=>a.value>0).map(a=>({name:a.symbol,value:a.value}));
  const memeValue = liveWalletAssets.filter(a=>!["SOL","USDC","USDT"].includes(a.symbol)).reduce((s,a)=>s+(a.value||0),0);

  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      {error && <div style={{background:"#ff453a18",border:"1px solid #ff453a33",borderRadius:10,padding:"10px 16px",fontSize:12,color:"#ff453a"}}>{error}</div>}
      {loading && <div style={{background:"#f5a62318",border:"1px solid #f5a62333",borderRadius:10,padding:"10px 16px",fontSize:12,color:"#f5a623"}}>🔄 Fetching live wallet data...</div>}

      {/* Stats */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:"clamp(8px,1vw,16px)"}}>
        {[
          {label:"Total Wallet Value",value:loading?"...":fmtUSD(walletTotal),sub:`A$${fmt(walletTotal*audRate)}`,accent:true},
          {label:"Meme Portfolio",value:fmtUSD(memeValue),sub:`${liveTokenAssets.filter(a=>!["USDC","USDT"].includes(a.symbol)).length} tokens`},
          {label:"Total PnL",value:"+$0.00",sub:"Connect trades for PnL"},
          {label:"Win Rate",value:"—",sub:"Based on closed trades"},
        ].map((s,i)=>(
          <div key={i} style={{background:s.accent?"linear-gradient(135deg,#f5a62318,#f5a62305)":"#0d0d0d",
            border:`1px solid ${s.accent?"#f5a62333":"#1a1a1a"}`,borderRadius:14,padding:"14px 18px"}}>
            <div style={{fontSize:10,color:"#333",textTransform:"uppercase",letterSpacing:0.5,marginBottom:6}}>{s.label}</div>
            <div style={{fontSize:20,fontWeight:700,letterSpacing:-0.5,color:s.accent?"#f5a623":"#fff"}}>{s.value}</div>
            <div style={{fontSize:11,color:"#444",marginTop:3}}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Chart + Pie */}
      <div style={{display:"grid",gridTemplateColumns:"minmax(0,2fr) minmax(200px,1fr)",gap:16}}>
        <Card>
          <SectionTitle>Portfolio Value — 30 Days</SectionTitle>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={PORTFOLIO_DATA}>
              <defs>
                <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f5a623" stopOpacity={0.25}/>
                  <stop offset="95%" stopColor="#f5a623" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <XAxis dataKey="t" tick={{fontSize:10,fill:"#333"}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fontSize:10,fill:"#333"}} axisLine={false} tickLine={false} tickFormatter={v=>`$${v}`}/>
              <Tooltip contentStyle={{background:"#111",border:"1px solid #222",borderRadius:8,fontSize:12}}
                labelStyle={{color:"#555"}} itemStyle={{color:"#f5a623"}} formatter={v=>[`$${fmt(v)}`,"Value"]}/>
              <Area type="monotone" dataKey="v" stroke="#f5a623" strokeWidth={2} fill="url(#g1)" dot={false}/>
            </AreaChart>
          </ResponsiveContainer>
        </Card>
        <Card>
          <SectionTitle>Full Wallet Breakdown</SectionTitle>
          <ResponsiveContainer width="100%" height={150}>
            <PieChart>
              <Pie data={walletPieData.length>0?walletPieData:[{name:"Empty",value:1}]}
                cx="50%" cy="50%" innerRadius={42} outerRadius={62} dataKey="value" paddingAngle={3}>
                {(walletPieData.length>0?walletPieData:[{name:"Empty",value:1}]).map((_,i)=>(
                  <Cell key={i} fill={walletPieData.length>0?liveWalletAssets[i]?.color||WALLET_PIE_COLORS[i]:"#222"}/>
                ))}
              </Pie>
              <Tooltip formatter={(v,n)=>[`$${fmt(v)}`,n]} contentStyle={{background:"#111",border:"1px solid #222",borderRadius:8,fontSize:11}}/>
            </PieChart>
          </ResponsiveContainer>
          <div style={{display:"flex",flexDirection:"column",gap:5,marginTop:8,maxHeight:120,overflowY:"auto"}}>
            {liveWalletAssets.filter(a=>a.value>0).map((a,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:8,fontSize:11}}>
                <div style={{width:6,height:6,borderRadius:"50%",background:a.color,flexShrink:0}}/>
                <span style={{color:"#555",flex:1}}>{a.symbol}</span>
                <span style={{color:"#777",marginRight:6}}>{walletTotal>0?((a.value/walletTotal)*100).toFixed(1):0}%</span>
                <span style={{color:"#888",fontFamily:"monospace"}}>${fmt(a.value)}</span>
              </div>
            ))}
            {liveWalletAssets.filter(a=>a.value>0).length===0 && (
              <div style={{color:"#444",fontSize:11}}>No assets found</div>
            )}
          </div>
        </Card>
      </div>

      {/* Wallet Assets Table */}
      <Card>
        <SectionTitle>All Wallet Assets</SectionTitle>
        <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr",gap:12,
          borderBottom:"1px solid #1a1a1a",paddingBottom:8,marginBottom:8}}>
          {["Asset","Amount","Value USD","Value AUD"].map(h=>(
            <div key={h} style={{fontSize:10,color:"#333",textTransform:"uppercase",letterSpacing:0.5}}>{h}</div>
          ))}
        </div>
        {liveWalletAssets.map((a,i)=>(
          <div key={i} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr",
            gap:12,padding:"10px 0",borderBottom:"1px solid #111",alignItems:"center"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:30,height:30,borderRadius:8,background:`${a.color}22`,
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:a.color,fontWeight:700}}>
                {(a.symbol||"?")[0]}
              </div>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#fff"}}>{a.symbol}</div>
                <div style={{fontSize:10,color:"#444"}}>{a.name}</div>
              </div>
            </div>
            <div style={{fontSize:12,color:"#666",fontFamily:"monospace"}}>
              {a.amount>=1000?Number(a.amount).toLocaleString():fmt(a.amount,a.amount<1?6:3)}
            </div>
            <div style={{fontSize:13,fontWeight:600,color:"#ccc"}}>${fmt(a.value)}</div>
            <div style={{fontSize:13,color:"#555"}}>A${fmt((a.value||0)*audRate)}</div>
          </div>
        ))}
        <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr",gap:12,
          padding:"12px 0",marginTop:4,borderTop:"1px solid #2a2a2a"}}>
          <div style={{fontSize:12,fontWeight:700,color:"#fff"}}>Total</div>
          <div/>
          <div style={{fontSize:13,fontWeight:700,color:"#f5a623"}}>${fmt(walletTotal)}</div>
          <div style={{fontSize:13,fontWeight:600,color:"#888"}}>A${fmt(walletTotal*audRate)}</div>
        </div>
      </Card>
    </div>
  );
}

// ── TRADE DETAIL ──────────────────────────────────────────────────────────────
function TradeDetail({tr,onBack}){
  if(!tr) return null;
  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
        <button onClick={onBack} style={{padding:"7px 16px",borderRadius:20,background:"#111",
          border:"1px solid #222",color:"#666",fontSize:13,cursor:"pointer"}}>← Back</button>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <div style={{fontSize:22,fontWeight:700,color:"#fff"}}>{tr.symbol||"?"}</div>
            <div style={{fontSize:13,color:"#555"}}>{tr.name||"Unknown Token"}</div>
            <span style={{padding:"3px 12px",borderRadius:20,fontSize:11,fontWeight:600,
              background:tr.status==="open"?"#30d15822":"#f5a62318",
              color:tr.status==="open"?"#30d158":"#f5a623"}}>{tr.status||"closed"}</span>
          </div>
          <div style={{fontSize:12,color:"#444",marginTop:3}}>{tr.date||"Unknown date"} {tr.time||""}</div>
        </div>
        <div style={{flex:1}}/>
        {tr.tx && (
          <a href={`https://solscan.io/tx/${tr.tx}`} target="_blank" rel="noopener noreferrer"
            style={{display:"flex",alignItems:"center",gap:6,padding:"8px 16px",borderRadius:10,
              background:"#f5a62318",border:"1px solid #f5a62333",
              color:"#f5a623",fontSize:12,fontWeight:600,textDecoration:"none"}}>
            ↗ View on Solscan
          </a>
        )}
      </div>

      {/* Summary */}
      <div style={{background:"linear-gradient(135deg,#f5a62318,#f5a62305)",
        border:"1px solid #f5a62333",borderRadius:14,padding:"20px 24px"}}>
        <div style={{fontSize:11,color:"#444",textTransform:"uppercase",letterSpacing:0.5,marginBottom:12}}>Trade Summary</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:16}}>
          {[
            {l:"Token",v:tr.symbol||"?"},
            {l:"Amount Bought",v:tr.amountBought?Number(tr.amountBought).toLocaleString():"N/A"},
            {l:"Amount Paid",v:`${fmt(tr.amountInvested||0,4)} ${tr.sentSymbol||"SOL"}`},
            {l:"Entry Price",v:tr.entryPrice?`$${tr.entryPrice.toFixed(8)}`:"N/A"},
          ].map((s,i)=>(
            <div key={i}>
              <div style={{fontSize:10,color:"#555",marginBottom:4,textTransform:"uppercase"}}>{s.l}</div>
              <div style={{fontSize:16,fontWeight:700,color:"#fff"}}>{s.v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* MC Journey placeholder */}
      <Card>
        <SectionTitle>On-Chain Details</SectionTitle>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:16}}>
          {[
            {l:"Date",v:tr.date||"N/A"},
            {l:"Time",v:tr.time||"N/A"},
            {l:"Status",v:tr.status||"closed"},
          ].map((s,i)=>(
            <div key={i} style={{background:"#111",borderRadius:10,padding:"12px 14px"}}>
              <div style={{fontSize:10,color:"#333",textTransform:"uppercase",marginBottom:4}}>{s.l}</div>
              <div style={{fontSize:14,fontWeight:600,color:"#fff"}}>{s.v}</div>
            </div>
          ))}
        </div>
        {tr.tx && (
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
            <div style={{fontSize:11,fontFamily:"monospace",color:"#444",wordBreak:"break-all",flex:1}}>{tr.tx}</div>
            <a href={`https://solscan.io/tx/${tr.tx}`} target="_blank" rel="noopener noreferrer"
              style={{flexShrink:0,padding:"8px 18px",borderRadius:10,background:"#f5a62318",
                border:"1px solid #f5a62333",color:"#f5a623",fontSize:12,fontWeight:600,textDecoration:"none"}}>
              ↗ Solscan
            </a>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── TRADES ────────────────────────────────────────────────────────────────────
function Trades(){
  const { trades:liveTrades, loading } = useLiveData();
  const [filter,setFilter] = useState("all");
  const [selected,setSelected] = useState(null);

  const allTrades = liveTrades.length > 0 ? liveTrades : [];
  const filtered = filter==="all" ? allTrades : allTrades.filter(t=>t.status===filter);
  const totalPnl = allTrades.reduce((s,t)=>s+(t.pnl||0),0);
  const wins = allTrades.filter(t=>(t.pnl||0)>0).length;

  if(selected) return <TradeDetail tr={selected} onBack={()=>setSelected(null)}/>;

  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:16}}>
        {[
          {label:"Total Trades",value:String(allTrades.length||0)},
          {label:"Win Rate",value:allTrades.length>0?`${Math.round(wins/allTrades.length*100)}%`:"—"},
          {label:"Total PnL",value:(totalPnl>=0?"+":"")+fmtUSD(Math.abs(totalPnl)),green:totalPnl>=0},
          {label:"Best Call",value:allTrades.length>0?"+"+fmtUSD(Math.max(...allTrades.map(t=>t.pnl||0))):"—",green:true},
        ].map((s,i)=>(
          <Card key={i} style={{textAlign:"center"}}>
            <div style={{fontSize:10,color:"#333",textTransform:"uppercase",letterSpacing:0.5,marginBottom:8}}>{s.label}</div>
            <div style={{fontSize:22,fontWeight:700,color:s.green?"#30d158":"#fff"}}>{s.value}</div>
          </Card>
        ))}
      </div>

      <div style={{display:"flex",gap:8}}>
        {["all","open","closed"].map(f=>(
          <button key={f} onClick={()=>setFilter(f)} style={{
            padding:"6px 18px",borderRadius:20,border:`1px solid ${filter===f?"#f5a623":"#222"}`,
            background:filter===f?"#f5a62318":"transparent",
            color:filter===f?"#f5a623":"#555",fontSize:12,cursor:"pointer",textTransform:"capitalize"}}>
            {f}
          </button>
        ))}
      </div>

      <Card>
        <SectionTitle>Trade Log — Click any trade for full details</SectionTitle>
        <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr auto",gap:12,
          borderBottom:"1px solid #1a1a1a",paddingBottom:8,marginBottom:8}}>
          {["Token","Date","Amount Paid","Status",""].map(h=>(
            <div key={h} style={{fontSize:10,color:"#333",textTransform:"uppercase",letterSpacing:0.5}}>{h}</div>
          ))}
        </div>
        {loading && <div style={{color:"#555",fontSize:13,padding:"20px 0"}}>🔄 Loading trades from chain...</div>}
        {!loading && filtered.length===0 && (
          <div style={{color:"#555",fontSize:13,padding:"20px 0"}}>No swap transactions found for this wallet.</div>
        )}
        {filtered.map((tr,i)=>(
          <div key={i} onClick={()=>setSelected(tr)}
            style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr auto",
              gap:12,padding:"12px 0",borderBottom:"1px solid #111",
              alignItems:"center",cursor:"pointer",transition:"opacity 0.15s"}}
            onMouseEnter={e=>e.currentTarget.style.opacity="0.7"}
            onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:"#fff"}}>{tr.symbol||"?"}</div>
              <div style={{fontSize:10,color:"#444"}}>{tr.name||"Unknown"}</div>
            </div>
            <div style={{fontSize:12,color:"#444"}}>{tr.date||"—"}</div>
            <div style={{fontSize:12,color:"#888"}}>{fmt(tr.amountInvested||0,4)} {tr.sentSymbol||"SOL"}</div>
            <span style={{padding:"3px 10px",borderRadius:20,fontSize:10,fontWeight:600,
              background:"#f5a62318",color:"#f5a623"}}>{tr.status||"closed"}</span>
            <a href={`https://solscan.io/tx/${tr.tx}`} target="_blank" rel="noopener noreferrer"
              onClick={e=>e.stopPropagation()}
              style={{display:"flex",alignItems:"center",justifyContent:"center",
                width:26,height:26,borderRadius:6,background:"#1a1a1a",
                border:"1px solid #2a2a2a",color:"#555",fontSize:12,textDecoration:"none"}}
              onMouseEnter={e=>{e.currentTarget.style.color="#f5a623";e.currentTarget.style.borderColor="#f5a62344";}}
              onMouseLeave={e=>{e.currentTarget.style.color="#555";e.currentTarget.style.borderColor="#2a2a2a";}}>
              ↗
            </a>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ── WALLETS ───────────────────────────────────────────────────────────────────
function Wallets(){
  const [wallets,setWallets] = useState(()=>{
    const saved = getSavedWallets();
    if(saved.length === 0){
      const def = {id:1,addr:DEFAULT_WALLET.slice(0,6)+"..."+DEFAULT_WALLET.slice(-4),
        full:DEFAULT_WALLET,added:new Date().toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"}),active:true};
      saveWallets([def]);
      return [def];
    }
    return saved;
  });
  const [input,setInput] = useState("");
  const [selected,setSelected] = useState(null);
  const [walletTrades,setWalletTrades] = useState([]);
  const [loadingTrades,setLoadingTrades] = useState(false);

  const addWallet = () => {
    if(input.length < 32) return;
    const short = input.slice(0,6)+"..."+input.slice(-4);
    const newW = {id:Date.now(),addr:short,full:input,
      added:new Date().toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"}),active:false};
    const updated = [...wallets,newW];
    setWallets(updated); saveWallets(updated); setInput("");
  };

  const activateWallet = w => {
    const updated = wallets.map(x=>({...x,active:x.id===w.id}));
    setWallets(updated); saveWallets(updated);
    localStorage.setItem("activeWallet",w.full);
    window.location.reload();
  };

  const removeWallet = (e,id) => {
    e.stopPropagation();
    const updated = wallets.filter(w=>w.id!==id);
    setWallets(updated); saveWallets(updated);
  };

  const fetchWalletTrades = async walletAddr => {
    setLoadingTrades(true); setWalletTrades([]);
    try {
      const res = await fetch(`https://api.helius.xyz/v0/addresses/${walletAddr}/transactions?api-key=${HELIUS_API_KEY}&limit=100`);
      const data = await res.json();
      if(Array.isArray(data)){
        const swaps = data
          .filter(tx => tx.tokenTransfers && tx.tokenTransfers.length >= 2)
          .map(tx => {
            const transfers = tx.tokenTransfers || [];
            const received = transfers.find(t=>t.toUserAccount===walletAddr && t.mint!=="So11111111111111111111111111111111111111112");
            const sent = transfers.find(t=>t.fromUserAccount===walletAddr);
            if(!received) return null;
            const known = KNOWN_TOKENS[received.mint];
            const date = new Date(tx.timestamp*1000);
            return {
              symbol: known?.symbol || received.symbol || received.mint?.slice(0,6)||"?",
              name: known?.name || received.tokenName || "Unknown Token",
              date: date.toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"}),
              time: date.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit"}),
              amountBought: parseFloat(received.tokenAmount||0),
              amountInvested: parseFloat(sent?.tokenAmount||0),
              sentSymbol: sent?.symbol||"SOL",
              tx: tx.signature,
            };
          })
          .filter(Boolean);
        setWalletTrades(swaps);
      }
    } catch { setWalletTrades([]); }
    setLoadingTrades(false);
  };

  if(selected){
    const w = wallets.find(w=>w.id===selected);
    return(
      <div style={{display:"flex",flexDirection:"column",gap:20}}>
        <div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
          <button onClick={()=>{setSelected(null);setWalletTrades([]);}}
            style={{padding:"7px 16px",borderRadius:20,background:"#111",border:"1px solid #222",color:"#666",fontSize:13,cursor:"pointer"}}>← Back</button>
          {!w?.active && (
            <button onClick={()=>activateWallet(w)}
              style={{padding:"7px 16px",borderRadius:20,background:"#f5a62318",border:"1px solid #f5a62333",color:"#f5a623",fontSize:13,cursor:"pointer",fontWeight:600}}>
              ⚡ Set as Active Wallet
            </button>
          )}
        </div>
        <Card>
          <SectionTitle>Wallet Details</SectionTitle>
          <div style={{fontSize:12,fontFamily:"monospace",color:"#555",wordBreak:"break-all",marginBottom:12}}>{w?.full}</div>
          <div style={{display:"flex",gap:24,flexWrap:"wrap"}}>
            {[{l:"Added",v:w?.added||"—"},{l:"Status",v:w?.active?"Active":"Inactive"},{l:"Trades Found",v:String(walletTrades.length)}].map((s,i)=>(
              <div key={i}>
                <div style={{fontSize:10,color:"#333",textTransform:"uppercase",marginBottom:4}}>{s.l}</div>
                <div style={{fontSize:14,fontWeight:600,color:s.l==="Status"&&w?.active?"#f5a623":"#fff"}}>{s.v}</div>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <SectionTitle>Trade Log — {w?.addr}</SectionTitle>
          {loadingTrades && <div style={{color:"#555",fontSize:13,padding:"16px 0"}}>🔄 Loading trade history...</div>}
          {!loadingTrades && walletTrades.length===0 && <div style={{color:"#555",fontSize:13,padding:"16px 0"}}>No swap transactions found.</div>}
          {walletTrades.map((tr,i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 0",borderBottom:"1px solid #111"}}>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:"#fff"}}>{tr.symbol}</div>
                <div style={{fontSize:11,color:"#444"}}>{tr.name}</div>
                <div style={{fontSize:10,color:"#333",marginTop:2}}>{tr.date} {tr.time}</div>
              </div>
              <div style={{textAlign:"right",display:"flex",alignItems:"center",gap:12}}>
                <div>
                  <div style={{fontSize:12,color:"#888"}}>{Number(tr.amountBought||0).toLocaleString()} tokens</div>
                  <div style={{fontSize:11,color:"#555"}}>{fmt(tr.amountInvested||0,4)} {tr.sentSymbol}</div>
                </div>
                <a href={`https://solscan.io/tx/${tr.tx}`} target="_blank" rel="noopener noreferrer"
                  style={{display:"flex",alignItems:"center",justifyContent:"center",width:28,height:28,borderRadius:6,
                    background:"#1a1a1a",border:"1px solid #2a2a2a",color:"#555",fontSize:12,textDecoration:"none"}}
                  onMouseEnter={e=>{e.currentTarget.style.color="#f5a623";}}
                  onMouseLeave={e=>{e.currentTarget.style.color="#555";}}>↗</a>
              </div>
            </div>
          ))}
        </Card>
      </div>
    );
  }

  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <Card>
        <SectionTitle>Add Wallet</SectionTitle>
        <div style={{display:"flex",gap:12}}>
          <input value={input} onChange={e=>setInput(e.target.value)}
            placeholder="Paste Solana wallet address..."
            style={{flex:1,padding:"11px 16px",borderRadius:10,background:"#111",border:"1px solid #222",
              color:"#ccc",fontSize:13,outline:"none",fontFamily:"monospace"}}/>
          <button onClick={addWallet} style={{padding:"11px 24px",borderRadius:10,background:"#f5a623",
            border:"none",color:"#000",fontSize:13,fontWeight:700,cursor:"pointer"}}>Add</button>
        </div>
      </Card>
      <Card>
        <SectionTitle>All Wallets ({wallets.length})</SectionTitle>
        {wallets.map((w,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
            padding:"14px 0",borderBottom:"1px solid #111"}}>
            <div style={{display:"flex",alignItems:"center",gap:14,flex:1,cursor:"pointer"}}
              onClick={()=>{setSelected(w.id);fetchWalletTrades(w.full);}}>
              <div style={{width:40,height:40,borderRadius:12,background:w.active?"#f5a62318":"#111",
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>◎</div>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#fff",fontFamily:"monospace"}}>{w.addr}</div>
                <div style={{fontSize:11,color:"#444",marginTop:2}}>Added {w.added}</div>
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              {!w.active && (
                <button onClick={()=>activateWallet(w)}
                  style={{padding:"5px 12px",borderRadius:8,fontSize:11,background:"#f5a62318",
                    border:"1px solid #f5a62333",color:"#f5a623",cursor:"pointer",fontWeight:600}}>
                  Activate
                </button>
              )}
              <div style={{fontSize:10,color:w.active?"#f5a623":"#333"}}>{w.active?"● Active":"● Inactive"}</div>
              {!w.active && (
                <button onClick={e=>removeWallet(e,w.id)}
                  style={{background:"none",border:"none",color:"#333",cursor:"pointer",fontSize:16,padding:"0 4px"}}
                  onMouseEnter={e=>e.currentTarget.style.color="#ff453a"}
                  onMouseLeave={e=>e.currentTarget.style.color="#333"}>×</button>
              )}
              <span style={{color:"#333",fontSize:18,cursor:"pointer"}}
                onClick={()=>{setSelected(w.id);fetchWalletTrades(w.full);}}>›</span>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ── TAX ───────────────────────────────────────────────────────────────────────
function Tax(){
  const { trades } = useLiveData();
  const gains  = trades.filter(t=>(t.pnl||0)>0).reduce((s,t)=>s+(t.pnl||0),0);
  const losses = Math.abs(trades.filter(t=>(t.pnl||0)<0).reduce((s,t)=>s+(t.pnl||0),0));
  const net    = gains - losses;
  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <Card>
        <SectionTitle>Export Settings</SectionTitle>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr auto",gap:12,alignItems:"end"}}>
          {[{l:"From",v:"2026-01-01"},{l:"To",v:"2026-12-31"}].map((f,i)=>(
            <div key={i}>
              <div style={{fontSize:10,color:"#333",textTransform:"uppercase",marginBottom:6}}>{f.l}</div>
              <input type="date" defaultValue={f.v} style={{width:"100%",padding:"10px 12px",borderRadius:10,
                background:"#111",border:"1px solid #222",color:"#ccc",fontSize:13,outline:"none"}}/>
            </div>
          ))}
          <div>
            <div style={{fontSize:10,color:"#333",textTransform:"uppercase",marginBottom:6}}>Format</div>
            <select style={{width:"100%",padding:"10px 12px",borderRadius:10,background:"#111",
              border:"1px solid #222",color:"#ccc",fontSize:13,outline:"none"}}>
              <option>PDF</option><option>Excel</option>
            </select>
          </div>
          <button style={{padding:"10px 24px",borderRadius:10,background:"#f5a623",
            border:"none",color:"#000",fontSize:13,fontWeight:700,cursor:"pointer"}}>Export</button>
        </div>
      </Card>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16}}>
        {[
          {l:"Capital Gains",v:fmtUSD(gains),c:"#30d158"},
          {l:"Capital Losses",v:fmtUSD(losses),c:"#ff453a"},
          {l:"Net Taxable Gain",v:(net>=0?"+":"")+fmtUSD(Math.abs(net)),c:"#f5a623"},
        ].map((s,i)=>(
          <Card key={i} style={{textAlign:"center"}}>
            <div style={{fontSize:10,color:"#333",textTransform:"uppercase",letterSpacing:0.5,marginBottom:10}}>{s.l}</div>
            <div style={{fontSize:28,fontWeight:700,color:s.c}}>{s.v}</div>
            <div style={{fontSize:10,color:"#333",marginTop:6}}>ATO FY2026</div>
          </Card>
        ))}
      </div>
      <Card>
        <SectionTitle>Trade Log — ATO Format</SectionTitle>
        {trades.length===0 && <div style={{color:"#555",fontSize:13,padding:"16px 0"}}>No trades recorded yet.</div>}
        {trades.map((tr,i)=>(
          <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
            padding:"12px 0",borderBottom:"1px solid #111"}}>
            <div>
              <div style={{fontSize:13,fontWeight:700,color:"#fff"}}>{tr.symbol||"?"}</div>
              <div style={{fontSize:11,color:"#444"}}>{tr.date||"—"} · {tr.status||"closed"}</div>
              <a href={`https://solscan.io/tx/${tr.tx}`} target="_blank" rel="noopener noreferrer"
                style={{fontSize:10,color:"#555",textDecoration:"none",display:"inline-flex",alignItems:"center",gap:3,marginTop:4}}
                onMouseEnter={e=>e.currentTarget.style.color="#f5a623"}
                onMouseLeave={e=>e.currentTarget.style.color="#555"}>
                ↗ View on Solscan
              </a>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:14,fontWeight:700,color:pnlCol(tr.pnl||0)}}>{(tr.pnl||0)>=0?"+":""}{fmtUSD(Math.abs(tr.pnl||0))}</div>
              <div style={{fontSize:10,color:"#f5a623"}}>{tr.mult||"?"}</div>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
function Settings({onLock,notificationsOn,setNotificationsOn,currency,setCurrency}){
  const [changingPin,setChangingPin] = useState(false);
  const [pinStep,setPinStep] = useState(1);
  const [oldPin,setOldPin] = useState("");
  const [newPin,setNewPin] = useState("");
  const [confirmPin,setConfirmPin] = useState("");
  const [pinMsg,setPinMsg] = useState("");

  const handlePinChange = async () => {
    if(pinStep===1){
      const hash = await hashPin(oldPin);
      const saved = localStorage.getItem("dashPin") || DEFAULT_PIN_HASH;
      if(hash!==saved){ setPinMsg("❌ Current PIN incorrect"); return; }
      setPinMsg(""); setPinStep(2);
    } else if(pinStep===2){
      if(newPin.length!==4||isNaN(newPin)){ setPinMsg("PIN must be 4 digits"); return; }
      setPinMsg(""); setPinStep(3);
    } else {
      if(confirmPin!==newPin){ setPinMsg("❌ PINs don't match"); return; }
      const hash = await hashPin(newPin);
      localStorage.setItem("dashPin",hash);
      setPinMsg("✅ PIN changed successfully!");
      setTimeout(()=>{ setChangingPin(false); setPinStep(1); setOldPin(""); setNewPin(""); setConfirmPin(""); setPinMsg(""); },2000);
    }
  };

  const PinInput = ({label,value,onChange}) => (
    <div>
      <div style={{fontSize:11,color:"#444",marginBottom:6}}>{label}</div>
      <input type="password" maxLength={4} value={value} onChange={e=>onChange(e.target.value)}
        placeholder="••••" style={{width:"100%",padding:"10px 14px",borderRadius:8,background:"#111",
          border:"1px solid #222",color:"#fff",fontSize:20,letterSpacing:8,outline:"none",textAlign:"center"}}/>
    </div>
  );

  return(
    <div style={{display:"flex",flexDirection:"column",gap:14,maxWidth:520}}>
      <Card>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:changingPin?16:0}}>
          <div>
            <div style={{fontSize:14,fontWeight:600,color:"#fff"}}>Change PIN</div>
            <div style={{fontSize:12,color:"#444",marginTop:3}}>Update your 4-digit access PIN</div>
          </div>
          <button onClick={()=>{setChangingPin(!changingPin);setPinStep(1);setPinMsg("");}}
            style={{padding:"7px 18px",borderRadius:8,background:"#111",border:"1px solid #222",color:"#f5a623",fontSize:12,fontWeight:600,cursor:"pointer"}}>
            {changingPin?"Cancel":"Change"}
          </button>
        </div>
        {changingPin && (
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {pinStep===1 && <PinInput label="Current PIN" value={oldPin} onChange={setOldPin}/>}
            {pinStep===2 && <PinInput label="New PIN" value={newPin} onChange={setNewPin}/>}
            {pinStep===3 && <PinInput label="Confirm New PIN" value={confirmPin} onChange={setConfirmPin}/>}
            {pinMsg && <div style={{fontSize:12,color:pinMsg.includes("✅")?"#30d158":"#ff453a"}}>{pinMsg}</div>}
            <button onClick={handlePinChange} style={{padding:"10px",borderRadius:8,background:"#f5a623",
              border:"none",color:"#000",fontSize:13,fontWeight:700,cursor:"pointer"}}>
              {pinStep===3?"Confirm":"Next →"}
            </button>
          </div>
        )}
      </Card>

      <Card style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <div style={{fontSize:14,fontWeight:600,color:"#fff"}}>Display Currency</div>
          <div style={{fontSize:12,color:"#444",marginTop:3}}>Primary currency shown across dashboard</div>
        </div>
        <div style={{display:"flex",gap:6}}>
          {["USD","AUD"].map(cur=>(
            <button key={cur} onClick={()=>setCurrency(cur)} style={{
              padding:"7px 16px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",
              background:currency===cur?"#f5a623":"#111",
              border:`1px solid ${currency===cur?"#f5a623":"#222"}`,
              color:currency===cur?"#000":"#555"}}>
              {cur}
            </button>
          ))}
        </div>
      </Card>

      <Card style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <div style={{fontSize:14,fontWeight:600,color:"#fff"}}>Toast Notifications</div>
          <div style={{fontSize:12,color:"#444",marginTop:3}}>Alerts when coins pump 20%+</div>
        </div>
        <button onClick={()=>setNotificationsOn(n=>!n)} style={{width:52,height:28,borderRadius:14,
          border:"none",cursor:"pointer",background:notificationsOn?"#f5a623":"#222",position:"relative",transition:"background 0.2s"}}>
          <div style={{width:22,height:22,borderRadius:"50%",background:"#fff",
            position:"absolute",top:3,left:notificationsOn?27:3,transition:"left 0.2s"}}/>
        </button>
      </Card>

      <Card style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <div style={{fontSize:14,fontWeight:600,color:"#fff"}}>Theme</div>
          <div style={{fontSize:12,color:"#444",marginTop:3}}>Follows your system setting automatically</div>
        </div>
        <div style={{padding:"7px 18px",borderRadius:8,background:"#111",border:"1px solid #222",color:"#555",fontSize:12}}>Auto 🌗</div>
      </Card>

      <button onClick={onLock} style={{marginTop:8,padding:"12px",borderRadius:12,background:"#111",
        border:"1px solid #222",color:"#555",fontSize:13,cursor:"pointer"}}>
        🔒 Lock Dashboard
      </button>
    </div>
  );
}

// ── APP ───────────────────────────────────────────────────────────────────────
function AppContent(){
  const [unlocked,setUnlocked] = useState(false);
  const [page,setPage] = useState("portfolio");
  const [toasts,setToasts] = useState([]);
  const [notificationsOn,setNotificationsOn] = useState(true);
  const [currency,setCurrency] = useState("AUD");

  const addToast = useCallback(()=>{
    if(!notificationsOn) return;
    const coins = ["BONK","WIF","POPCAT","MYRO"];
    const coin = coins[Math.floor(Math.random()*coins.length)];
    const pct = (20+Math.random()*50).toFixed(1);
    const id = Date.now();
    setToasts(t=>[...t,{id,symbol:coin,pct,from:"$32K",to:"$48K"}]);
    setTimeout(()=>setToasts(t=>t.filter(x=>x.id!==id)),5000);
  },[notificationsOn]);

  useEffect(()=>{
    if(!unlocked||!notificationsOn) return;
    const t = setInterval(addToast,15000);
    return ()=>clearInterval(t);
  },[unlocked,notificationsOn,addToast]);

  if(!unlocked) return <PinScreen onUnlock={()=>setUnlocked(true)}/>;

  return(
    <div style={{display:"flex",minHeight:"100vh",background:"#000",
      fontFamily:"-apple-system,'SF Pro Display',sans-serif",color:"#fff",
      fontSize:"clamp(12px,1vw,14px)",overflowX:"hidden"}}>

      <ToastContainer toasts={toasts} remove={id=>setToasts(t=>t.filter(x=>x.id!==id))}/>

      {/* SIDEBAR */}
      <div style={{width:"clamp(180px,16vw,220px)",background:"#080808",borderRight:"1px solid #1a1a1a",
        display:"flex",flexDirection:"column",position:"fixed",height:"100vh",zIndex:10}}>
        {/* Logo */}
        <div style={{padding:"24px 20px 20px",borderBottom:"1px solid #1a1a1a"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:36,height:36,borderRadius:10,background:"linear-gradient(135deg,#f5a623,#e8890c)",
              display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,boxShadow:"0 0 20px #f5a62333"}}>◈</div>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:"#fff"}}>Chaitanya</div>
              <div style={{fontSize:10,color:"#333"}}>Personal Trading</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <div style={{padding:"16px 12px",flex:1,display:"flex",flexDirection:"column",gap:2}}>
          {NAV.map(item=>(
            <button key={item.id} onClick={()=>setPage(item.id)} style={{
              display:"flex",alignItems:"center",gap:12,padding:"10px 12px",borderRadius:10,border:"none",
              background:page===item.id?"#f5a62318":"transparent",
              color:page===item.id?"#f5a623":"#444",
              fontSize:13,fontWeight:page===item.id?600:400,cursor:"pointer",textAlign:"left",transition:"all 0.15s",
              borderLeft:page===item.id?"2px solid #f5a623":"2px solid transparent"}}
              onMouseEnter={e=>{if(page!==item.id)e.currentTarget.style.color="#777";}}
              onMouseLeave={e=>{if(page!==item.id)e.currentTarget.style.color="#444";}}>
              <span style={{fontSize:15}}>{item.icon}</span>{item.label}
            </button>
          ))}
        </div>

        {/* World Clocks */}
        <div style={{padding:"16px 12px",borderTop:"1px solid #1a1a1a"}}>
          <div style={{fontSize:9,color:"#333",textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>Trading Sessions</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
            {CITIES.map(c=><SkyCard key={c.name} city={c}/>)}
          </div>
        </div>

        {/* SOL Balance */}
        <div style={{padding:"16px 20px",borderTop:"1px solid #1a1a1a"}}>
          <div style={{fontSize:9,color:"#333",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>SOL Balance</div>
          <LiveSolBalance/>
          <div style={{display:"flex",alignItems:"center",gap:6,marginTop:10}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:"#30d158"}}/>
            <span style={{fontSize:10,color:"#30d158"}}>Live</span>
          </div>
        </div>
      </div>

      {/* MAIN */}
      <div style={{marginLeft:"clamp(180px,16vw,220px)",flex:1,display:"flex",flexDirection:"column",minWidth:0,overflowX:"hidden"}}>
        <Ticker/>

        {/* Header */}
        <div style={{padding:"20px 28px 0",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div>
            <div style={{fontSize:22,fontWeight:700,color:"#fff",letterSpacing:-0.5}}>
              {NAV.find(n=>n.id===page)?.label}
            </div>
            <div style={{fontSize:12,color:"#333",marginTop:2}}>
              {new Date().toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}
            </div>
          </div>
          <button onClick={addToast} style={{padding:"7px 16px",borderRadius:20,background:"#f5a62318",
            border:"1px solid #f5a62333",color:"#f5a623",fontSize:11,cursor:"pointer"}}>
            🔔 Test Alert
          </button>
        </div>

        {/* Page */}
        <div style={{padding:"clamp(12px,2vw,24px)",overflowX:"hidden"}}>
          {page==="portfolio" && <Portfolio/>}
          {page==="trades"    && <Trades/>}
          {page==="wallets"   && <Wallets/>}
          {page==="tax"       && <Tax/>}
          {page==="settings"  && <Settings onLock={()=>setUnlocked(false)} notificationsOn={notificationsOn} setNotificationsOn={setNotificationsOn} currency={currency} setCurrency={setCurrency}/>}
        </div>
      </div>
    </div>
  );
}

export default function App(){
  return(
    <LiveDataProvider>
      <AppContent/>
    </LiveDataProvider>
  );
}
