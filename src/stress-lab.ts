import { calculateStress } from "./stress-model.js";
type Side = "long" | "short";
type MarketRecord = { symbol?: string; name?: string; baseSymbol?: string; quoteSymbol?: string; markPrice?: number|string; mark?: number|string; price?: number|string; minQuantity?: number|string; minSize?: number|string; tickSize?: number|string; lotSize?: number|string; maintenanceMarginRate?: number|string; maintenanceMargin?: number|string; [key:string]: unknown };
type Scenario = { createdAt:string; product:"Perps Stress Lab"; version:"0.1.0"; network:{name:string;chainId:number}; source:"manual-input"|"live-order-book-midpoint"; priceReference:{source:string;timestamp:string|null;bestBid:number|null;bestAsk:number|null}; side:Side; market:string; entryPrice:number; quantity:number; leverage:number; startingMarginPercent:number; startingMarginUsd:number; shockPercent:number; stressedPrice:number; pnlUsd:number; funding:{enabled:boolean;rate8hPercent:number;periods:number;estimatedUsd:number;assumption:string}; equityUsd:number; maintenancePercent:number; maintenanceUsd:number; headroomUsd:number; thresholdStatus:"above-estimate"|"at-or-below-estimate"; assumptions:string[] };
const $ = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const fmt = (n:number, digits=2) => Number.isFinite(n) ? new Intl.NumberFormat("en-US",{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(n) : "—";
const usd = (n:number) => (n < 0 ? "−$" : "$") + fmt(Math.abs(n));
const pct = (n:number) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmt(Math.abs(n),1) + "%";
let side:Side = "long";
let markets:MarketRecord[] = [];
let latest:Scenario | null = null;
let lastRunAt:string | null = null;
let entryPriceSource: "manual-input" | "live-order-book-midpoint" = "manual-input";
let priceReference: {source:string;timestamp:string|null;bestBid:number|null;bestAsk:number|null} = {source:"manual input",timestamp:null,bestBid:null,bestAsk:null};

function num(id:string):number { return Number($<HTMLInputElement | HTMLSelectElement>(id).value); }
function val(id:string):string { return $<HTMLInputElement | HTMLSelectElement>(id).value; }
function setText(id:string,value:string){ $<HTMLElement>(id).textContent=value; }
function readInputs(){
  const entry=num("entry"), quantity=num("quantity"), marginPercent=num("starting-margin"), shock=num("shock"), maintenance=num("maintenance");
  const fundingEnabled=$<HTMLInputElement>("funding-toggle").checked, fundingRate=num("funding-rate"), periods=num("funding-periods");
  if (![entry,quantity,marginPercent,shock,maintenance].every(Number.isFinite) || entry<=0 || quantity<=0 || marginPercent<=0 || maintenance<=0 || maintenance>50) throw new Error("Enter positive prices and quantities, a positive margin, and a maintenance rate between 0 and 50%.");
  if (fundingEnabled && (!Number.isFinite(fundingRate) || !Number.isFinite(periods))) throw new Error("Check the funding inputs.");
  return {entry,quantity,marginPercent,shock,maintenance,fundingEnabled,fundingRate,periods};
}
function compute(){
  const x=readInputs();
  const market=val("market");
  const calculated=calculateStress({
    side, entryPrice:x.entry, quantity:x.quantity, startingMarginPercent:x.marginPercent,
    shockPercent:x.shock, maintenancePercent:x.maintenance,
    fundingEnabled:x.fundingEnabled, fundingRate8hPercent:x.fundingRate, fundingPeriods:x.periods
  });
  const assumptions=[
    "One isolated position only; no cross-margin offsets or other positions.",
    "Estimated equity = starting margin + directional unrealised P&L + optional simplified funding estimate.",
    "Maintenance requirement = quantity × stressed price × user-entered maintenance percentage.",
    "Fees, slippage, realised/unrealised accounting differences, liquidation execution, insurance, backstop and ADL are excluded.",
    "Funding uses the entry notional, a constant user-entered 8h rate and full 8h periods; it is not a forecast of future rates.",
    "This result is not an official dreamDEX liquidation price or liquidation status.",
    "A live reference price, when present, is a top-of-book bid/ask midpoint, not the protocol mark price."
  ];
  return {createdAt:new Date().toISOString(),product:"Perps Stress Lab",version:"0.1.0",network:{name:"Somnia Hideki Testnet",chainId:50383},source:entryPriceSource,priceReference:{...priceReference},side,market,entryPrice:x.entry,quantity:x.quantity,leverage:calculated.leverage,startingMarginPercent:x.marginPercent,startingMarginUsd:calculated.startingMarginUsd,shockPercent:x.shock,stressedPrice:calculated.stressedPrice,pnlUsd:calculated.pnlUsd,funding:{enabled:x.fundingEnabled,rate8hPercent:x.fundingRate,periods:x.periods,estimatedUsd:calculated.fundingUsd,assumption:x.fundingEnabled?"Constant rate over full 8h periods; calculated on entry notional.":"Funding excluded."},equityUsd:calculated.equityUsd,maintenancePercent:x.maintenance,maintenanceUsd:calculated.maintenanceUsd,headroomUsd:calculated.headroomUsd,thresholdStatus:calculated.thresholdStatus,assumptions} satisfies Scenario;
}
function update(){
 try{
  const s=compute(); latest=s;
  const shock=num("shock");
  setText("margin-label",fmt(s.startingMarginPercent,0)+"% of notional");
  setText("shock-label",pct(shock)); $("shock-label").style.color=shock<0?"var(--red)":shock>0?"var(--green)":"var(--text)";
  setText("shock-icon",shock<0?"↘":shock>0?"↗":"→");
  $("shock-icon").style.color=shock<0?"var(--red)":shock>0?"var(--green)":"var(--text)";
  setText("result-price",usd(s.stressedPrice));setText("price-change",pct(s.shockPercent)+" from entry");
  setText("result-pnl",usd(s.pnlUsd));$("result-pnl").className=s.pnlUsd<0?"negative":s.pnlUsd>0?"positive":"";
  setText("pnl-percent",pct(s.pnlUsd/s.startingMarginUsd*100)+" of starting margin");
  setText("result-equity",usd(s.equityUsd));$("result-equity").className=s.equityUsd<0?"negative":"";
  setText("result-headroom",usd(s.headroomUsd));$("result-headroom").className=s.headroomUsd<0?"negative":"positive";
  setText("headroom-sub",s.thresholdStatus==="above-estimate"?"Above simplified maintenance estimate":"At or below simplified maintenance estimate");
  setText("trace-price",fmt(s.entryPrice)+" × (1 "+(s.shockPercent<0?"− "+fmt(Math.abs(s.shockPercent/100),3):"+ "+fmt(s.shockPercent/100,3))+")");
  setText("trace-price-value",usd(s.stressedPrice));
  setText("trace-pnl",s.side==="long"?fmt(s.quantity)+" × ("+fmt(s.stressedPrice)+" − "+fmt(s.entryPrice)+")":fmt(s.quantity)+" × ("+fmt(s.entryPrice)+" − "+fmt(s.stressedPrice)+")");
  setText("trace-pnl-value",usd(s.pnlUsd));
  setText("trace-equity",fmt(s.startingMarginUsd)+" + ("+fmt(s.pnlUsd)+(s.funding.enabled?" + funding "+fmt(s.funding.estimatedUsd):"")+")");
  setText("trace-equity-value",usd(s.equityUsd));
  setText("trace-maint",fmt(s.quantity)+" × "+fmt(s.stressedPrice)+" × "+fmt(s.maintenancePercent,2)+"%");
  setText("trace-maint-value",usd(s.maintenanceUsd));
  setText("bar-equity-label",usd(s.equityUsd));setText("bar-maint-label",usd(s.maintenanceUsd));
  const max=Math.max(Math.abs(s.equityUsd),Math.abs(s.maintenanceUsd),1);
  $("equity-bar").style.width=Math.max(0,Math.min(100,Math.max(0,s.equityUsd)/max*100))+"%";
  $("maintenance-bar").style.width=Math.max(0,Math.min(100,s.maintenanceUsd/max*100))+"%";
  const threshold=$("threshold-note");threshold.classList.toggle("warning",s.thresholdStatus!=="above-estimate");
  threshold.querySelector("strong")!.textContent=s.thresholdStatus==="above-estimate"?"Above estimated maintenance":"At or below estimated maintenance";
  threshold.querySelector("p")!.textContent=s.thresholdStatus==="above-estimate"?"Positive headroom in this simplified model. This is not an official liquidation status.":"This model's headroom is non-positive. It does not prove that dreamDEX would liquidate this position.";
  setText("scenario-status",lastRunAt?"SCENARIO UPDATED":"READY TO RUN");
  setText("report-meta","Local estimate · "+new Date(s.createdAt).toLocaleTimeString());
  setText("funding-note",s.funding.enabled?"Assumes "+fmt(s.funding.rate8hPercent,3)+"% per 8h period for "+s.funding.periods+" full periods, applied to entry notional.":"Funding is off. Turn it on to model an explicit constant-rate assumption.");
  document.querySelectorAll<HTMLButtonElement>("[data-shock]").forEach(b=>b.classList.toggle("selected",Number(b.dataset.shock)===shock));
 }catch(e){setText("scenario-status","CHECK INPUTS");setText("export-feedback",e instanceof Error?e.message:"Please check your inputs.");}
}
function markRun(){lastRunAt=new Date().toISOString();update();setText("scenario-status","SCENARIO CALCULATED");$("results").scrollIntoView({behavior:"smooth",block:"start"});}
function download(){
 try{const s=compute();latest=s;const report={...s,generatedAt:new Date().toISOString(),verification:{onChain:false,liveAccountDataUsed:false,transactionHash:null},disclaimer:"This is a local scenario estimate, not on-chain evidence, financial advice, an official liquidation price, or a prediction of protocol liquidation behavior."};const blob=new Blob([JSON.stringify(report,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="perps-stress-lab-"+new Date().toISOString().replace(/[:.]/g,"-")+".json";a.click();URL.revokeObjectURL(url);setText("export-feedback","Scenario JSON exported. It is labelled as local, non-on-chain evidence.");}catch(e){setText("export-feedback",e instanceof Error?e.message:"Unable to export this scenario.");}
}
async function copySummary(){
 try{const s=compute();const summary=["PERPS STRESS LAB — SCENARIO SUMMARY","Network: Somnia Hideki testnet (50383)","Source: "+s.source+"; not on-chain evidence","Market: "+s.market,"Direction: "+s.side.toUpperCase(),"Entry: "+usd(s.entryPrice),"Quantity: "+fmt(s.quantity,8),"Shock: "+pct(s.shockPercent),"Stressed price: "+usd(s.stressedPrice),"Estimated P&L: "+usd(s.pnlUsd),"Estimated equity: "+usd(s.equityUsd),"Maintenance estimate: "+usd(s.maintenanceUsd),"Headroom: "+usd(s.headroomUsd),"Funding estimate: "+usd(s.funding.estimatedUsd),"","This simplified isolated-position estimate excludes fees, other positions, full protocol accounting and liquidation execution."].join("\n");await navigator.clipboard.writeText(summary);setText("export-feedback","Readable scenario summary copied.");}catch{setText("export-feedback","Clipboard access failed. Use Export scenario JSON instead.");}
}
async function loadMarketPrice(symbol:string){
 try{
  const response=await fetch("/api/market-price?symbol="+encodeURIComponent(symbol),{headers:{accept:"application/json"},cache:"no-store"});
  if(!response.ok)throw new Error("Order-book endpoint returned HTTP "+response.status);
  const payload=await response.json() as {ok?:boolean;referencePrice?:number;bestBid?:number;bestAsk?:number;priceSource?:string;timestamp?:string};
  if(!payload.ok||!Number.isFinite(payload.referencePrice)||Number(payload.referencePrice)<=0)throw new Error("No valid reference price was returned.");
  if(val("market")!==symbol)return;
  $<HTMLInputElement>("entry").value=String(payload.referencePrice);
  entryPriceSource="live-order-book-midpoint";
  priceReference={source:payload.priceSource??"Top-of-book midpoint",timestamp:payload.timestamp??null,bestBid:Number(payload.bestBid),bestAsk:Number(payload.bestAsk)};
  setText("market-hint","Live book midpoint "+usd(Number(payload.referencePrice))+" · not a mark price. Entry remains editable.");
  setText("method-data","Read-only Hideki order book returned a two-sided quote for "+symbol+". The entry field is prefilled with its bid/ask midpoint; calculations do not use live account margin.");
  update();
 }catch(e){
  if(val("market")!==symbol)return;
  entryPriceSource="manual-input";
  priceReference={source:"manual input; live book midpoint unavailable",timestamp:null,bestBid:null,bestAsk:null};
  setText("market-hint","Live reference price unavailable; enter an entry price manually.");
  setText("method-data","Could not load a live order-book midpoint: "+(e instanceof Error?e.message:"unknown error")+". The manual scenario remains available.");
  update();
 }
}
async function loadMarkets(){
 const status=$("data-status");status.innerHTML='<span class="status-dot muted"></span> Checking market data…';
 try{
  const response=await fetch("/api/markets",{headers:{accept:"application/json"},cache:"no-store"});
  if(!response.ok)throw new Error("Market endpoint returned HTTP "+response.status);
  const payload:unknown=await response.json();
  const root=payload as {markets?:unknown;data?:unknown;result?:unknown};
  const raw=Array.isArray(payload)?payload:[root.markets,root.data,root.result].find(Array.isArray);
  if(!Array.isArray(raw)||raw.length===0)throw new Error("No market rows returned by the API.");
  markets=raw.filter((m):m is MarketRecord=>!!m&&typeof m==="object") as MarketRecord[];
  const select=$<HTMLSelectElement>("market");const previous=select.value;
  select.replaceChildren();
  for(const m of markets){const symbol=String(m.symbol??m.name??m.baseSymbol??"");if(!symbol)continue;const opt=document.createElement("option");opt.value=symbol;opt.textContent=symbol;select.append(opt);}
  if(!select.options.length)throw new Error("The response did not contain readable market symbols.");
  if([...select.options].some(o=>o.value===previous))select.value=previous;
  status.innerHTML='<span class="status-dot"></span> Market list loaded';
  setText("method-data","Loaded "+markets.length+" live Hideki market definitions. Fetching a read-only order-book midpoint for the selected market; no account margin or liquidation state is queried.");
  await loadMarketPrice(select.value);
 }catch(e){
  status.innerHTML='<span class="status-dot muted"></span> Live data unavailable';
  setText("market-hint","Live market metadata unavailable; this remains a manual hypothetical scenario.");
  setText("method-data","Read-only market-data request failed: "+(e instanceof Error?e.message:"unknown error")+". Manual scenarios remain available; no live-data claim is made.");
 }
 update();
}
document.querySelectorAll<HTMLButtonElement>("[data-side]").forEach(b=>b.addEventListener("click",()=>{side=b.dataset.side as Side;document.querySelectorAll("[data-side]").forEach(x=>x.classList.toggle("active",x===b));update();}));
document.querySelectorAll<HTMLButtonElement>("[data-shock]").forEach(b=>b.addEventListener("click",()=>{ $<HTMLInputElement>("shock").value=b.dataset.shock!;update();}));
["entry","quantity","maintenance","starting-margin","shock","funding-rate","funding-periods","market"].forEach(id=>$<HTMLInputElement | HTMLSelectElement>(id).addEventListener("input",()=>{if(id==="starting-margin"){const percent=num("starting-margin");const leverage=$<HTMLSelectElement>("leverage");const choices=[2,5,10,20];leverage.value=String(choices.reduce((best,current)=>Math.abs(100/current-percent)<Math.abs(100/best-percent)?current:best,choices[0]));}if(id==="entry"){entryPriceSource="manual-input";priceReference={source:"manual input",timestamp:null,bestBid:null,bestAsk:null};}update();if(id==="market")void loadMarketPrice(val("market"));}));
$("funding-toggle").addEventListener("change",()=>{const enabled=$<HTMLInputElement>("funding-toggle").checked; $("funding-fields").setAttribute("aria-disabled",String(!enabled));$<HTMLInputElement>("funding-rate").disabled=!enabled;$<HTMLSelectElement>("funding-periods").disabled=!enabled;update();});
$<HTMLSelectElement>("leverage").addEventListener("change",()=>{$<HTMLInputElement>("starting-margin").value=String(100/num("leverage"));update();});
$("run-scenario").addEventListener("click",markRun);
$("export-json").addEventListener("click",download);
$("copy-summary").addEventListener("click",()=>void copySummary());
$("refresh-data").addEventListener("click",()=>void loadMarkets());
loadMarkets();
update();
