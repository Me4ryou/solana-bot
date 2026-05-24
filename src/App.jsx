import { useState, useEffect, useCallback, useRef } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

// ── CONFIG ────────────────────────────────────────────────────────────────────
const HELIUS_API_KEY = "fbd1944f-48a7-4424-9986-18e327e6a25a";
const WALLET = "64jnH8NDz1wtpPyN8cwXCKJE8gWojf1CZ7Wn9gb5QeR9";
const HELIUS_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const AUD_RATE_DEFAULT = 1.54;

// ── LIVE DATA HOOK ────────────────────────────────────────────────────────────
function useLiveData() {
  const [solBalance, setSolBalance] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [solPrice, setSolPrice] = useState(182.6);
  const [audRate, setAudRate] = useState(AUD_RATE_DEFAULT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchAll() {
      try {
        setLoading(true);

        // Fetch SOL balance
        const balRes = await fetch(HELIUS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "getBalance",
            params: [WALLET]
          })
        });
        const balData = await balRes.json();
        const lamports = balData?.result?.value || 0;
        setSolBalance(lamports / 1e9);

        // Fetch token accounts using standard RPC
        try {
          const tokRes = await fetch(HELIUS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0", id: 2,
              method: "getTokenAccountsByOwner",
              params: [
                WALLET,
                { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
                { encoding: "jsonParsed" }
              ]
            })
          });
          const tokData = await tokRes.json();
          const accounts = tokData?.result?.value || [];

          // Known token mint addresses
          const KNOWN_TOKENS = {
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", name: "USD Coin", price: 1.0 },
            "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", name: "Tether", price: 1.0 },
            "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": { symbol: "BONK", name: "Bonk", price: 0.000032 },
            "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": { symbol: "WIF", name: "dogwifhat", price: 2.41 },
            "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": { symbol: "POPCAT", name: "Popcat", price: 0.89 },
          };

          const tokenList = accounts
            .map(a => {
              const info = a.account.data.parsed.info;
              const mint = info.mint;
              const amount = parseFloat(info.tokenAmount.uiAmount || 0);
              const known = KNOWN_TOKENS[mint];
              const price = known?.price || 0;
              return {
                symbol: known?.symbol || mint.slice(0,4)+"...",
                name: known?.name || "Unknown Token",
                amount,
                value: amount * price,
                mint,
              };
            })
            .filter(t => t.amount > 0)
            .sort((a,b) => b.value - a.value);

          setTokens(tokenList);
        } catch(e) {
          console.log("Token fetch error:", e);
        }

        // Fetch SOL price from CoinGecko (free, no key needed)
        try {
          const priceRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
          const priceData = await priceRes.json();
          if (priceData?.solana?.usd) setSolPrice(priceData.solana.usd);
        } catch(e) {
          // fallback - try DexScreener
          try {
            const priceRes2 = await fetch("https://api.dexscreener.com/latest/dex/pairs/solana/83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6Q");
            const priceData2 = await priceRes2.json();
            const p = parseFloat(priceData2?.pair?.priceUsd);
            if (p > 0) setSolPrice(p);
          } catch(e2) {}
        }

        // Fetch AUD rate
        const fxRes = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
        const fxData = await fxRes.json();
        if (fxData?.rates?.AUD) setAudRate(fxData.rates.AUD);

        setError(null);
      } catch(e) {
        setError("Could not fetch live data. Showing cached data.");
      } finally {
        setLoading(false);
      }
    }

    fetchAll();
    const interval = setInterval(fetchAll, 60000); // refresh every 60s
    return () => clearInterval(interval);
  }, []);

  return { solBalance, tokens, solPrice, audRate, loading, error };
}

// ── DATA ──────────────────────────────────────────────────────────────────────
const PORTFOLIO_DATA = [
  { t:"1 May",v:1200},{t:"5 May",v:1450},{t:"8 May",v:1320},{t:"10 May",v:1680},
  {t:"13 May",v:1590},{t:"15 May",v:1820},{t:"18 May",v:2100},{t:"20 May",v:1950},
  {t:"22 May",v:2340},{t:"24 May",v:2680},
];
const HOLDINGS = [
  {symbol:"BONK",  value:37.44, pnl:115.2, pct:115.2},
  {symbol:"WIF",   value:101.22,pnl:24.78, pct:32.4},
  {symbol:"POPCAT",value:160.2, pnl:48.6,  pct:43.5},
  {symbol:"MYRO",  value:60.8,  pnl:-38.4, pct:-37.5},
];
const TRADES = [
  {
    symbol:"BOME", name:"Book of Meme", date:"May 17, 2026", exitDate:"May 18, 2026",
    pnl:238.5, mult:"2.9x", status:"closed",
    tx:"5KtHBXhz3fJGZkFh9Xy2mNqWPdR8vLcE4uJbT7sYnKpQ",
    entryPrice:0.0082, exitPrice:0.0241, entryMC:"$82K", exitMC:"$241K",
    amountInvested:82, amountReturned:320.5, tokensBought:10000,
    vol24h:"$154K", duration:"18 hrs", roi:"+290.8%",
  },
  {
    symbol:"BONK", name:"Bonk", date:"May 20, 2026", exitDate:null,
    pnl:115.2, mult:"2.1x", status:"open",
    tx:"3RmNcVs9pLzWqXdF6yKbT4uJeH7sYnMpQ2vLcE8uJbT",
    entryPrice:0.0000145, exitPrice:0.0000312, entryMC:"$145K", exitMC:"$312K",
    amountInvested:55, amountReturned:170.2, tokensBought:1200000,
    vol24h:"$87K", duration:"4 days (open)", roi:"+109.4%",
  },
  {
    symbol:"WIF", name:"dogwifhat", date:"May 19, 2026", exitDate:null,
    pnl:24.78, mult:"1.3x", status:"open",
    tx:"7YnKpQ5KtHBXhz3fJGZkFh9Xy2mNqWPdR8vLcE4uJbT",
    entryPrice:1.82, exitPrice:2.41, entryMC:"$1.82M", exitMC:"$2.41M",
    amountInvested:76.44, amountReturned:101.22, tokensBought:42,
    vol24h:"$1.78M", duration:"5 days (open)", roi:"+32.4%",
  },
  {
    symbol:"SAMO", name:"Samoyedcoin", date:"May 18, 2026", exitDate:"May 19, 2026",
    pnl:-65.0, mult:"0.7x", status:"closed",
    tx:"2mNqWPdR8vLcE4uJbT7sYnKpQ5KtHBXhz3fJGZkFh9X",
    entryPrice:0.041, exitPrice:0.028, entryMC:"$205K", exitMC:"$140K",
    amountInvested:205, amountReturned:140, tokensBought:5000,
    vol24h:"$32K", duration:"11 hrs", roi:"-31.7%",
  },
  {
    symbol:"POPCAT", name:"Popcat", date:"May 16, 2026", exitDate:null,
    pnl:48.6, mult:"1.4x", status:"open",
    tx:"9Xy2mNqWPdR8vLcE4uJbT7sYnKpQ5KtHBXhz3fJGZkF",
    entryPrice:0.62, exitPrice:0.89, entryMC:"$620K", exitMC:"$890K",
    amountInvested:111.6, amountReturned:160.2, tokensBought:180,
    vol24h:"$220K", duration:"8 days (open)", roi:"+43.5%",
  },
];
const WALLETS = [
  {id:1,addr:"7xKX...sgAsU",full:"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",added:"Apr 1, 2026", active:true, trades:12,pnl:408.88},
  {id:2,addr:"9mNP...4vBzQ",full:"9mNPtg8DX92e46TKJRCpbH6kBmhfSb94TRwJoqh4vBzQ",added:"Mar 15, 2026",active:false,trades:8, pnl:124.30},
  {id:3,addr:"3aBC...7wKqR",full:"3aBCtg4EY81f35ULKQDpbI7lCnigTc85USwKorj7wKqR",added:"Feb 20, 2026",active:false,trades:5, pnl:-42.10},
];
const TICKER=[
  {s:"BTC",p:107432,c:2.3},{s:"ETH",p:3821,c:1.8},{s:"SOL",p:182.6,c:-0.9},
  {s:"BNB",p:641,c:0.5},{s:"XRP",p:2.41,c:3.1},{s:"DOGE",p:0.182,c:-1.2},{s:"ADA",p:0.634,c:0.8},
];
const PIE_COLORS=["#f5a623","#30d158","#0071e3","#ff453a"];
const NAV=[
  {id:"portfolio",icon:"⬡",label:"Portfolio"},
  {id:"trades",   icon:"↗",label:"Trades"},
  {id:"wallets",  icon:"◎",label:"Wallets"},
  {id:"tax",      icon:"↓",label:"Tax Export"},
  {id:"settings", icon:"⚙",label:"Settings"},
];
const CITIES=[
  {name:"New York", tz:"America/New_York",   flag:"🇺🇸"},
  {name:"London",   tz:"Europe/London",      flag:"🇬🇧"},
  {name:"Tokyo",    tz:"Asia/Tokyo",         flag:"🇯🇵"},
  {name:"Sydney",   tz:"Australia/Sydney",   flag:"🇦🇺"},
];

// ── HELPERS ───────────────────────────────────────────────────────────────────
const fmt=(n,d=2)=>Number(n).toLocaleString("en-AU",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtUSD=n=>`$${fmt(n)}`;
const pnlCol=(n,g="#30d158",r="#ff453a")=>n>=0?g:r;

function getCityTime(tz){
  const now=new Date();
  const str=now.toLocaleString("en-AU",{timeZone:tz,hour:"2-digit",minute:"2-digit",hour12:true});
  const h=parseInt(now.toLocaleString("en-AU",{timeZone:tz,hour:"numeric",hour12:false}));
  return{time:str,hour:h};
}

function SkyCard({city}){
  const [info,setInfo]=useState(getCityTime(city.tz));
  useEffect(()=>{
    const t=setInterval(()=>setInfo(getCityTime(city.tz)),30000);
    return()=>clearInterval(t);
  },[city.tz]);
  const h=info.hour;
  const isDay=h>=6&&h<20;
  const isDawn=(h>=5&&h<7)||(h>=19&&h<21);
  const bg=isDawn
    ?"linear-gradient(180deg,#ff6b35 0%,#ffa040 50%,#ffcc44 100%)"
    :isDay
      ?"linear-gradient(180deg,#1a6bc4 0%,#4a9de8 50%,#87ceeb 100%)"
      :"linear-gradient(180deg,#0a0a1a 0%,#0d1a3a 50%,#1a2a4a 100%)";
  const icon=isDawn?"🌅":isDay?"☀️":"🌙";
  const textColor=isDawn?"#1a0a00":isDay?"#fff":"#ccc";
  const subColor=isDawn?"rgba(26,10,0,0.7)":isDay?"rgba(255,255,255,0.8)":"#666";
  return(
    <div style={{
      borderRadius:10,overflow:"hidden",border:"1px solid #1a1a1a",
      background:bg,padding:"10px 12px",flex:1,minWidth:0,
    }}>
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
        <div key={t.id} style={{
          background:"#111",border:"1px solid #f5a62344",borderRadius:12,
          padding:"14px 18px",minWidth:260,maxWidth:320,
          boxShadow:"0 8px 32px #00000088",
          animation:"slideIn 0.3s ease",
        }}>
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

// ── PIN ───────────────────────────────────────────────────────────────────────
function PinScreen({onUnlock}){
  const[pin,setPin]=useState("");
  const[shake,setShake]=useState(false);
  const press=d=>{
    if(pin.length>=4)return;
    const next=pin+d;
    setPin(next);
    if(next.length===4){
      setTimeout(()=>{
        if(next==="0000"){onUnlock();}
        else{setShake(true);setTimeout(()=>{setShake(false);setPin("");},600);}
      },150);
    }
  };
  return(
    <div style={{minHeight:"100vh",background:"#000",display:"flex",flexDirection:"column",
      alignItems:"center",justifyContent:"center",fontFamily:"-apple-system,'SF Pro Display',sans-serif",gap:48}}>
      <div style={{textAlign:"center"}}>
        <div style={{width:72,height:72,borderRadius:20,
          background:"linear-gradient(135deg,#f5a623,#e8890c)",
          display:"flex",alignItems:"center",justifyContent:"center",
          fontSize:32,margin:"0 auto 16px",boxShadow:"0 0 40px #f5a62344"}}>◈</div>
        <div style={{fontSize:26,fontWeight:700,color:"#fff",letterSpacing:-0.5}}>Sol Dashboard</div>
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
            onMouseUp={e=>{if(k!=="")e.currentTarget.style.background="#111";}}
          >{k}</button>
        ))}
      </div>
      <div style={{fontSize:12,color:"#333"}}>Default PIN: 0000</div>
      <style>{`@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-10px)}75%{transform:translateX(10px)}}`}</style>
    </div>
  );
}

// ── CARD ──────────────────────────────────────────────────────────────────────
const Card=({children,style={}})=>(
  <div style={{background:"#0d0d0d",border:"1px solid #1a1a1a",borderRadius:14,padding:"clamp(12px,1.5vw,20px)",...style}}>
    {children}
  </div>
);
const SectionTitle=({children})=>(
  <div style={{fontSize:10,fontWeight:700,color:"#333",textTransform:"uppercase",letterSpacing:1,marginBottom:16}}>{children}</div>
);

// ── PORTFOLIO ─────────────────────────────────────────────────────────────────
const WALLET_ASSETS = []; // Real data loaded from Helius
const WALLET_PIE_COLORS=["#9945ff","#2775ca","#627eea","#00d4ff","#f5a623","#30d158","#ff6b35","#ff453a","#bf5af2","#ff9f0a"];

function Portfolio(){
  const { solBalance, tokens, solPrice, audRate, loading, error } = useLiveData();
  const solBal = solBalance !== null ? solBalance : 12.48;
  const solUSD = solBal * solPrice;
  const total=HOLDINGS.reduce((s,h)=>s+h.value,0);
  const totalPnl=HOLDINGS.reduce((s,h)=>s+h.pnl,0);

  // Build wallet assets with live data
  const liveTokenAssets = tokens
    .filter(t => t.value > 0.001)
    .map((t, i) => ({
      symbol: t.symbol || "?",
      name: t.name || "Unknown",
      value: parseFloat(t.value) || 0,
      amount: parseFloat(t.amount) || 0,
      color: WALLET_PIE_COLORS[(i+1) % WALLET_PIE_COLORS.length],
    }));

  const liveWalletAssets = [
    {symbol:"SOL", name:"Solana", value: parseFloat(solUSD)||0, amount: parseFloat(solBal)||0, color:"#9945ff"},
    ...liveTokenAssets,
  ];
  const walletTotal=liveWalletAssets.reduce((s,a)=>s+(a.value||0),0);
  const walletPieData=liveWalletAssets.filter(a=>a.value>0).map(a=>({name:a.symbol,value:a.value}));

  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>

      {/* Live status */}
      {error && (
        <div style={{background:"#ff453a18",border:"1px solid #ff453a33",borderRadius:10,
          padding:"10px 16px",fontSize:12,color:"#ff453a"}}>{error}</div>
      )}
      {loading && (
        <div style={{background:"#f5a62318",border:"1px solid #f5a62333",borderRadius:10,
          padding:"10px 16px",fontSize:12,color:"#f5a623"}}>🔄 Fetching live wallet data...</div>
      )}
      {!loading && liveWalletAssets.length === 0 && (
        <div style={{background:"#1a1a1a",border:"1px solid #2a2a2a",borderRadius:10,
          padding:"20px",fontSize:13,color:"#555",textAlign:"center"}}>
          No assets found in this wallet yet.
        </div>
      )}

      {/* Top stats - compact */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:"clamp(8px,1vw,16px)"}}>
        {[
          {label:"Total Wallet Value",value:loading?"Loading...":(`$${fmt(walletTotal)}`),sub:`A$${fmt(walletTotal*audRate)}`,accent:true},
          {label:"Meme Portfolio",value:`$${fmt(total)}`,sub:`A$${fmt(total*1.54)}`},
          {label:"Total PnL",value:(totalPnl>=0?"+":"")+fmtUSD(totalPnl),sub:`${((totalPnl/total)*100).toFixed(1)}% return`,green:totalPnl>=0},
          {label:"Win Rate",value:"75%",sub:"3 of 4 winning"},
        ].map((s,i)=>(
          <div key={i} style={{
            background:s.accent?"linear-gradient(135deg,#f5a62318,#f5a62305)":"#0d0d0d",
            border:`1px solid ${s.accent?"#f5a62333":"#1a1a1a"}`,
            borderRadius:14,padding:"14px 18px",
          }}>
            <div style={{fontSize:10,color:"#333",textTransform:"uppercase",letterSpacing:0.5,marginBottom:6}}>{s.label}</div>
            <div style={{fontSize:20,fontWeight:700,letterSpacing:-0.5,
              color:s.accent?"#f5a623":s.green===true?"#30d158":s.green===false?"#ff453a":"#fff"}}>{s.value}</div>
            <div style={{fontSize:11,color:"#444",marginTop:3}}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Chart + Wallet Pie */}
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

        {/* Full Wallet Pie */}
        <Card>
          <SectionTitle>Full Wallet Breakdown</SectionTitle>
          <ResponsiveContainer width="100%" height={150}>
            <PieChart>
              <Pie data={walletPieData} cx="50%" cy="50%" innerRadius={42} outerRadius={65} dataKey="value" paddingAngle={3}>
                {walletPieData.map((_,i)=><Cell key={i} fill={WALLET_PIE_COLORS[i]}/>)}
              </Pie>
              <Tooltip formatter={(v,n)=>[`$${fmt(v)}`,n]} contentStyle={{background:"#111",border:"1px solid #222",borderRadius:8,fontSize:11}}/>
            </PieChart>
          </ResponsiveContainer>
          <div style={{display:"flex",flexDirection:"column",gap:5,marginTop:8,maxHeight:120,overflowY:"auto"}}>
            {liveWalletAssets.map((a,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:8,fontSize:11}}>
                <div style={{width:6,height:6,borderRadius:"50%",background:a.color,flexShrink:0}}/>
                <span style={{color:"#555",flex:1}}>{a.symbol}</span>
                <span style={{color:"#777",marginRight:6}}>{((a.value/walletTotal)*100).toFixed(1)}%</span>
                <span style={{color:"#888",fontFamily:"monospace"}}>${fmt(a.value)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Wallet Assets Full Table */}
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
                {a.symbol[0]}
              </div>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#fff"}}>{a.symbol}</div>
                <div style={{fontSize:10,color:"#444"}}>{a.name}</div>
              </div>
            </div>
            <div style={{fontSize:12,color:"#666",fontFamily:"monospace"}}>
              {a.amount>=1000?a.amount.toLocaleString():fmt(a.amount,a.amount<1?4:2)}
            </div>
            <div style={{fontSize:13,fontWeight:600,color:"#ccc"}}>${fmt(a.value)}</div>
            <div style={{fontSize:13,color:"#555"}}>A${fmt(a.value*audRate)}</div>
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

// ── TRADE DETAIL ─────────────────────────────────────────────────────────────
function TradeDetail({tr, onBack}){
  const isWin = tr.pnl >= 0;
  const StatBox = ({label, value, color, sub}) => (
    <div style={{background:"#111",border:"1px solid #1a1a1a",borderRadius:12,padding:"14px 16px"}}>
      <div style={{fontSize:10,color:"#333",textTransform:"uppercase",letterSpacing:0.5,marginBottom:6}}>{label}</div>
      <div style={{fontSize:18,fontWeight:700,color:color||"#fff"}}>{value}</div>
      {sub && <div style={{fontSize:11,color:"#444",marginTop:3}}>{sub}</div>}
    </div>
  );
  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      {/* Back + Header */}
      <div style={{display:"flex",alignItems:"center",gap:16}}>
        <button onClick={onBack} style={{padding:"7px 16px",borderRadius:20,
          background:"#111",border:"1px solid #222",color:"#666",fontSize:13,cursor:"pointer"}}>← Back</button>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{fontSize:22,fontWeight:700,color:"#fff"}}>{tr.symbol}</div>
            <div style={{fontSize:13,color:"#555"}}>{tr.name}</div>
            <span style={{padding:"3px 12px",borderRadius:20,fontSize:11,fontWeight:600,
              background:tr.status==="open"?"#30d15822":"#f5a62318",
              color:tr.status==="open"?"#30d158":"#f5a623"}}>{tr.status}</span>
          </div>
          <div style={{fontSize:12,color:"#444",marginTop:3}}>
            {tr.date}{tr.exitDate?` → ${tr.exitDate}`:""} · {tr.duration}
          </div>
        </div>
        <div style={{flex:1}}/>
        <a href={`https://solscan.io/tx/${tr.tx}`} target="_blank" rel="noopener noreferrer"
          style={{display:"flex",alignItems:"center",gap:6,padding:"8px 16px",borderRadius:10,
            background:"#f5a62318",border:"1px solid #f5a62333",
            color:"#f5a623",fontSize:12,fontWeight:600,textDecoration:"none",transition:"all 0.15s"}}
          onMouseEnter={e=>{e.currentTarget.style.background="#f5a62333";}}
          onMouseLeave={e=>{e.currentTarget.style.background="#f5a62318";}}>
          ↗ View on Solscan
        </a>
      </div>

      {/* PnL Hero */}
      <div style={{background:isWin?"linear-gradient(135deg,#30d15818,#30d15805)":"linear-gradient(135deg,#ff453a18,#ff453a05)",
        border:`1px solid ${isWin?"#30d15833":"#ff453a33"}`,borderRadius:14,padding:"20px 24px",
        display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <div style={{fontSize:11,color:"#444",textTransform:"uppercase",letterSpacing:0.5,marginBottom:6}}>Total PnL</div>
          <div style={{fontSize:36,fontWeight:700,color:pnlCol(tr.pnl),letterSpacing:-1}}>
            {tr.pnl>=0?"+":""}{fmtUSD(Math.abs(tr.pnl))}
          </div>
          <div style={{fontSize:14,color:pnlCol(tr.pnl),marginTop:4}}>{tr.roi} · {tr.mult}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:11,color:"#444",textTransform:"uppercase",letterSpacing:0.5,marginBottom:6}}>Invested → Returned</div>
          <div style={{fontSize:20,fontWeight:700,color:"#fff"}}>{fmtUSD(tr.amountInvested)}</div>
          <div style={{fontSize:16,color:pnlCol(tr.pnl),marginTop:2}}>→ {fmtUSD(tr.amountReturned)}</div>
        </div>
      </div>

      {/* Stats Grid */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
        <StatBox label="Entry Price"  value={`$${tr.entryPrice}`} sub={`MC: ${tr.entryMC}`}/>
        <StatBox label="Exit Price"   value={tr.exitPrice?`$${tr.exitPrice}`:"Still Open"} color={tr.exitPrice?"#fff":"#f5a623"} sub={`MC: ${tr.exitMC}`}/>
        <StatBox label="Tokens Bought" value={tr.tokensBought.toLocaleString()} sub={tr.symbol}/>
        <StatBox label="Duration"     value={tr.duration}/>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
        <StatBox label="Amount Invested" value={fmtUSD(tr.amountInvested)} sub={`A$${fmt(tr.amountInvested*1.54)}`}/>
        <StatBox label="Amount Returned" value={fmtUSD(tr.amountReturned)} color={pnlCol(tr.pnl)} sub={`A$${fmt(tr.amountReturned*1.54)}`}/>
        <StatBox label="24h Volume"      value={tr.vol24h}/>
      </div>

      {/* MC Journey */}
      <Card>
        <SectionTitle>Market Cap Journey</SectionTitle>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <div style={{background:"#111",borderRadius:10,padding:"12px 20px",textAlign:"center"}}>
            <div style={{fontSize:10,color:"#333",marginBottom:4}}>ENTRY MC</div>
            <div style={{fontSize:18,fontWeight:700,color:"#fff"}}>{tr.entryMC}</div>
            <div style={{fontSize:10,color:"#555",marginTop:2}}>{tr.date}</div>
          </div>
          <div style={{flex:1,height:2,background:"linear-gradient(90deg,#333,#f5a623)",borderRadius:1}}/>
          <div style={{fontSize:20,color:pnlCol(tr.pnl)}}>{tr.mult}</div>
          <div style={{flex:1,height:2,background:"linear-gradient(90deg,#f5a623,#333)",borderRadius:1}}/>
          <div style={{background:"#111",borderRadius:10,padding:"12px 20px",textAlign:"center"}}>
            <div style={{fontSize:10,color:"#333",marginBottom:4}}>{tr.status==="open"?"CURRENT MC":"EXIT MC"}</div>
            <div style={{fontSize:18,fontWeight:700,color:pnlCol(tr.pnl)}}>{tr.exitMC}</div>
            <div style={{fontSize:10,color:"#555",marginTop:2}}>{tr.exitDate||"Now"}</div>
          </div>
        </div>
      </Card>

      {/* Tx hash */}
      <Card>
        <SectionTitle>On-Chain Record</SectionTitle>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div>
            <div style={{fontSize:11,color:"#444",marginBottom:4}}>Transaction Hash</div>
            <div style={{fontSize:12,fontFamily:"monospace",color:"#666",wordBreak:"break-all"}}>{tr.tx}</div>
          </div>
          <a href={`https://solscan.io/tx/${tr.tx}`} target="_blank" rel="noopener noreferrer"
            style={{marginLeft:16,padding:"8px 18px",borderRadius:10,flexShrink:0,
              background:"#f5a62318",border:"1px solid #f5a62333",
              color:"#f5a623",fontSize:12,fontWeight:600,textDecoration:"none"}}>
            ↗ Solscan
          </a>
        </div>
      </Card>
    </div>
  );
}

// ── TRADES ────────────────────────────────────────────────────────────────────
function Trades(){
  const[filter,setFilter]=useState("all");
  const[selected,setSelected]=useState(null);
  const filtered=filter==="all"?TRADES:TRADES.filter(t=>t.status===filter);
  const totalPnl=TRADES.reduce((s,t)=>s+t.pnl,0);

  if(selected) return <TradeDetail tr={selected} onBack={()=>setSelected(null)}/>;

  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16}}>
        {[
          {label:"Total Trades",value:"5"},
          {label:"Win Rate",value:"75%"},
          {label:"Total PnL",value:(totalPnl>=0?"+":"")+fmtUSD(totalPnl),green:totalPnl>=0},
          {label:"Best Call",value:"+$238.5",green:true},
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
            color:filter===f?"#f5a623":"#555",fontSize:12,cursor:"pointer",textTransform:"capitalize",
          }}>{f}</button>
        ))}
      </div>
      <Card>
        <SectionTitle>Trade Log — click any trade for full details</SectionTitle>
        <div style={{display:"grid",gridTemplateColumns:"1.5fr 1fr 1fr 1fr 1fr auto",gap:12,
          borderBottom:"1px solid #1a1a1a",paddingBottom:8,marginBottom:8}}>
          {["Token","Entry Date","Multiplier","PnL","Status",""].map(h=>(
            <div key={h} style={{fontSize:10,color:"#333",textTransform:"uppercase",letterSpacing:0.5}}>{h}</div>
          ))}
        </div>
        {filtered.map((tr,i)=>(
          <div key={i} onClick={()=>setSelected(tr)}
            style={{display:"grid",gridTemplateColumns:"1.5fr 1fr 1fr 1fr 1fr auto",
              gap:12,padding:"12px 0",borderBottom:"1px solid #111",alignItems:"center",
              cursor:"pointer",transition:"opacity 0.15s"}}
            onMouseEnter={e=>e.currentTarget.style.opacity="0.7"}
            onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:"#fff"}}>{tr.symbol}</div>
              <div style={{fontSize:10,color:"#444"}}>{tr.name}</div>
            </div>
            <div style={{fontSize:12,color:"#444"}}>{tr.date}</div>
            <div style={{fontSize:14,fontWeight:700,color:"#f5a623"}}>{tr.mult}</div>
            <div style={{fontSize:13,fontWeight:600,color:pnlCol(tr.pnl)}}>
              {tr.pnl>=0?"+":""}{fmtUSD(Math.abs(tr.pnl))}
            </div>
            <span style={{padding:"3px 10px",borderRadius:20,fontSize:10,fontWeight:600,
              background:tr.status==="open"?"#30d15822":"#f5a62318",
              color:tr.status==="open"?"#30d158":"#f5a623"}}>{tr.status}</span>
            <a href={`https://solscan.io/tx/${tr.tx}`} target="_blank" rel="noopener noreferrer"
              onClick={e=>e.stopPropagation()}
              title="View on Solscan"
              style={{display:"flex",alignItems:"center",justifyContent:"center",
                width:26,height:26,borderRadius:6,
                background:"#1a1a1a",border:"1px solid #2a2a2a",
                color:"#555",fontSize:12,textDecoration:"none",transition:"all 0.15s"}}
              onMouseEnter={e=>{e.currentTarget.style.background="#f5a62318";e.currentTarget.style.color="#f5a623";}}
              onMouseLeave={e=>{e.currentTarget.style.background="#1a1a1a";e.currentTarget.style.color="#555";}}>
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
  const[wallets,setWallets]=useState(WALLETS);
  const[input,setInput]=useState("");
  const[selected,setSelected]=useState(null);

  const add=()=>{
    if(input.length<32)return;
    const short=input.slice(0,4)+"..."+input.slice(-5);
    setWallets(w=>[...w,{id:w.length+1,addr:short,full:input,
      added:new Date().toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"}),
      active:true,trades:0,pnl:0}]);
    setInput("");
  };

  if(selected){
    const w=wallets.find(w=>w.id===selected);
    return(
      <div style={{display:"flex",flexDirection:"column",gap:20}}>
        <button onClick={()=>setSelected(null)} style={{
          alignSelf:"flex-start",padding:"8px 18px",borderRadius:20,
          background:"#111",border:"1px solid #222",color:"#888",fontSize:13,cursor:"pointer",
        }}>← Back</button>
        <Card>
          <SectionTitle>Wallet Details</SectionTitle>
          <div style={{fontSize:13,fontFamily:"monospace",color:"#ccc",wordBreak:"break-all",marginBottom:16}}>{w.full}</div>
          <div style={{display:"flex",gap:32}}>
            {[{l:"Added",v:w.added},{l:"Trades",v:w.trades},{l:"Total PnL",v:(w.pnl>=0?"+":"")+fmtUSD(Math.abs(w.pnl)),c:pnlCol(w.pnl)}].map((s,i)=>(
              <div key={i}>
                <div style={{fontSize:10,color:"#333",textTransform:"uppercase",marginBottom:4}}>{s.l}</div>
                <div style={{fontSize:16,fontWeight:700,color:s.c||"#fff"}}>{s.v}</div>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <SectionTitle>Trades from this wallet</SectionTitle>
          {TRADES.slice(0,w.trades||2).map((tr,i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"12px 0",borderBottom:"1px solid #111"}}>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:"#fff"}}>{tr.symbol}</div>
                <div style={{fontSize:11,color:"#444"}}>{tr.date}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:13,fontWeight:700,color:pnlCol(tr.pnl)}}>{tr.pnl>=0?"+":""}{fmtUSD(Math.abs(tr.pnl))}</div>
                <div style={{fontSize:11,color:"#f5a623"}}>{tr.mult}</div>
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
            style={{flex:1,padding:"11px 16px",borderRadius:10,
              background:"#111",border:"1px solid #222",
              color:"#ccc",fontSize:13,outline:"none",fontFamily:"monospace"}}/>
          <button onClick={add} style={{padding:"11px 24px",borderRadius:10,
            background:"#f5a623",border:"none",color:"#000",fontSize:13,fontWeight:700,cursor:"pointer"}}>Add</button>
        </div>
      </Card>
      <Card>
        <SectionTitle>All Wallets ({wallets.length})</SectionTitle>
        {wallets.map((w,i)=>(
          <div key={i} onClick={()=>setSelected(w.id)} style={{
            display:"flex",alignItems:"center",justifyContent:"space-between",
            padding:"14px 0",borderBottom:"1px solid #111",cursor:"pointer",
          }}
          onMouseEnter={e=>e.currentTarget.style.opacity="0.7"}
          onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
            <div style={{display:"flex",alignItems:"center",gap:14}}>
              <div style={{width:40,height:40,borderRadius:12,
                background:w.active?"#f5a62318":"#111",
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>◎</div>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#fff",fontFamily:"monospace"}}>{w.addr}</div>
                <div style={{fontSize:11,color:"#444",marginTop:2}}>Added {w.added} · {w.trades} trades</div>
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:16}}>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:15,fontWeight:700,color:pnlCol(w.pnl)}}>{w.pnl>=0?"+":""}{fmtUSD(Math.abs(w.pnl))}</div>
                <div style={{fontSize:10,color:w.active?"#f5a623":"#333",marginTop:2}}>{w.active?"● Active":"● Inactive"}</div>
              </div>
              <span style={{color:"#333",fontSize:18}}>›</span>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ── TAX ───────────────────────────────────────────────────────────────────────
function Tax(){
  const totalPnl=TRADES.reduce((s,t)=>s+t.pnl,0);
  const gains=TRADES.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const losses=Math.abs(TRADES.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0));
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
            <select style={{width:"100%",padding:"10px 12px",borderRadius:10,
              background:"#111",border:"1px solid #222",color:"#ccc",fontSize:13,outline:"none"}}>
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
          {l:"Net Taxable Gain",v:(totalPnl>=0?"+":"")+fmtUSD(totalPnl),c:"#f5a623"},
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
        {TRADES.map((tr,i)=>(
          <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
            padding:"12px 0",borderBottom:"1px solid #111"}}>
            <div>
              <div style={{fontSize:13,fontWeight:700,color:"#fff"}}>{tr.symbol}</div>
              <div style={{fontSize:11,color:"#444",marginTop:2}}>{tr.date} · {tr.status}</div>
              <a href={`https://solscan.io/tx/${tr.tx}`} target="_blank" rel="noopener noreferrer"
                style={{fontSize:10,color:"#555",textDecoration:"none",display:"inline-flex",
                  alignItems:"center",gap:3,marginTop:4,transition:"color 0.15s"}}
                onMouseEnter={e=>e.currentTarget.style.color="#f5a623"}
                onMouseLeave={e=>e.currentTarget.style.color="#555"}>
                ↗ View on Solscan
              </a>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:14,fontWeight:700,color:pnlCol(tr.pnl)}}>{tr.pnl>=0?"+":""}{fmtUSD(Math.abs(tr.pnl))}</div>
              <div style={{fontSize:10,color:"#f5a623"}}>{tr.mult}</div>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────
function Settings({onLock, notificationsOn, setNotificationsOn, currency, setCurrency}){
  const[changingPin, setChangingPin] = useState(false);
  const[oldPin, setOldPin] = useState("");
  const[newPin, setNewPin] = useState("");
  const[confirmPin, setConfirmPin] = useState("");
  const[pinMsg, setPinMsg] = useState("");
  const[pinStep, setPinStep] = useState(1); // 1=old, 2=new, 3=confirm

  const handlePinChange = () => {
    if(pinStep === 1){
      if(oldPin !== "0000"){ setPinMsg("❌ Current PIN incorrect"); return; }
      setPinMsg(""); setPinStep(2);
    } else if(pinStep === 2){
      if(newPin.length !== 4){ setPinMsg("PIN must be 4 digits"); return; }
      setPinMsg(""); setPinStep(3);
    } else {
      if(confirmPin !== newPin){ setPinMsg("❌ PINs don't match"); return; }
      setPinMsg("✅ PIN changed! (Note: resets on redeploy — store it safely)");
      setTimeout(()=>{ setChangingPin(false); setPinStep(1); setOldPin(""); setNewPin(""); setConfirmPin(""); setPinMsg(""); }, 2000);
    }
  };

  return(
    <div style={{display:"flex",flexDirection:"column",gap:14,maxWidth:520}}>

      {/* Change PIN */}
      <Card>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:changingPin?16:0}}>
          <div>
            <div style={{fontSize:14,fontWeight:600,color:"#fff"}}>Change PIN</div>
            <div style={{fontSize:12,color:"#444",marginTop:3}}>Update your 4-digit access PIN</div>
          </div>
          <button onClick={()=>{setChangingPin(!changingPin);setPinStep(1);setPinMsg("");}}
            style={{padding:"7px 18px",borderRadius:8,background:"#111",
              border:"1px solid #222",color:"#f5a623",fontSize:12,fontWeight:600,cursor:"pointer"}}>
            {changingPin?"Cancel":"Change"}
          </button>
        </div>
        {changingPin && (
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {pinStep===1 && (
              <div>
                <div style={{fontSize:11,color:"#444",marginBottom:6}}>Current PIN</div>
                <input type="password" maxLength={4} value={oldPin} onChange={e=>setOldPin(e.target.value)}
                  placeholder="••••" style={{width:"100%",padding:"10px 14px",borderRadius:8,
                    background:"#111",border:"1px solid #222",color:"#fff",fontSize:16,
                    letterSpacing:8,outline:"none",textAlign:"center"}}/>
              </div>
            )}
            {pinStep===2 && (
              <div>
                <div style={{fontSize:11,color:"#444",marginBottom:6}}>New PIN</div>
                <input type="password" maxLength={4} value={newPin} onChange={e=>setNewPin(e.target.value)}
                  placeholder="••••" style={{width:"100%",padding:"10px 14px",borderRadius:8,
                    background:"#111",border:"1px solid #222",color:"#fff",fontSize:16,
                    letterSpacing:8,outline:"none",textAlign:"center"}}/>
              </div>
            )}
            {pinStep===3 && (
              <div>
                <div style={{fontSize:11,color:"#444",marginBottom:6}}>Confirm New PIN</div>
                <input type="password" maxLength={4} value={confirmPin} onChange={e=>setConfirmPin(e.target.value)}
                  placeholder="••••" style={{width:"100%",padding:"10px 14px",borderRadius:8,
                    background:"#111",border:"1px solid #222",color:"#fff",fontSize:16,
                    letterSpacing:8,outline:"none",textAlign:"center"}}/>
              </div>
            )}
            {pinMsg && <div style={{fontSize:12,color:pinMsg.includes("✅")?"#30d158":"#ff453a"}}>{pinMsg}</div>}
            <button onClick={handlePinChange} style={{padding:"10px",borderRadius:8,
              background:"#f5a623",border:"none",color:"#000",fontSize:13,fontWeight:700,cursor:"pointer"}}>
              {pinStep===1?"Next →":pinStep===2?"Next →":"Confirm"}
            </button>
          </div>
        )}
      </Card>

      {/* Currency */}
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
              color:currency===cur?"#000":"#555",
            }}>{cur}</button>
          ))}
        </div>
      </Card>

      {/* Theme */}
      <Card style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <div style={{fontSize:14,fontWeight:600,color:"#fff"}}>Theme</div>
          <div style={{fontSize:12,color:"#444",marginTop:3}}>Currently following your system setting</div>
        </div>
        <div style={{padding:"7px 18px",borderRadius:8,background:"#111",
          border:"1px solid #222",color:"#555",fontSize:12,fontWeight:600}}>Auto 🌗</div>
      </Card>

      {/* Notifications */}
      <Card style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <div style={{fontSize:14,fontWeight:600,color:"#fff"}}>Toast Notifications</div>
          <div style={{fontSize:12,color:"#444",marginTop:3}}>Alerts when coins pump 20%+</div>
        </div>
        <button onClick={()=>setNotificationsOn(n=>!n)} style={{
          width:52,height:28,borderRadius:14,border:"none",cursor:"pointer",
          background:notificationsOn?"#f5a623":"#222",
          position:"relative",transition:"background 0.2s",
        }}>
          <div style={{
            width:22,height:22,borderRadius:"50%",background:"#fff",
            position:"absolute",top:3,
            left:notificationsOn?27:3,
            transition:"left 0.2s",
          }}/>
        </button>
      </Card>

      {/* Lock */}
      <button onClick={onLock} style={{marginTop:8,padding:"12px",borderRadius:12,
        background:"#111",border:"1px solid #222",color:"#555",fontSize:13,cursor:"pointer"}}>
        🔒 Lock Dashboard
      </button>
    </div>
  );
}

function LiveSolBalance(){
  const { solBalance, solPrice, audRate, loading } = useLiveData();
  const bal = solBalance !== null ? solBalance : 12.48;
  const usd = bal * solPrice;
  const aud = usd * audRate;
  if (loading) return <div style={{color:"#444",fontSize:12}}>Loading...</div>;
  return (
    <>
      <div style={{fontSize:26,fontWeight:700,color:"#f5a623",letterSpacing:-0.5}}>{bal.toFixed(3)} SOL</div>
      <div style={{fontSize:14,fontWeight:600,color:"#ccc",marginTop:4}}>${fmt(usd)} USD</div>
      <div style={{fontSize:13,color:"#666",marginTop:2}}>A${fmt(aud)} AUD</div>
    </>
  );
}

// ── TICKER COMPONENT ─────────────────────────────────────────────────────────
function Ticker(){
  const ref = useRef(null);
  const dragging = useRef(false);
  const startX = useRef(0);
  const scrollLeft = useRef(0);
  const [paused, setPaused] = useState(false);

  const onMouseDown = (e) => {
    dragging.current = true;
    startX.current = e.pageX - ref.current.offsetLeft;
    scrollLeft.current = ref.current.scrollLeft;
    setPaused(true);
  };
  const onMouseUp = () => { dragging.current = false; };
  const onMouseLeave = () => { dragging.current = false; setPaused(false); };
  const onMouseMove = (e) => {
    if (!dragging.current) return;
    e.preventDefault();
    const x = e.pageX - ref.current.offsetLeft;
    ref.current.scrollLeft = scrollLeft.current - (x - startX.current) * 1.5;
  };

  return (
    <div ref={ref}
      onMouseEnter={()=>setPaused(true)}
      onMouseLeave={onMouseLeave}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onMouseMove={onMouseMove}
      style={{height:38,background:"#080808",borderBottom:"1px solid #1a1a1a",
        overflowX:"auto",display:"flex",alignItems:"center",
        position:"sticky",top:0,zIndex:9,
        cursor:dragging.current?"grabbing":"grab",
        scrollbarWidth:"none",userSelect:"none",
      }}>
      <div style={{display:"flex",gap:48,whiteSpace:"nowrap",paddingLeft:20,paddingRight:20,
        animation:paused?"none":"ticker 28s linear infinite",
      }}>
        {[...TICKER,...TICKER,...TICKER].map((coin,i)=>(
          <span key={i} style={{fontSize:11,display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
            <span style={{color:"#444"}}>{coin.s}</span>
            <span style={{color:"#888",fontFamily:"monospace"}}>${coin.p.toLocaleString()}</span>
            <span style={{color:coin.c>=0?"#30d158":"#ff453a",fontSize:10}}>
              {coin.c>=0?"▲":"▼"}{Math.abs(coin.c)}%
            </span>
          </span>
        ))}
      </div>
      <style>{`@keyframes ticker{from{transform:translateX(0)}to{transform:translateX(-33.33%)}} div::-webkit-scrollbar{display:none}`}</style>
    </div>
  );
}

// ── APP ───────────────────────────────────────────────────────────────────────
export default function App(){
  const[unlocked,setUnlocked]=useState(false);
  const[page,setPage]=useState("portfolio");
  const[toasts,setToasts]=useState([]);
  const[toastId,setToastId]=useState(0);
  const[notificationsOn,setNotificationsOn]=useState(true);
  const[currency,setCurrency]=useState("AUD");

  const addToast=useCallback(()=>{
    const coins=["BONK","WIF","POPCAT","MYRO"];
    const coin=coins[Math.floor(Math.random()*coins.length)];
    const pct=(20+Math.random()*50).toFixed(1);
    const id=toastId+1;
    setToastId(id);
    setToasts(t=>[...t,{id,symbol:coin,pct,from:"$32K",to:"$48K"}]);
    setTimeout(()=>setToasts(t=>t.filter(x=>x.id!==id)),5000);
  },[toastId]);

  // Demo toast every 15s
  useEffect(()=>{
    if(!unlocked||!notificationsOn)return;
    const t=setInterval(addToast,15000);
    return()=>clearInterval(t);
  },[unlocked,notificationsOn,addToast]);

  if(!unlocked)return <PinScreen onUnlock={()=>setUnlocked(true)}/>;

  return(
    <div style={{display:"flex",minHeight:"100vh",background:"#000",
      fontFamily:"-apple-system,'SF Pro Display',sans-serif",color:"#fff",
      fontSize:"clamp(12px, 1vw, 14px)",overflowX:"hidden"}}>

      <ToastContainer toasts={toasts} remove={id=>setToasts(t=>t.filter(x=>x.id!==id))}/>

      {/* SIDEBAR */}
      <div style={{width:"clamp(180px, 16vw, 220px)",background:"#080808",borderRight:"1px solid #1a1a1a",
        display:"flex",flexDirection:"column",position:"fixed",height:"100vh",zIndex:10}}>

        {/* Logo */}
        <div style={{padding:"24px 20px 20px",borderBottom:"1px solid #1a1a1a"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:36,height:36,borderRadius:10,
              background:"linear-gradient(135deg,#f5a623,#e8890c)",
              display:"flex",alignItems:"center",justifyContent:"center",
              fontSize:18,boxShadow:"0 0 20px #f5a62333"}}>◈</div>
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
              display:"flex",alignItems:"center",gap:12,
              padding:"10px 12px",borderRadius:10,border:"none",
              background:page===item.id?"#f5a62318":"transparent",
              color:page===item.id?"#f5a623":"#444",
              fontSize:13,fontWeight:page===item.id?600:400,
              cursor:"pointer",textAlign:"left",transition:"all 0.15s",
              borderLeft:page===item.id?"2px solid #f5a623":"2px solid transparent",
            }}
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
      <div style={{marginLeft:"clamp(180px, 16vw, 220px)",flex:1,display:"flex",flexDirection:"column",minWidth:0,overflowX:"hidden"}}>

        {/* TICKER */}
        <Ticker/>

        {/* HEADER */}
        <div style={{padding:"20px 28px 0",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div>
            <div style={{fontSize:22,fontWeight:700,color:"#fff",letterSpacing:-0.5}}>
              {NAV.find(n=>n.id===page)?.label}
            </div>
            <div style={{fontSize:12,color:"#333",marginTop:2}}>
              {new Date().toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}
            </div>
          </div>
          <button onClick={addToast} style={{
            padding:"7px 16px",borderRadius:20,background:"#f5a62318",
            border:"1px solid #f5a62333",color:"#f5a623",fontSize:11,cursor:"pointer",
          }}>🔔 Test Alert</button>
        </div>

        {/* PAGE */}
        <div style={{padding:"clamp(12px,2vw,24px)",overflowX:"hidden"}}>
          {page==="portfolio"&&<Portfolio/>}
          {page==="trades"   &&<Trades/>}
          {page==="wallets"  &&<Wallets/>}
          {page==="tax"      &&<Tax/>}
          {page==="settings" &&<Settings onLock={()=>setUnlocked(false)} notificationsOn={notificationsOn} setNotificationsOn={setNotificationsOn} currency={currency} setCurrency={setCurrency}/>}
        </div>
      </div>
    </div>
  );
}
